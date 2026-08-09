'use strict';

/**
 * db.js — SQLite persistence layer (better-sqlite3)
 * Tables: sessions, consultations
 * Database file: backend/database/quiz.db
 */

const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const Database = require('better-sqlite3');

// ── Ensure database directory exists ────────────────────────────────────────
// On Render: set DB_PATH env var to a path on the persistent disk, e.g.:
//   DB_PATH=/var/data/quiz.db
// (Add a Render Disk mounted at /var/data to persist data across restarts)
const DB_DIR  = process.env.DB_PATH
  ? require('path').dirname(process.env.DB_PATH)
  : path.join(__dirname, 'database');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'quiz.db');

// Open (or create) the database
const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    partner1_name     TEXT,
    partner1_gender   TEXT,
    partner1_birth    TEXT,
    partner2_name     TEXT,
    partner2_gender   TEXT,
    partner2_birth    TEXT,
    compatibility_json TEXT,
    preview_json      TEXT,
    payment_status    TEXT DEFAULT 'pending',
    access_token      TEXT,
    created_at        INTEGER
  );

  CREATE TABLE IF NOT EXISTS consultations (
    id                TEXT PRIMARY KEY,
    calculation_id    TEXT,
    consultation_json TEXT,
    image_url         TEXT,
    pdf_url           TEXT,
    created_at        INTEGER
  );

  CREATE TABLE IF NOT EXISTS session_emails (
    calculation_id    TEXT PRIMARY KEY,
    email             TEXT NOT NULL,
    thank_you_sent    INTEGER DEFAULT 0,
    abandoned_sent    INTEGER DEFAULT 0,
    created_at        INTEGER
  );
`);

// ── Migrations for existing databases ────────────────────────────────────────
try { db.exec('ALTER TABLE session_emails ADD COLUMN thank_you_sent INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE session_emails ADD COLUMN abandoned_sent INTEGER DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN selected_price TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN bonus_code TEXT'); } catch (_) {}
// Quiz answers — used by buildConsultationPrompt to personalise the reading.
try { db.exec('ALTER TABLE sessions ADD COLUMN quiz_context_json TEXT'); } catch (_) {}
// Keitaro click id captured from ?subid= on the landing page.
try { db.exec('ALTER TABLE sessions ADD COLUMN keitaro_subid TEXT'); } catch (_) {}
// How many times the reconciler has tried to generate this consultation, so a
// permanently failing order cannot retry forever and burn OpenAI credit.
try { db.exec('ALTER TABLE sessions ADD COLUMN consultation_attempts INTEGER DEFAULT 0'); } catch (_) {}

/**
 * One row per Stripe payment for which a Keitaro sale postback was attempted.
 *
 * payment_id is the PRIMARY KEY, which is what makes the postback idempotent:
 * Stripe retries webhooks, and INSERT OR IGNORE lets exactly one caller win the
 * claim. better-sqlite3 is synchronous, so the claim is atomic.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS keitaro_postbacks (
    payment_id      TEXT PRIMARY KEY,
    subid           TEXT NOT NULL,
    postback_status TEXT DEFAULT 'pending',
    http_status     INTEGER,
    attempts        INTEGER DEFAULT 0,
    sent_at         INTEGER,
    created_at      INTEGER
  );
`);
// Normalize timestamps stored as Unix seconds → milliseconds
// Any value < 10 billion is seconds-based (covers all dates up to ~2286 in seconds)
try {
  db.exec('UPDATE sessions       SET created_at = created_at * 1000 WHERE created_at IS NOT NULL AND created_at < 10000000000');
  db.exec('UPDATE session_emails SET created_at = created_at * 1000 WHERE created_at IS NOT NULL AND created_at < 10000000000');
  db.exec('UPDATE consultations  SET created_at = created_at * 1000 WHERE created_at IS NOT NULL AND created_at < 10000000000');
} catch (e) { console.warn('[db] timestamp normalize error:', e.message); }


console.log('[db] SQLite database ready at', DB_PATH);

// ── Prepared statements ──────────────────────────────────────────────────────
const stmtInsertSession = db.prepare(`
  INSERT OR IGNORE INTO sessions
    (id, partner1_name, partner1_gender, partner1_birth,
     partner2_name, partner2_gender, partner2_birth,
     compatibility_json, quiz_context_json, preview_json,
     payment_status, access_token, created_at)
  VALUES
    (@id, @partner1_name, @partner1_gender, @partner1_birth,
     @partner2_name, @partner2_gender, @partner2_birth,
     @compatibility_json, @quiz_context_json, @preview_json,
     @payment_status, @access_token, @created_at)
`);

/**
 * Fill in the quiz answers separately.
 * insertSession uses INSERT OR IGNORE, so when the row already exists (the
 * Stripe webhook can land before the preview request commits) the quiz answers
 * from the INSERT are dropped. This backfills them without touching a row that
 * already has them.
 */
const stmtUpdateQuizContext = db.prepare(`
  UPDATE sessions SET quiz_context_json = @quiz_context_json
   WHERE id = @id AND (quiz_context_json IS NULL OR quiz_context_json = '')
`);

const stmtUpdatePreview = db.prepare(`
  UPDATE sessions SET preview_json = @preview_json WHERE id = @id
`);

const stmtMarkPaid = db.prepare(`
  UPDATE sessions SET payment_status = 'paid', access_token = @access_token,
    selected_price = COALESCE(@selected_price, selected_price) WHERE id = @id
`);

const stmtGetSession = db.prepare(`
  SELECT * FROM sessions WHERE id = ?
`);

const stmtInsertConsultation = db.prepare(`
  INSERT OR REPLACE INTO consultations
    (id, calculation_id, consultation_json, image_url, pdf_url, created_at)
  VALUES
    (@id, @calculation_id, @consultation_json, @image_url, @pdf_url, @created_at)
`);

const stmtGetConsultation = db.prepare(`
  SELECT * FROM consultations WHERE calculation_id = ?
`);

const stmtSaveSessionEmail = db.prepare(`
  INSERT OR IGNORE INTO session_emails (calculation_id, email, created_at)
  VALUES (@calculation_id, @email, @created_at)
`);

const stmtGetSessionEmail = db.prepare(`
  SELECT * FROM session_emails WHERE calculation_id = ?
`);

// ── Keitaro attribution ──────────────────────────────────────────────────────

/** Store the click id, but never overwrite one that is already recorded. */
const stmtSaveSubid = db.prepare(`
  UPDATE sessions SET keitaro_subid = @subid
   WHERE id = @id AND (keitaro_subid IS NULL OR keitaro_subid = '')
`);

const stmtGetSubid = db.prepare(`
  SELECT keitaro_subid FROM sessions WHERE id = ?
`);

// ── Delivery reconciliation ──────────────────────────────────────────────────

/**
 * Paid orders that still have no consultation.
 *
 * This is the "customer paid but got nothing" query: if a row shows up here the
 * reading was never generated, whatever the reason — missing webhook, an OpenAI
 * failure, a restart mid-generation.
 */
const stmtOrdersMissingConsultation = db.prepare(`
  SELECT s.id, s.created_at, COALESCE(s.consultation_attempts, 0) AS attempts
    FROM sessions s
    LEFT JOIN consultations c ON c.calculation_id = s.id
   WHERE s.payment_status = 'paid'
     AND c.id IS NULL
     AND s.created_at > @cutoff
     AND COALESCE(s.consultation_attempts, 0) < @maxAttempts
   ORDER BY s.created_at ASC
   LIMIT @limit
`);

const stmtBumpConsultationAttempts = db.prepare(`
  UPDATE sessions
     SET consultation_attempts = COALESCE(consultation_attempts, 0) + 1
   WHERE id = ?
`);

/** Atomic claim: only the first caller for a payment_id inserts a row. */
const stmtClaimPostback = db.prepare(`
  INSERT OR IGNORE INTO keitaro_postbacks
    (payment_id, subid, postback_status, attempts, created_at)
  VALUES (@payment_id, @subid, 'pending', 0, @created_at)
`);

const stmtFinishPostback = db.prepare(`
  UPDATE keitaro_postbacks
     SET postback_status = @postback_status,
         http_status     = @http_status,
         attempts        = @attempts,
         sent_at         = @sent_at
   WHERE payment_id = @payment_id
`);

const stmtGetPostback = db.prepare(`
  SELECT * FROM keitaro_postbacks WHERE payment_id = ?
`);

const stmtMarkThankYouSent = db.prepare(`
  UPDATE session_emails SET thank_you_sent = 1 WHERE calculation_id = ?
`);

const stmtMarkAbandonedSent = db.prepare(`
  UPDATE session_emails SET abandoned_sent = 1 WHERE calculation_id = ?
`);

const stmtSaveBonusCode = db.prepare(`
  UPDATE sessions SET bonus_code = @bonus_code WHERE id = @id
`);

const stmtGetBonusCode = db.prepare(`
  SELECT bonus_code FROM sessions WHERE id = ?
`);

const stmtGetAbandonedCandidates = db.prepare(`
  SELECT se.calculation_id, se.email, s.partner1_name, s.partner2_name
  FROM session_emails se
  LEFT JOIN sessions s ON s.id = se.calculation_id
  WHERE se.abandoned_sent = 0
    AND (s.payment_status IS NULL OR s.payment_status != 'paid')
    AND se.created_at < @cutoff
`);

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Insert a new session row (IGNORE if already exists — idempotent).
 * @param {string} id  - calculation_id
 * @param {object} partner1 - { name, gender, birthDate }
 * @param {object} partner2 - { name, gender, birthDate }
 * @param {object} compatibility - full compatibility object
 */
function insertSession(id, partner1, partner2, compatibility, quizContext) {
  const quizJson = (Array.isArray(quizContext) && quizContext.length)
    ? JSON.stringify(quizContext)
    : null;

  stmtInsertSession.run({
    id,
    partner1_name:     (partner1 && partner1.name)      || null,
    partner1_gender:   (partner1 && partner1.gender)    || null,
    partner1_birth:    (partner1 && partner1.birthDate) || null,
    partner2_name:     (partner2 && partner2.name)      || null,
    partner2_gender:   (partner2 && partner2.gender)    || null,
    partner2_birth:    (partner2 && partner2.birthDate) || null,
    compatibility_json: compatibility ? JSON.stringify(compatibility) : null,
    quiz_context_json:  quizJson,
    preview_json:      null,
    payment_status:    'pending',
    access_token:      null,
    created_at:        Date.now(),
  });

  // Covers the INSERT OR IGNORE case where the row already existed.
  if (quizJson) {
    stmtUpdateQuizContext.run({ id, quiz_context_json: quizJson });
  }
}

/**
 * Save or update the preview JSON for a session.
 */
function updateSessionPreview(calculationId, previewObj) {
  stmtUpdatePreview.run({
    id:           calculationId,
    preview_json: JSON.stringify(previewObj),
  });
}

/**
 * Mark a session as paid and store the access token and selected price.
 */
function markSessionPaid(calculationId, accessToken, selectedPrice) {
  stmtMarkPaid.run({ id: calculationId, access_token: accessToken, selected_price: selectedPrice || null });
}

/**
 * Retrieve a session row by calculation_id.
 * Returns null if not found.
 */
function getSession(calculationId) {
  return stmtGetSession.get(calculationId) || null;
}

/**
 * Save a consultation to the consultations table.
 * Uses OR REPLACE so re-running is safe.
 */
function insertConsultation(calculationId, consultationObj, imageUrl, pdfUrl) {
  stmtInsertConsultation.run({
    id:                crypto.randomBytes(16).toString('hex'),
    calculation_id:    calculationId,
    consultation_json: JSON.stringify(consultationObj),
    image_url:         imageUrl || null,
    pdf_url:           pdfUrl   || null,
    created_at:        Date.now(),
  });
}

/**
 * Retrieve the consultation for a given calculation_id.
 * Returns null if not found.
 */
function getConsultation(calculationId) {
  return stmtGetConsultation.get(calculationId) || null;
}

/**
 * Save the user's email when they initiate payment (idempotent).
 */
function saveSessionEmail(calculationId, email) {
  stmtSaveSessionEmail.run({
    calculation_id: calculationId,
    email:          email,
    created_at:     Date.now(),
  });
}

/**
 * Get the email record for a calculation.
 */
function getSessionEmail(calculationId) {
  return stmtGetSessionEmail.get(calculationId) || null;
}

// ── Keitaro attribution ──────────────────────────────────────────────────────

/**
 * Attach a Keitaro click id to a session. First write wins, so a later request
 * carrying a different (or empty) value cannot overwrite the original click.
 * @param {string} calculationId
 * @param {string} subid  already sanitized by the caller
 */
function saveSubid(calculationId, subid) {
  if (!calculationId || !subid) { return; }
  stmtSaveSubid.run({ id: calculationId, subid });
}

/**
 * @param {string} calculationId
 * @returns {string} stored click id, '' when none
 */
function getSubid(calculationId) {
  if (!calculationId) { return ''; }
  const row = stmtGetSubid.get(calculationId);
  return (row && row.keitaro_subid) || '';
}

/**
 * Try to become the one caller allowed to send the postback for this payment.
 *
 * @param {string} paymentId  Stripe PaymentIntent id
 * @param {string} subid
 * @returns {boolean} true when this caller owns the send, false when another
 *                    delivery (a Stripe webhook retry) already claimed it
 */
function claimPostback(paymentId, subid) {
  const result = stmtClaimPostback.run({
    payment_id: paymentId,
    subid,
    created_at: Date.now(),
  });
  return result.changes === 1;
}

/**
 * Record the outcome of a postback attempt.
 * @param {string} paymentId
 * @param {{status: string, httpStatus: number|null, attempts: number}} outcome
 */
function finishPostback(paymentId, outcome) {
  stmtFinishPostback.run({
    payment_id:      paymentId,
    postback_status: outcome.status,
    http_status:     outcome.httpStatus != null ? outcome.httpStatus : null,
    attempts:        outcome.attempts || 0,
    sent_at:         Date.now(),
  });
}

/**
 * @param {string} paymentId
 * @returns {object|null}
 */
function getPostback(paymentId) {
  return stmtGetPostback.get(paymentId) || null;
}

// ── Delivery reconciliation ──────────────────────────────────────────────────

/**
 * Orders that were paid for but never received a consultation.
 * @param {number} windowMs   how far back to look
 * @param {number} maxAttempts give up after this many tries
 * @param {number} limit       cap per run — generation costs money
 * @returns {Array<{id: string, created_at: number, attempts: number}>}
 */
function getOrdersMissingConsultation(windowMs, maxAttempts, limit) {
  return stmtOrdersMissingConsultation.all({
    cutoff: Date.now() - windowMs,
    maxAttempts,
    limit,
  });
}

/** @param {string} calculationId */
function bumpConsultationAttempts(calculationId) {
  stmtBumpConsultationAttempts.run(calculationId);
}

/**
 * Mark the thank-you / consultation email as sent.
 */
function markThankYouSent(calculationId) {
  stmtMarkThankYouSent.run(calculationId);
}

/**
 * Mark the abandoned-cart email as sent.
 */
function markAbandonedSent(calculationId) {
  stmtMarkAbandonedSent.run(calculationId);
}

/**
 * Return sessions that left an email but didn't pay, older than minAgeMs.
 */
/**
 * Save a bonus promo code for a session (idempotent — only sets if not already set).
 */
function saveBonusCode(calculationId, code) {
  // Only write if not already assigned (idempotent)
  const existing = stmtGetBonusCode.get(calculationId);
  if (existing && existing.bonus_code) { return existing.bonus_code; }
  stmtSaveBonusCode.run({ id: calculationId, bonus_code: code });
  return code;
}

/**
 * Get the bonus code for a session, or null.
 */
function getBonusCode(calculationId) {
  const row = stmtGetBonusCode.get(calculationId);
  return (row && row.bonus_code) || null;
}

function getAbandonedCandidates(minAgeMs) {
  const cutoff = Date.now() - minAgeMs;
  return stmtGetAbandonedCandidates.all({ cutoff });
}

// ── Admin queries ────────────────────────────────────────────────────────────
const stmtGetAllSessions = db.prepare(`
  SELECT
    s.id,
    s.partner1_name, s.partner1_birth,
    s.partner2_name, s.partner2_birth,
    s.payment_status,
    s.compatibility_json,
    s.bonus_code,
    s.created_at,
    se.email,
    CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END AS consultation_ready
  FROM sessions s
  LEFT JOIN session_emails se ON se.calculation_id = s.id
  LEFT JOIN consultations c  ON c.calculation_id  = s.id
  ORDER BY s.created_at DESC
`);

const stmtGetAdminSession = db.prepare(`
  SELECT
    s.*,
    se.email,
    c.consultation_json,
    CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END AS consultation_ready
  FROM sessions s
  LEFT JOIN session_emails se ON se.calculation_id = s.id
  LEFT JOIN consultations c  ON c.calculation_id  = s.id
  WHERE s.id = ?
`);

function getAllSessions() {
  const rows = stmtGetAllSessions.all();
  return rows.map(function (r) {
    const compat = r.compatibility_json ? JSON.parse(r.compatibility_json) : {};
    return {
      id:                  r.id,
      email:               r.email || null,
      partner1_name:       r.partner1_name  || null,
      partner1_birth:      r.partner1_birth || null,
      partner2_name:       r.partner2_name  || null,
      partner2_birth:      r.partner2_birth || null,
      payment_status:      r.payment_status || 'pending',
      compatibility_score: compat.compatibilityScore != null ? compat.compatibilityScore : null,
      bonus_code:          r.bonus_code || null,
      created_at:          r.created_at,
      consultation_ready:  Boolean(r.consultation_ready),
    };
  });
}

function getAdminSession(id) {
  const r = stmtGetAdminSession.get(id);
  if (!r) { return null; }
  const compat = r.compatibility_json   ? JSON.parse(r.compatibility_json)   : {};
  const preview = r.preview_json        ? JSON.parse(r.preview_json)         : null;
  const consult = r.consultation_json   ? JSON.parse(r.consultation_json)    : null;
  return {
    id:             r.id,
    email:          r.email           || null,
    partner1_name:  r.partner1_name   || null,
    partner1_birth: r.partner1_birth  || null,
    partner1_gender:r.partner1_gender || null,
    partner2_name:  r.partner2_name   || null,
    partner2_birth: r.partner2_birth  || null,
    partner2_gender:r.partner2_gender || null,
    payment_status: r.payment_status  || 'pending',
    compatibility:  compat,
    preview:        preview,
    consultation:   consult,
    consultation_ready: Boolean(r.consultation_ready),
    bonus_code:     r.bonus_code || null,
    created_at:     r.created_at,
  };
}

// ── Analytics stats ──────────────────────────────────────────────────────────

/**
 * Ad attribution, independent of whatever the traffic partner reports.
 *
 * Splits orders by whether a Keitaro click id was captured, and reports how
 * many sale postbacks actually left the server. If the partner's dashboard and
 * these numbers disagree, the gap is visible here rather than taken on trust.
 *
 * @param {number} windowMs how far back to count
 * @returns {object}
 */
function getStatsAttribution(windowMs) {
  const cutoff = Date.now() - windowMs;

  const split = db.prepare(`
    SELECT
      SUM(CASE WHEN keitaro_subid IS NOT NULL AND keitaro_subid != '' THEN 1 ELSE 0 END) AS ad_visits,
      SUM(CASE WHEN keitaro_subid IS NULL OR  keitaro_subid  = '' THEN 1 ELSE 0 END) AS organic_visits,
      SUM(CASE WHEN payment_status = 'paid' AND keitaro_subid IS NOT NULL AND keitaro_subid != '' THEN 1 ELSE 0 END) AS ad_sales,
      SUM(CASE WHEN payment_status = 'paid' AND (keitaro_subid IS NULL OR keitaro_subid = '') THEN 1 ELSE 0 END) AS organic_sales,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND keitaro_subid IS NOT NULL AND keitaro_subid != ''
                        AND selected_price IS NOT NULL THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS ad_revenue,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND (keitaro_subid IS NULL OR keitaro_subid = '')
                        AND selected_price IS NOT NULL THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS organic_revenue
    FROM sessions
    WHERE created_at >= ?
  `).get(cutoff);

  // Delivery health: a sale that never reached Keitaro is unpaid commission
  // or a missing conversion, and only this table knows about it.
  const postbacks = db.prepare(`
    SELECT postback_status AS status, COUNT(*) AS count
      FROM keitaro_postbacks
     WHERE created_at >= ?
     GROUP BY postback_status
  `).all(cutoff);

  const recent = db.prepare(`
    SELECT p.payment_id, p.subid, p.postback_status, p.http_status, p.attempts, p.created_at,
           s.selected_price
      FROM keitaro_postbacks p
      LEFT JOIN sessions s ON s.keitaro_subid = p.subid
     WHERE p.created_at >= ?
     ORDER BY p.created_at DESC
     LIMIT 20
  `).all(cutoff);

  const byStatus = {};
  postbacks.forEach(function (r) { byStatus[r.status] = r.count; });

  const adVisits = split.ad_visits || 0;
  const orgVisits = split.organic_visits || 0;

  return {
    windowMs,
    ads: {
      visits:  adVisits,
      sales:   split.ad_sales || 0,
      revenue: Number((split.ad_revenue || 0).toFixed(2)),
      conversionRate: adVisits ? Number(((split.ad_sales || 0) / adVisits * 100).toFixed(2)) : 0,
    },
    organic: {
      visits:  orgVisits,
      sales:   split.organic_sales || 0,
      revenue: Number((split.organic_revenue || 0).toFixed(2)),
      conversionRate: orgVisits ? Number(((split.organic_sales || 0) / orgVisits * 100).toFixed(2)) : 0,
    },
    postbacks: {
      sent:     byStatus.sent     || 0,
      failed:   byStatus.failed   || 0,
      rejected: byStatus.rejected || 0,
      pending:  byStatus.pending  || 0,
    },
    recent,
  };
}

function getStatsOverview() {
  const now      = Date.now();
  const dayStart = now - (now % 86400000);          // midnight UTC today
  const weekAgo  = now - 7  * 86400000;
  const monthAgo = now - 30 * 86400000;

  // Counts from sessions including real revenue from selected_price
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week,
      SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS paid_total,
      SUM(CASE WHEN payment_status = 'paid' AND created_at >= ? THEN 1 ELSE 0 END) AS paid_today,
      SUM(CASE WHEN payment_status = 'paid' AND created_at >= ? THEN 1 ELSE 0 END) AS paid_week,
      SUM(CASE WHEN payment_status = 'paid' AND created_at >= ? THEN 1 ELSE 0 END) AS paid_month,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND selected_price IS NOT NULL AND created_at >= ? THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS rev_today,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND selected_price IS NOT NULL AND created_at >= ? THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS rev_week,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND selected_price IS NOT NULL AND created_at >= ? THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS rev_month,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND selected_price IS NOT NULL THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS rev_total,
      COALESCE(AVG(CASE WHEN json_valid(compatibility_json) THEN CAST(json_extract(compatibility_json, '$.compatibilityScore') AS REAL) END), 0) AS avg_score
    FROM sessions
  `).get(dayStart, weekAgo, dayStart, weekAgo, monthAgo, dayStart, weekAgo, monthAgo);

  // Preview/offer views (emails collected = user reached checkout)
  const previews = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week
    FROM session_emails
  `).get(dayStart, weekAgo);

  // 7-day funnel timeline (per day)
  const funnelTimeline = db.prepare(`
    SELECT
      (s.created_at / 86400000) * 86400000 AS day_bucket,
      COUNT(DISTINCT s.id) AS started,
      COUNT(DISTINCT se.calculation_id) AS emailed,
      COUNT(DISTINCT CASE WHEN s.payment_status = 'paid' THEN s.id END) AS paid
    FROM sessions s
    LEFT JOIN session_emails se ON se.calculation_id = s.id
    WHERE s.created_at >= ?
    GROUP BY day_bucket ORDER BY day_bucket
  `).all(weekAgo);

  // Hourly buckets for last 24 h (visits = session creates)
  const hourly = db.prepare(`
    SELECT (created_at / 3600000) * 3600000 AS hour_bucket, COUNT(*) AS c
    FROM sessions
    WHERE created_at >= ?
    GROUP BY hour_bucket
    ORDER BY hour_bucket
  `).all(now - 86400000);

  // Daily buckets for last 7 days
  const weekly = db.prepare(`
    SELECT (created_at / 86400000) * 86400000 AS day_bucket, COUNT(*) AS c
    FROM sessions
    WHERE created_at >= ?
    GROUP BY day_bucket
    ORDER BY day_bucket
  `).all(weekAgo);

  const crToday        = counts.today    > 0 ? ((counts.paid_today  / counts.today)    * 100).toFixed(1) : '0.0';
  const crWeek         = counts.week     > 0 ? ((counts.paid_week   / counts.week)     * 100).toFixed(1) : '0.0';
  const emailCapture   = counts.total    > 0 ? ((previews.total     / counts.total)    * 100).toFixed(1) : '0.0';
  const aov            = counts.paid_total > 0 ? (counts.rev_total / counts.paid_total).toFixed(2) : '0.00';

  return {
    visitors:         { today: counts.today,      week: counts.week,      total: counts.total },
    payments:         { today: counts.paid_today, week: counts.paid_week, month: counts.paid_month, total: counts.paid_total },
    conversion:       { today: crToday, week: crWeek },
    preview:          { today: previews.today, week: previews.week, total: previews.total },
    revenue:          { today: counts.rev_today, week: counts.rev_week, month: counts.rev_month, total: counts.rev_total },
    avg_score:        Math.round(counts.avg_score || 0),
    email_capture_rate: parseFloat(emailCapture),
    aov:              parseFloat(aov),
    hourly,
    weekly,
    funnel_timeline:  funnelTimeline,
  };
}

function getStatsFunnel() {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT s.id) AS started,
      COUNT(DISTINCT se.calculation_id) AS emailed,
      COUNT(DISTINCT CASE WHEN s.payment_status = 'paid' THEN s.id END) AS paid,
      COUNT(DISTINCT c.calculation_id) AS consulted
    FROM sessions s
    LEFT JOIN session_emails se ON se.calculation_id = s.id
    LEFT JOIN consultations  c  ON c.calculation_id  = s.id
  `).get();

  const abandoned = (row.emailed || 0) - (row.paid || 0);

  return {
    stages: [
      { name: 'Quiz avviato',           value: row.started   || 0 },
      { name: 'Email inserita',         value: row.emailed   || 0 },
      { name: 'Pagamento completato',   value: row.paid      || 0 },
      { name: 'Consulenza generata',    value: row.consulted || 0 },
    ],
    abandoned: abandoned > 0 ? abandoned : 0,
    email_to_pay_rate: row.emailed > 0 ? parseFloat(((row.paid / row.emailed) * 100).toFixed(1)) : 0,
  };
}

function getStatsRevenueBreakdown() {
  const rows = db.prepare(`
    SELECT
      COALESCE(selected_price, 'unknown') AS price_key,
      COUNT(*) AS count,
      COALESCE(SUM(CAST(selected_price AS REAL)), 0) AS total_rev
    FROM sessions
    WHERE payment_status = 'paid'
    GROUP BY selected_price
    ORDER BY CAST(COALESCE(selected_price, '0') AS REAL) DESC
  `).all();
  return { breakdown: rows };
}

function getStatsRealtime() {
  const cutoff = Date.now() - 5 * 60 * 1000;   // last 5 minutes
  const row = db.prepare(`
    SELECT COUNT(*) AS active FROM sessions WHERE created_at >= ?
  `).get(cutoff);
  return { active: row.active || 0 };
}

/**
 * Delete a session and all associated rows (email, consultation).
 * Also removes the PDF file from disk if present.
 */
function deleteSession(id) {
  db.transaction(function () {
    db.prepare('DELETE FROM sessions       WHERE id = ?').run(id);
    db.prepare('DELETE FROM session_emails WHERE calculation_id = ?').run(id);
    db.prepare('DELETE FROM consultations  WHERE calculation_id = ?').run(id);
  })();
  // Remove cached PDF if present
  const pdfPath = path.join(__dirname, 'storage', 'reports', 'report_' + id + '.pdf');
  try { if (fs.existsSync(pdfPath)) { fs.unlinkSync(pdfPath); } } catch (_) {}
}

module.exports = {
  insertSession,
  updateSessionPreview,
  markSessionPaid,
  getSession,
  insertConsultation,
  getConsultation,
  saveSessionEmail,
  getSessionEmail,
  markThankYouSent,
  markAbandonedSent,
  saveSubid,
  getSubid,
  getStatsAttribution,
  getOrdersMissingConsultation,
  bumpConsultationAttempts,
  claimPostback,
  finishPostback,
  getPostback,
  getAbandonedCandidates,  saveBonusCode,
  getBonusCode,  getAllSessions,
  getAdminSession,
  deleteSession,
  getStatsOverview,
  getStatsFunnel,
  getStatsRealtime,
  getStatsRevenueBreakdown,
};
