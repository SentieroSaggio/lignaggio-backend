/**
 * services/smtp.js
 * ─────────────────────────────────────────────────────────────
 * Reading an SMTP failure: is it worth trying again, or never?
 *
 * The abandoned-cart address is typed by hand by the customer, so "gmail.con"
 * and "agmail.com" arrive regularly. The mail server answers 5xx, the send
 * throws, the row is never marked as handled - and the five-minute sweep picks
 * it up again, forever. Hundreds of rejected deliveries to a domain that does
 * not exist is how a sender earns a reputation problem, and once that happens
 * the consultation emails stop arriving too.
 *
 * Kept as a pure function in its own module so it can be tested without an
 * SMTP server, and so the retry policy lives in one readable place.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * A 5xx reply is a final refusal: no mailbox, no domain, no such user. A 4xx is
 * a "try later" (greylisting, rate limit, temporary outage) and must stay
 * retryable, or a five-minute blip would silently drop a customer's email.
 *
 * @param {Error|null|undefined} err  the error nodemailer threw
 * @returns {boolean} true when retrying cannot succeed
 */
function isPermanentSmtpFailure(err) {
  if (!err) { return false; }

  const code = Number(err.responseCode);
  if (Number.isFinite(code) && code >= 500 && code < 600) { return true; }
  if (Number.isFinite(code) && code >= 400 && code < 500) { return false; }

  // A wholly rejected envelope: every recipient was refused, which for a
  // single-recipient message means the address itself is unusable.
  if (err.code === 'EENVELOPE') { return true; }

  // Some transports only carry the reply inside the message text.
  const message = String(err.message || '');
  if (/\b4\d\d[ -]/.test(message)) { return false; }
  return /\b5\d\d[ -]/.test(message);
}

module.exports = { isPermanentSmtpFailure };
