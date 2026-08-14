/**
 * services/keitaro.js
 * ─────────────────────────────────────────────────────────────
 * Server-side sale postback to Keitaro.
 *
 * Contract with the rest of the app:
 *   - it is an analytics side effect and NEVER throws;
 *   - a failure here must leave the Stripe payment and the customer's access
 *     completely untouched;
 *   - it sends the five agreed fields and nothing else — no email, no names,
 *     no quiz data, no Stripe secrets.
 *
 * Idempotency lives in db.claimPostback(), not here: the caller claims the
 * payment id first and only then invokes sendSalePostback().
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/** Click ids are opaque tokens — same rule as the browser-side capture. */
const SUBID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Per-attempt network timeout. */
const REQUEST_TIMEOUT_MS = 5000;

/** Attempt, then two retries. */
const MAX_ATTEMPTS = 3;

/** Backoff before retry 1 and retry 2. */
const RETRY_DELAYS_MS = [1000, 4000];

/**
 * Currencies Stripe holds without a minor unit — their `amount` is already the
 * real figure and must not be divided.
 * https://docs.stripe.com/currencies#zero-decimal
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/**
 * Treat the click id as untrusted input: accept only the safe shape, reject
 * everything else outright rather than trying to repair it.
 * @param {*} value
 * @returns {string} '' when the value is not a usable click id
 */
function sanitizeSubid(value) {
  if (typeof value !== 'string') { return ''; }
  const trimmed = value.trim();
  return SUBID_RE.test(trimmed) ? trimmed : '';
}

/**
 * Convert a Stripe amount in minor units into the decimal figure Keitaro wants.
 *   2999 + 'eur' → '29.99'
 *   500  + 'jpy' → '500'
 * @param {number} amountMinor
 * @param {string} currency  Stripe currency code (lowercase)
 * @returns {string}
 */
function formatPayout(amountMinor, currency) {
  const amount = Number(amountMinor);
  if (!Number.isFinite(amount)) { return '0'; }

  if (ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toLowerCase())) {
    return String(Math.round(amount));
  }
  return (amount / 100).toFixed(2);
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST the sale to Keitaro, retrying on network errors and 5xx.
 *
 * Never throws. Returns what happened so the caller can record it.
 *
 * @param {object} params
 * @param {string} params.subid       Keitaro click id (validated here again)
 * @param {string} params.paymentId   Stripe PaymentIntent id → tid
 * @param {number} params.amountMinor confirmed amount in minor units
 * @param {string} params.currency    Stripe currency code
 * @returns {Promise<{ok: boolean, status: string, httpStatus: number|null, attempts: number}>}
 */
async function sendSalePostback(params) {
  const url = process.env.KEITARO_POSTBACK_URL;
  if (!url) {
    console.warn('[keitaro] KEITARO_POSTBACK_URL is not configured — skipping postback.');
    return { ok: false, status: 'not_configured', httpStatus: null, attempts: 0 };
  }

  const subid = sanitizeSubid(params && params.subid);
  if (!subid) {
    console.warn('[keitaro] No valid subid — skipping postback.');
    return { ok: false, status: 'invalid_subid', httpStatus: null, attempts: 0 };
  }

  const paymentId = String((params && params.paymentId) || '').trim();
  if (!paymentId) {
    console.warn('[keitaro] No payment id — skipping postback.');
    return { ok: false, status: 'missing_payment_id', httpStatus: null, attempts: 0 };
  }

  // URLSearchParams percent-encodes every value, so nothing can break out of
  // the query string or the form body regardless of what reached us.
  const body = new URLSearchParams({
    subid,
    status:   'sale',
    tid:      paymentId,
    payout:   formatPayout(params.amountMinor, params.currency),
    currency: String(params.currency || 'eur').toUpperCase(),
  }).toString();

  // Keitaro documents the S2S postback as a GET with the parameters in the URL.
  // We were sending a form POST, which the tracker answered with HTTP 500 — the
  // sale was confirmed by Stripe but never reached the partner. GET is the
  // primary call now; POST stays as a fallback for a non-standard endpoint.
  const target = url + (url.indexOf('?') === -1 ? '?' : '&') + body;

  /**
   * One delivery attempt. Never throws — the caller decides about retries.
   * @param {'GET'|'POST'} method
   * @returns {Promise<{res: object|null, reason: string|null}>}
   */
  async function deliver(method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(method === 'GET' ? target : url, {
        method,
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: method === 'GET' ? undefined : body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { res, reason: null };
    } catch (err) {
      clearTimeout(timer);
      const reason = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'unknown';
      return { res: null, reason };
    }
  }

  let lastStatus = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let { res, reason } = await deliver('GET');

      // An endpoint that only accepts a form POST says so with 404/405. Trying
      // the other shape once costs one request and covers both conventions.
      if (res && (res.status === 404 || res.status === 405)) {
        const fallback = await deliver('POST');
        if (fallback.res) { res = fallback.res; reason = null; }
      }

      if (!res) { throw new Error(reason || 'unknown'); }
      lastStatus = res.status;

      if (res.ok) {
        console.log('[keitaro] Sale postback accepted for payment', paymentId,
                    '— HTTP', res.status, '(attempt', attempt + ')');
        return { ok: true, status: 'sent', httpStatus: res.status, attempts: attempt };
      }

      // 4xx means Keitaro rejected the request itself — retrying will not help.
      if (res.status < 500) {
        console.error('[keitaro] Postback rejected for payment', paymentId,
                      '— HTTP', res.status, '(not retrying)');
        return { ok: false, status: 'rejected', httpStatus: res.status, attempts: attempt };
      }

      console.warn('[keitaro] Postback failed for payment', paymentId,
                   '— HTTP', res.status, '(attempt', attempt + '/' + MAX_ATTEMPTS + ')');
    } catch (err) {
      // deliver() owns its own timer and never throws; anything arriving here is
      // the network failure it reported, re-thrown above.
      console.warn('[keitaro] Postback error for payment', paymentId,
                   '—', (err && err.message) || 'unknown',
                   '(attempt', attempt + '/' + MAX_ATTEMPTS + ')');
    }

    if (attempt < MAX_ATTEMPTS) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }
  }

  console.error('[keitaro] Giving up on postback for payment', paymentId,
                'after', MAX_ATTEMPTS, 'attempts.');
  return { ok: false, status: 'failed', httpStatus: lastStatus, attempts: MAX_ATTEMPTS };
}

module.exports = {
  sendSalePostback,
  sanitizeSubid,
  formatPayout,
};
