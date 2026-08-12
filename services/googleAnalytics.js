/**
 * services/googleAnalytics.js
 * ─────────────────────────────────────────────────────────────
 * Read-only GA4 reporting for the admin panel (Google Analytics Data API v1).
 *
 * Contract with the rest of the app:
 *   - it is a reporting side channel and NEVER throws: a GA outage, a revoked
 *     key or a malformed env var must degrade to an error field in the JSON,
 *     never to a 500 that takes the admin panel down;
 *   - credentials are read from the environment and passed to the client
 *     in-memory, because Render has no writable place to keep a key file and
 *     GOOGLE_APPLICATION_CREDENTIALS expects a path on disk;
 *   - nothing derived from the credentials is ever logged. Only the shape of a
 *     failure is reported, never its key material.
 *
 * Every report is filtered to contentGroup = 'quiz-compatibilita' because the
 * same GA4 property also collects the main site: without the filter the numbers
 * would silently mix quiz traffic with everything else.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

/** Content group tagged on every hit fired by the quiz. */
const QUIZ_CONTENT_GROUP = 'quiz-compatibilita';

/** Give up rather than let the admin panel hang on a slow GA response. */
const REQUEST_TIMEOUT_MS = 20000;

/** Reporting window bounds, mirroring the other admin stats endpoints. */
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const DEFAULT_DAYS = 30;

/**
 * Custom events the quiz sends. Listed explicitly so a count of 0 is reported
 * as 0 — GA omits rows with no data, and a missing key would read as "unknown"
 * in the panel instead of "nobody did this".
 */
const QUIZ_EVENTS = [
  'quiz_start',
  'quiz_question',
  'quiz_complete',
  'partner_data_submit',
  'email_submit',
  'email_skip',
  'offer_cta_click',
  'begin_checkout',
  'purchase',
  'generate_lead',
  'returning_visitor',
];

/** Funnel order, from first touch to paid. Labels are Italian, like the panel. */
const FUNNEL_STAGES = [
  { event: 'quiz_start',          name: 'Quiz iniziato' },
  { event: 'quiz_complete',       name: 'Quiz completato' },
  { event: 'partner_data_submit', name: 'Dati partner inviati' },
  { event: 'email_submit',        name: 'Email raccolta' },
  { event: 'offer_cta_click',     name: 'CTA offerta cliccata' },
  { event: 'begin_checkout',      name: 'Checkout avviato' },
  { event: 'purchase',            name: 'Acquisto' },
];

/** Built once and reused: each client opens its own gRPC channel. */
let _client = null;
let _clientFailed = false;

/**
 * Decode the service-account JSON handed to us through the environment.
 *
 * Two encodings are accepted because pasting a multi-line private key into a
 * hosting dashboard is where this usually breaks: raw JSON, or the same JSON
 * base64-encoded (safe to paste anywhere).
 *
 * @returns {{client_email: string, private_key: string}|null} null when absent or unusable
 */
function parseCredentials() {
  const raw = String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();
  if (!raw) { return null; }

  let text = raw;
  if (text[0] !== '{') {
    try {
      text = Buffer.from(text, 'base64').toString('utf8').trim();
    } catch (_) {
      return null;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    // Deliberately no detail in the log: the message could echo key material.
    return null;
  }

  if (!parsed || typeof parsed !== 'object') { return null; }
  if (!parsed.client_email || !parsed.private_key) { return null; }

  return {
    client_email: String(parsed.client_email),
    // Dashboards that store the key on one line turn real newlines into the two
    // characters \ and n; PEM parsing fails on those, so restore them.
    private_key: String(parsed.private_key).replace(/\\n/g, '\n'),
  };
}

/** @returns {string} numeric GA4 property id, or '' when not configured */
function propertyId() {
  const id = String(process.env.GA_PROPERTY_ID || '').trim();
  // The measurement id (G-XXXXXXX) is a different identifier and the Data API
  // rejects it, so accept digits only rather than forwarding a doomed request.
  return /^\d+$/.test(id) ? id : '';
}

/**
 * Whether GA reporting can run at all.
 * @returns {boolean}
 */
function isConfigured() {
  return Boolean(propertyId()) && Boolean(parseCredentials());
}

/**
 * Lazily build the Data API client.
 *
 * The require is inside the function so a missing or broken dependency can only
 * fail this one endpoint — it must never stop the server from booting.
 *
 * @returns {object|null}
 */
function getClient() {
  if (_client) { return _client; }
  if (_clientFailed) { return null; }

  const credentials = parseCredentials();
  if (!credentials) { _clientFailed = true; return null; }

  try {
    const { BetaAnalyticsDataClient } = require('@google-analytics/data');
    _client = new BetaAnalyticsDataClient({ credentials });
    return _client;
  } catch (err) {
    _clientFailed = true;
    console.error('[ga] Could not initialise the Data API client:', err && err.message);
    return null;
  }
}

/** Filter every report down to quiz traffic only. */
function quizFilter() {
  return {
    filter: {
      fieldName: 'contentGroup',
      stringFilter: { matchType: 'EXACT', value: QUIZ_CONTENT_GROUP },
    },
  };
}

/** @param {*} value @returns {number} */
function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map a runReport response onto { metricName: value } for a report with no
 * dimensions (a single totals row).
 * @param {object} response
 * @param {string[]} metricNames
 */
function readTotalsRow(response, metricNames) {
  const totals = {};
  const row = response && response.rows && response.rows[0];
  metricNames.forEach(function (name, i) {
    totals[name] = row ? toNumber(row.metricValues[i].value) : 0;
  });
  return totals;
}

/**
 * Build the funnel, expressing each stage's loss against the previous one so
 * the panel can show where people leave without doing arithmetic itself.
 * @param {Record<string, number>} events
 */
function buildFunnel(events) {
  let previous = null;
  return FUNNEL_STAGES.map(function (stage) {
    const value = events[stage.event] || 0;
    const dropoff = previous && previous > 0 ? Math.round((1 - value / previous) * 100) : 0;
    previous = value;
    return { event: stage.event, name: stage.name, value, dropoff };
  });
}

/**
 * Quiz report for the last N days, always scoped to the quiz content group.
 *
 * Never throws.
 *
 * @param {{days?: number|string}} [options]
 * @returns {Promise<object>} report, or { configured: false } / { error } on failure
 */
async function getQuizReport(options) {
  const requested = parseInt((options && options.days), 10);
  const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Number.isFinite(requested) ? requested : DEFAULT_DAYS));

  const property = propertyId();
  if (!property) {
    return { configured: false, reason: 'GA_PROPERTY_ID is missing or is not a numeric property id' };
  }
  if (!parseCredentials()) {
    return { configured: false, reason: 'GOOGLE_APPLICATION_CREDENTIALS_JSON is missing or is not valid service-account JSON' };
  }

  const client = getClient();
  if (!client) {
    return { configured: false, reason: 'Google Analytics client could not be initialised' };
  }

  const dateRanges = [{ startDate: days + 'daysAgo', endDate: 'today' }];
  const totalMetrics = ['sessions', 'totalUsers', 'activeUsers', 'screenPageViews'];

  try {
    // Two reports rather than one: mixing eventName into the totals request
    // would multiply sessions across event rows and inflate every figure.
    const [totalsResponse, eventsResponse] = await Promise.all([
      client.runReport({
        property: 'properties/' + property,
        dateRanges,
        metrics: totalMetrics.map(function (name) { return { name }; }),
        dimensionFilter: quizFilter(),
      }, { timeout: REQUEST_TIMEOUT_MS }),
      client.runReport({
        property: 'properties/' + property,
        dateRanges,
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: quizFilter(),
        limit: 250,
      }, { timeout: REQUEST_TIMEOUT_MS }),
    ]).then(function (results) { return [results[0][0], results[1][0]]; });

    const totals = readTotalsRow(totalsResponse, totalMetrics);

    // Start at zero for every known event so the panel can tell "none" from
    // "not tracked"; anything else GA returns is kept under `otherEvents`.
    const events = {};
    QUIZ_EVENTS.forEach(function (name) { events[name] = 0; });
    const otherEvents = {};

    (eventsResponse.rows || []).forEach(function (row) {
      const name  = row.dimensionValues[0].value;
      const count = toNumber(row.metricValues[0].value);
      if (Object.prototype.hasOwnProperty.call(events, name)) {
        events[name] = count;
      } else {
        otherEvents[name] = count;
      }
    });

    return {
      configured: true,
      days,
      property_id: property,
      content_group: QUIZ_CONTENT_GROUP,
      range: { startDate: dateRanges[0].startDate, endDate: dateRanges[0].endDate },
      sessions: totals.sessions,
      users: totals.totalUsers,
      activeUsers: totals.activeUsers,
      pageViews: totals.screenPageViews,
      events,
      otherEvents,
      funnel: buildFunnel(events),
    };
  } catch (err) {
    // GA errors can quote the request, so only the message is logged — never the
    // credentials object, and never the parsed key.
    const message = (err && err.message) || 'unknown error';
    console.error('[ga] runReport failed:', message);
    return { configured: true, error: message, days };
  }
}

module.exports = {
  isConfigured,
  getQuizReport,
  QUIZ_CONTENT_GROUP,
  QUIZ_EVENTS,
};
