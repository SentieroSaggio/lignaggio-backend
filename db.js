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
const traffic  = require('./services/traffic');

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
// Our own campaign label captured from ?src= on the landing page — which reel,
// story or post this quiz came from. Independent of the Keitaro click id above.
try { db.exec('ALTER TABLE sessions ADD COLUMN traffic_src TEXT'); } catch (_) {}
// How many times the reconciler has tried to generate this consultation, so a
// permanently failing order cannot retry forever and burn OpenAI credit.
try { db.exec('ALTER TABLE sessions ADD COLUMN consultation_attempts INTEGER DEFAULT 0'); } catch (_) {}
// Analisi Focus — the gift a buyer claims after paying: one of four lenses
// (sessuale / finanze / karmico / anima) generated as a second, deeper reading.
// bonus_status walks 'idle' → 'generating' → 'ready' (or back to 'idle' on failure).
try { db.exec('ALTER TABLE sessions ADD COLUMN bonus_focus TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN bonus_json TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN bonus_status TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN bonus_generated_at INTEGER'); } catch (_) {}
// Which two people this order is about: 'coppia' (default) or 'famiglia'
// (a parent and a child). The calculation is the same; the reading is not.
try { db.exec("ALTER TABLE sessions ADD COLUMN mode TEXT DEFAULT 'coppia'"); } catch (_) {}

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

  -- Page opens, counted per day and per page.
  --
  -- A session row is only created once someone finishes the quiz and reaches
  -- the preview, so everyone who opened the site and left was invisible to the
  -- panel. This table closes that gap.
  --
  -- It holds counters and nothing else: no IP, no user agent, no cookie, no
  -- identifier of any kind, so there is nobody to identify in it and it needs
  -- no cookie consent to be collected.
  CREATE TABLE IF NOT EXISTS visit_counts (
    day   INTEGER NOT NULL,
    page  TEXT    NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, page)
  );

  -- The same page opens, but only the ones that arrived with our own ?src=
  -- label, split by that label.
  --
  -- A separate table rather than a column on visit_counts: that table's primary
  -- key is (day, page) and widening it would mean rebuilding it and rewriting
  -- every historical row. Here labelled traffic is counted a second time, on
  -- its own, and the totals in visit_counts stay exactly as they were.
  --
  -- Same privacy position as visit_counts: counters and a label we chose
  -- ourselves, no IP, no user agent, no cookie, nobody to identify.
  CREATE TABLE IF NOT EXISTS visit_sources (
    day    INTEGER NOT NULL,
    page   TEXT    NOT NULL,
    source TEXT    NOT NULL,
    count  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, page, source)
  );

  -- Rituale dei 7 giorni: one exercise a day, drawn from the consultation the
  -- buyer already paid for. No new model calls — the exercises were written
  -- together with the reading.
  --
  -- next_day is the exercise to send next (1-7). A row leaves the queue when
  -- next_day passes 7 or the reader unsubscribes.
  -- Analisi Focus acquistate oltre al regalo.
  --
  -- The gift lives on the sessions row because there is exactly one per order.
  -- Extra lenses are a different shape — many per order, each with its own
  -- payment — so they get their own table rather than four more columns.
  CREATE TABLE IF NOT EXISTS bonus_extra (
    calculation_id    TEXT NOT NULL,
    focus             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    bonus_json        TEXT,
    checkout_session  TEXT,
    paid_at           INTEGER,
    created_at        INTEGER,
    PRIMARY KEY (calculation_id, focus)
  );

  -- Il tuo Spazio: accesso via link inviato per email.
  --
  -- Two kinds of token live here. A 'magic' one is short-lived and single use —
  -- it is what travels through an inbox. Exchanging it produces an 'access'
  -- token the browser keeps, so the link in the email stops working the moment
  -- it has been used.
  --
  -- No passwords, no accounts: the email address is the identity, exactly as it
  -- already is for the receipt and the consultation.
  CREATE TABLE IF NOT EXISTS space_tokens (
    token       TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
  );

  -- Chi vuole la Carta Natale quando ci sarà.
  CREATE TABLE IF NOT EXISTS natal_waitlist (
    email       TEXT PRIMARY KEY,
    birth_date  TEXT,
    birth_time  TEXT,
    birth_place TEXT,
    created_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS ritual_progress (
    calculation_id TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    next_day       INTEGER NOT NULL DEFAULT 1,
    next_send_at   INTEGER NOT NULL,
    unsubscribed   INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER
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

// Only ever moves a row away from the default, never back: whichever request
// arrives with a real mode is the one that knows which funnel this order came
// from.
const stmtUpdateMode = db.prepare(`
  UPDATE sessions SET mode = @mode
   WHERE id = @id AND (mode IS NULL OR mode = 'coppia')
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

// ── Il tuo Spazio statements ─────────────────────────────────────────────────
const stmtInsertSpaceToken = db.prepare(`
  INSERT INTO space_tokens (token, email, kind, created_at, expires_at)
  VALUES (@token, @email, @kind, @created_at, @expires_at)
`);

const stmtGetSpaceToken = db.prepare(`
  SELECT * FROM space_tokens WHERE token = ? AND kind = ?
`);

const stmtUseSpaceToken = db.prepare(`
  UPDATE space_tokens SET used_at = @used_at
   WHERE token = @token AND kind = 'magic' AND used_at IS NULL
`);

const stmtPurgeSpaceTokens = db.prepare(`
  DELETE FROM space_tokens WHERE expires_at < @now
`);

// One row per order that carries this email, newest first. The consultation
// join tells the page whether there is anything to reopen.
const stmtSpaceSessions = db.prepare(`
  SELECT
    s.id, s.partner1_name, s.partner2_name, s.partner1_birth, s.partner2_birth,
    s.compatibility_json, s.payment_status, s.created_at,
    s.bonus_focus, s.bonus_status,
    (SELECT COUNT(*) FROM consultations c WHERE c.calculation_id = s.id) AS has_consultation
  FROM sessions s
  JOIN session_emails e ON e.calculation_id = s.id
 WHERE e.email = @email
 ORDER BY s.created_at DESC
 LIMIT 50
`);

const stmtAddWaitlist = db.prepare(`
  INSERT INTO natal_waitlist (email, birth_date, birth_time, birth_place, created_at)
  VALUES (@email, @birth_date, @birth_time, @birth_place, @created_at)
  ON CONFLICT(email) DO UPDATE SET
    birth_date  = COALESCE(excluded.birth_date,  natal_waitlist.birth_date),
    birth_time  = COALESCE(excluded.birth_time,  natal_waitlist.birth_time),
    birth_place = COALESCE(excluded.birth_place, natal_waitlist.birth_place)
`);

const stmtGetWaitlist = db.prepare(`
  SELECT * FROM natal_waitlist WHERE email = ?
`);

// ── Analisi Focus acquistate statements ──────────────────────────────────────
const stmtStartExtra = db.prepare(`
  INSERT INTO bonus_extra (calculation_id, focus, status, checkout_session, created_at)
  VALUES (@calculation_id, @focus, 'pending', @checkout_session, @created_at)
  ON CONFLICT(calculation_id, focus) DO UPDATE SET
    checkout_session = excluded.checkout_session
  WHERE bonus_extra.status = 'pending'
`);

const stmtMarkExtraPaid = db.prepare(`
  UPDATE bonus_extra SET status = 'generating', paid_at = @paid_at
   WHERE calculation_id = @calculation_id AND focus = @focus AND status = 'pending'
`);

const stmtSaveExtra = db.prepare(`
  UPDATE bonus_extra SET status = 'ready', bonus_json = @bonus_json
   WHERE calculation_id = @calculation_id AND focus = @focus
`);

const stmtGetExtra = db.prepare(`
  SELECT * FROM bonus_extra WHERE calculation_id = ? AND focus = ?
`);

const stmtListExtra = db.prepare(`
  SELECT focus, status, bonus_json FROM bonus_extra
   WHERE calculation_id = ? AND status != 'pending'
   ORDER BY paid_at ASC
`);

// ── Rituale dei 7 giorni statements ──────────────────────────────────────────
const stmtEnrolRitual = db.prepare(`
  INSERT OR IGNORE INTO ritual_progress
    (calculation_id, email, next_day, next_send_at, unsubscribed, created_at)
  VALUES (@calculation_id, @email, 1, @next_send_at, 0, @created_at)
`);

const stmtGetRitualDue = db.prepare(`
  SELECT calculation_id, email, next_day
    FROM ritual_progress
   WHERE unsubscribed = 0
     AND next_day <= @max_day
     AND next_send_at <= @now
   ORDER BY next_send_at ASC
   LIMIT @limit
`);

const stmtAdvanceRitual = db.prepare(`
  UPDATE ritual_progress
     SET next_day = next_day + 1, next_send_at = @next_send_at
   WHERE calculation_id = @calculation_id
`);

const stmtUnsubRitual = db.prepare(`
  UPDATE ritual_progress SET unsubscribed = 1
   WHERE calculation_id = @calculation_id AND unsubscribed = 0
`);

const stmtGetRitual = db.prepare(`
  SELECT * FROM ritual_progress WHERE calculation_id = ?
`);

// ── Analisi Focus statements ─────────────────────────────────────────────────
const stmtGetBonusState = db.prepare(`
  SELECT bonus_focus, bonus_json, bonus_status, bonus_generated_at
    FROM sessions WHERE id = ?
`);

// The WHERE guard makes the claim atomic: better-sqlite3 is synchronous, so two
// concurrent requests cannot both see an empty bonus_focus and both write.
const stmtClaimBonusFocus = db.prepare(`
  UPDATE sessions
     SET bonus_focus = @bonus_focus, bonus_status = 'generating'
   WHERE id = @id AND (bonus_focus IS NULL OR bonus_focus = '')
`);

const stmtSaveBonus = db.prepare(`
  UPDATE sessions
     SET bonus_json = @bonus_json, bonus_status = 'ready',
         bonus_generated_at = @bonus_generated_at
   WHERE id = @id
`);

const stmtResetBonus = db.prepare(`
  UPDATE sessions SET bonus_status = 'idle' WHERE id = @id AND bonus_json IS NULL
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

// ── Our own campaign label ───────────────────────────────────────────────────
// Same first-wins rule as the click id: a visitor who wanders back in through a
// second link mid-funnel must not rewrite the source of a quiz already started.

const stmtSaveTrafficSrc = db.prepare(`
  UPDATE sessions SET traffic_src = @src
   WHERE id = @id AND (traffic_src IS NULL OR traffic_src = '')
`);

const stmtGetTrafficSrc = db.prepare(`
  SELECT traffic_src FROM sessions WHERE id = ?
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
function insertSession(id, partner1, partner2, compatibility, quizContext, mode) {
  const quizJson = (Array.isArray(quizContext) && quizContext.length)
    ? JSON.stringify(quizContext)
    : null;

  // Written separately from the INSERT: the row may already exist (the webhook
  // can beat the preview request), and the mode must survive that race the same
  // way the quiz answers do.
  const cleanMode = (mode === 'famiglia') ? 'famiglia' : 'coppia';

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
  stmtUpdateMode.run({ id, mode: cleanMode });
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
 * Attach our own campaign label to a session. First write wins, for the same
 * reason as the click id above.
 * @param {string} calculationId
 * @param {string} src  already sanitized by the caller
 */
function saveTrafficSrc(calculationId, src) {
  if (!calculationId || !src) { return; }
  stmtSaveTrafficSrc.run({ id: calculationId, src });
}

/**
 * @param {string} calculationId
 * @returns {string} stored campaign label, '' when none
 */
function getTrafficSrc(calculationId) {
  if (!calculationId) { return ''; }
  const row = stmtGetTrafficSrc.get(calculationId);
  return (row && row.traffic_src) || '';
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

// ── Il tuo Spazio ────────────────────────────────────────────────────────────

/**
 * Store a token. Expired rows are swept on the way in, so the table cannot grow
 * without limit and nothing needs a cron job.
 *
 * @param {string} token
 * @param {string} email
 * @param {'magic'|'access'} kind
 * @param {number} ttlMs
 */
function saveSpaceToken(token, email, kind, ttlMs) {
  const now = Date.now();
  stmtPurgeSpaceTokens.run({ now });
  stmtInsertSpaceToken.run({
    token, email, kind, created_at: now, expires_at: now + ttlMs,
  });
}

/**
 * The email behind a token, or null when it is unknown, expired, or — for a
 * magic link — already used.
 *
 * @param {string} token
 * @param {'magic'|'access'} kind
 * @returns {string|null}
 */
function readSpaceToken(token, kind) {
  const row = stmtGetSpaceToken.get(token, kind);
  if (!row) { return null; }
  if (row.expires_at < Date.now()) { return null; }
  if (kind === 'magic' && row.used_at) { return null; }
  return row.email;
}

/**
 * Burn a magic link. The WHERE guard is what makes it single use: two clicks on
 * the same link race, and only the first one changes a row.
 *
 * @param {string} token
 * @returns {boolean} true when this call consumed the link
 */
function consumeSpaceToken(token) {
  return stmtUseSpaceToken.run({ token, used_at: Date.now() }).changes > 0;
}

/**
 * Every calculation belonging to an address.
 * @param {string} email
 * @returns {Array<object>}
 */
function getSpaceSessions(email) {
  return stmtSpaceSessions.all({ email });
}

/**
 * @param {{email: string, birthDate?: string, birthTime?: string, birthPlace?: string}} entry
 */
function addToNatalWaitlist(entry) {
  stmtAddWaitlist.run({
    email:       entry.email,
    birth_date:  entry.birthDate  || null,
    birth_time:  entry.birthTime  || null,
    birth_place: entry.birthPlace || null,
    created_at:  Date.now(),
  });
}

/** @returns {object|null} */
function getNatalWaitlistEntry(email) {
  return stmtGetWaitlist.get(email) || null;
}

// ── Analisi Focus acquistate ─────────────────────────────────────────────────

/**
 * Record an intent to buy one more lens. Re-running it for a lens still waiting
 * to be paid just updates the checkout session, so an abandoned checkout can be
 * retried without leaving orphan rows.
 *
 * @param {string} calculationId
 * @param {string} focus
 * @param {string} checkoutSessionId
 * @returns {boolean} false when that lens is already paid for
 */
function startExtraPurchase(calculationId, focus, checkoutSessionId) {
  const existing = stmtGetExtra.get(calculationId, focus);
  if (existing && existing.status !== 'pending') { return false; }
  stmtStartExtra.run({
    calculation_id:   calculationId,
    focus,
    checkout_session: checkoutSessionId,
    created_at:       Date.now(),
  });
  return true;
}

/**
 * Move a lens from pending to generating once Stripe confirms the payment.
 * The status guard makes webhook retries harmless.
 *
 * @returns {boolean} true when this call is the one that claimed the payment
 */
function markExtraPaid(calculationId, focus) {
  return stmtMarkExtraPaid.run({
    calculation_id: calculationId, focus, paid_at: Date.now(),
  }).changes > 0;
}

/** @param {object} bonusObj */
function saveExtraBonus(calculationId, focus, bonusObj) {
  stmtSaveExtra.run({
    calculation_id: calculationId, focus, bonus_json: JSON.stringify(bonusObj),
  });
}

/**
 * Every paid extra lens for an order, ready or still being written.
 * @returns {Array<{focus: string, status: string, bonus: object|null}>}
 */
function listExtraBonuses(calculationId) {
  return stmtListExtra.all(calculationId).map(function (row) {
    let bonus = null;
    if (row.bonus_json) {
      try { bonus = JSON.parse(row.bonus_json); } catch (_) { bonus = null; }
    }
    return { focus: row.focus, status: row.status, bonus };
  });
}

/** @returns {object|null} */
function getExtraBonus(calculationId, focus) {
  return stmtGetExtra.get(calculationId, focus) || null;
}

// ── Rituale dei 7 giorni ─────────────────────────────────────────────────────

const RITUAL_TOTAL_DAYS = 7;

/**
 * Put a buyer in the seven-day queue. Idempotent: re-running generation for the
 * same order must not restart the sequence from day one.
 *
 * @param {string} calculationId
 * @param {string} email
 * @param {number} firstSendAt  epoch ms of the first exercise
 * @returns {boolean} true when a new row was created
 */
function enrolInRitual(calculationId, email, firstSendAt) {
  const info = stmtEnrolRitual.run({
    calculation_id: calculationId,
    email,
    next_send_at:   firstSendAt,
    created_at:     Date.now(),
  });
  return info.changes > 0;
}

/**
 * Rows whose next exercise is due.
 * @param {number} [limit]
 * @returns {Array<{calculation_id: string, email: string, next_day: number}>}
 */
function getRitualDue(limit) {
  return stmtGetRitualDue.all({ now: Date.now(), max_day: RITUAL_TOTAL_DAYS, limit: limit || 25 });
}

/**
 * Move a reader to the next day, or drop them from the queue after the last one.
 * @param {string} calculationId
 * @param {number} nextSendAt  epoch ms for the following exercise
 */
function advanceRitual(calculationId, nextSendAt) {
  stmtAdvanceRitual.run({ calculation_id: calculationId, next_send_at: nextSendAt });
}

/**
 * @param {string} calculationId
 * @returns {boolean} true when a row was actually stopped
 */
function unsubscribeFromRitual(calculationId) {
  return stmtUnsubRitual.run({ calculation_id: calculationId }).changes > 0;
}

/** @returns {object|null} */
function getRitualProgress(calculationId) {
  return stmtGetRitual.get(calculationId) || null;
}

// ── Analisi Focus (the post-purchase gift) ───────────────────────────────────

/**
 * Claim a lens for a session. Idempotent by design: the first claim wins and
 * later calls are ignored, so a double-tap on the choice screen cannot start a
 * second generation or silently swap the gift the buyer already received.
 *
 * @param {string} calculationId
 * @param {string} focus  one of sessuale | finanze | karmico | anima
 * @returns {{claimed: boolean, focus: string|null, status: string}}
 */
function claimBonusFocus(calculationId, focus) {
  const row = stmtGetBonusState.get(calculationId);
  if (!row) { return { claimed: false, focus: null, status: 'missing' }; }
  if (row.bonus_focus) {
    return { claimed: false, focus: row.bonus_focus, status: row.bonus_status || 'idle' };
  }
  stmtClaimBonusFocus.run({ id: calculationId, bonus_focus: focus });
  return { claimed: true, focus, status: 'generating' };
}

/**
 * Store the generated gift and mark it ready.
 * @param {string} calculationId
 * @param {object} bonusObj  { titolo, sezioni: [...], esercizi: [...] }
 */
function saveBonusAnalysis(calculationId, bonusObj) {
  stmtSaveBonus.run({
    id:                 calculationId,
    bonus_json:         JSON.stringify(bonusObj),
    bonus_generated_at: Date.now(),
  });
}

/**
 * Release a failed generation so the buyer can try again with the same lens.
 * @param {string} calculationId
 */
function resetBonusStatus(calculationId) {
  stmtResetBonus.run({ id: calculationId });
}

/**
 * Current gift state for a session.
 * @param {string} calculationId
 * @returns {{focus: string|null, status: string, bonus: object|null, generatedAt: number|null}|null}
 */
function getBonusAnalysis(calculationId) {
  const row = stmtGetBonusState.get(calculationId);
  if (!row) { return null; }
  let bonus = null;
  if (row.bonus_json) {
    try { bonus = JSON.parse(row.bonus_json); } catch (_) { bonus = null; }
  }
  return {
    focus:       row.bonus_focus   || null,
    status:      row.bonus_status  || 'idle',
    bonus,
    generatedAt: row.bonus_generated_at || null,
  };
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
    MAX(se.email) AS email,
    MAX(CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END) AS consultation_ready
  FROM sessions s
  LEFT JOIN session_emails se ON se.calculation_id = s.id
  LEFT JOIN consultations c  ON c.calculation_id  = s.id
  -- Without this, a session carrying two emails or two consultations came back
  -- as two rows: the list showed it twice and the header counted it twice. The
  -- stats queries use COUNT(DISTINCT), which is why the two disagreed.
  GROUP BY s.id
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

/**
 * Performance of our own labelled traffic, one row per ?src= label.
 *
 * This is the number to show a partner for a reel or a post: clicks measured on
 * arrival, sales measured at payment, both by us, neither depending on cookie
 * consent, an ad blocker, or the partner's tracker.
 *
 * Two populations that must not be confused, and the panel labels them apart:
 *   clicks   — arrivals on a link carrying the label (visit_sources)
 *   quizzes  — of those, the ones who finished the quiz and reached the preview
 *
 * Only sessions started inside the window are counted, but clicks are bucketed
 * per UTC day, so the click window is rounded outwards to the whole day the
 * cutoff falls in — a half day of clicks silently dropped would understate the
 * conversion rate of the newest campaign, which is the one being judged.
 *
 * @param {number} windowMs how far back to count
 * @returns {{windowMs: number, sources: Array, totals: object}}
 */
function getStatsSources(windowMs) {
  const cutoff    = Date.now() - windowMs;
  const cutoffDay = cutoff - (cutoff % 86400000);

  const clicks = db.prepare(`
    SELECT source, SUM(count) AS clicks
      FROM visit_sources
     WHERE day >= ?
     GROUP BY source
  `).all(cutoffDay);

  const funnel = db.prepare(`
    SELECT
      traffic_src AS source,
      COUNT(*) AS quizzes,
      SUM(CASE WHEN payment_status = 'paid' THEN 1 ELSE 0 END) AS sales,
      COALESCE(SUM(CASE WHEN payment_status = 'paid' AND selected_price IS NOT NULL
                        THEN CAST(selected_price AS REAL) ELSE 0 END), 0) AS revenue
      FROM sessions
     WHERE created_at >= ? AND traffic_src IS NOT NULL AND traffic_src != ''
     GROUP BY traffic_src
  `).all(cutoff);

  // A label can appear on one side only — clicks with no sale yet, or a sale
  // whose clicks fell outside the window — so both sides are merged rather than
  // joined, and a missing side reads as zero instead of dropping the row.
  const bySource = new Map();
  const rowFor = function (name) {
    if (!bySource.has(name)) {
      bySource.set(name, { source: name, clicks: 0, quizzes: 0, sales: 0, revenue: 0 });
    }
    return bySource.get(name);
  };

  clicks.forEach(function (r) { rowFor(r.source).clicks = r.clicks || 0; });
  funnel.forEach(function (r) {
    const row = rowFor(r.source);
    row.quizzes = r.quizzes || 0;
    row.sales   = r.sales   || 0;
    row.revenue = Number((r.revenue || 0).toFixed(2));
  });

  const sources = Array.from(bySource.values()).map(function (row) {
    return Object.assign({}, row, {
      // Against clicks, not quizzes: the honest question is what share of the
      // people who tapped the link ended up paying.
      conversionRate: row.clicks ? Number((row.sales / row.clicks * 100).toFixed(2)) : 0,
      quizRate:       row.clicks ? Number((row.quizzes / row.clicks * 100).toFixed(2)) : 0,
    });
  }).sort(function (a, b) {
    return (b.revenue - a.revenue) || (b.clicks - a.clicks) || a.source.localeCompare(b.source);
  });

  const totals = sources.reduce(function (acc, row) {
    acc.clicks  += row.clicks;
    acc.quizzes += row.quizzes;
    acc.sales   += row.sales;
    acc.revenue += row.revenue;
    return acc;
  }, { clicks: 0, quizzes: 0, sales: 0, revenue: 0 });
  totals.revenue = Number(totals.revenue.toFixed(2));

  return { windowMs, sources, totals };
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

  // `visitors` counts quiz sessions, which only exist once someone reaches the
  // preview. `visits` counts page opens, which is the larger, earlier number.
  const visits = getVisitStats();

  return {
    visits,
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

/** Page names we count separately; anything else is folded into 'altro'. */
const KNOWN_PAGES = new Set([
  'index', 'partner1', 'partner2', 'question', 'analysis', 'offer',
  'result', 'cookie', 'privacy', 'terms',
]);

const stmtRecordVisit = db.prepare(`
  INSERT INTO visit_counts (day, page, count) VALUES (@day, @page, 1)
  ON CONFLICT(day, page) DO UPDATE SET count = count + 1
`);

const stmtRecordVisitSource = db.prepare(`
  INSERT INTO visit_sources (day, page, source, count) VALUES (@day, @page, @source, 1)
  ON CONFLICT(day, page, source) DO UPDATE SET count = count + 1
`);

/**
 * Count one page open, and — when the visit arrived with one of our own labels
 * — count it a second time against that label.
 *
 * Treats both values as untrusted: only known page names are stored, everything
 * else becomes 'altro', and a label that does not match the agreed shape is
 * dropped rather than written, so nothing arbitrary can reach either table.
 *
 * @param {string} page
 * @param {string} [source] our ?src= label, absent for unlabelled traffic
 */
function recordVisit(page, source) {
  const name = String(page || '').trim().toLowerCase();
  const now  = Date.now();
  const day  = now - (now % 86400000);          // midnight UTC
  const safePage = KNOWN_PAGES.has(name) ? name : 'altro';

  stmtRecordVisit.run({ day, page: safePage });

  const label = traffic.sanitizeSource(source);
  if (label) {
    stmtRecordVisitSource.run({ day, page: safePage, source: label });
  }
}

/**
 * Page opens for the panel: today, this week, all time, plus a per-page split.
 * @returns {{today: number, week: number, total: number, by_page: Array}}
 */
function getVisitStats() {
  const now      = Date.now();
  const dayStart = now - (now % 86400000);
  const weekAgo  = now - 7 * 86400000;

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN day >= ? THEN count ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN day >= ? THEN count ELSE 0 END), 0) AS week,
      COALESCE(SUM(count), 0)                                    AS total
    FROM visit_counts
  `).get(dayStart, weekAgo);

  const byPage = db.prepare(`
    SELECT page, SUM(count) AS count
    FROM visit_counts
    WHERE day >= ?
    GROUP BY page
    ORDER BY count DESC
  `).all(weekAgo);

  return {
    today:   totals.today || 0,
    week:    totals.week  || 0,
    total:   totals.total || 0,
    by_page: byPage,
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
  getStatsSources,
  saveTrafficSrc,
  getTrafficSrc,
  getOrdersMissingConsultation,
  bumpConsultationAttempts,
  claimPostback,
  finishPostback,
  getPostback,
  getAbandonedCandidates,  saveBonusCode,
  getBonusCode,
  claimBonusFocus,
  saveBonusAnalysis,
  resetBonusStatus,
  getBonusAnalysis,
  saveSpaceToken,
  readSpaceToken,
  consumeSpaceToken,
  getSpaceSessions,
  addToNatalWaitlist,
  getNatalWaitlistEntry,
  startExtraPurchase,
  markExtraPaid,
  saveExtraBonus,
  listExtraBonuses,
  getExtraBonus,
  enrolInRitual,
  getRitualDue,
  advanceRitual,
  unsubscribeFromRitual,
  getRitualProgress,
  RITUAL_TOTAL_DAYS,
  getAllSessions,
  getAdminSession,
  deleteSession,
  recordVisit,
  getVisitStats,
  getStatsOverview,
  getStatsFunnel,
  getStatsRealtime,
  getStatsRevenueBreakdown,
};
