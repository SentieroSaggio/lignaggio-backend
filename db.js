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

// Which chapters of the reading this order includes. NULL means the whole
// thing — every order placed before the reading could be bought in pieces, and
// every full purchase since. A JSON array names the blocks that were paid for.
try { db.exec('ALTER TABLE sessions ADD COLUMN blocks_json TEXT'); } catch (_) {}
// The card Stripe saved at the first purchase (setup_future_usage). With it a
// chapter can be added from the result page in one tap, with no card form.
try { db.exec('ALTER TABLE sessions ADD COLUMN stripe_customer_id TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN stripe_pm_id TEXT'); } catch (_) {}
// Second abandoned-cart email, a day later, with the price in it.
try { db.exec('ALTER TABLE session_emails ADD COLUMN abandoned2_sent INTEGER DEFAULT 0'); } catch (_) {}
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

  -- Lignaggio Plus — the monthly reading the subscription actually buys.
  --
  -- One row per subscriber per month. The primary key is what makes the
  -- sweeper safe: a restart, a redeploy or two overlapping sweeps can all try
  -- to enqueue the same month, and only the first one wins. Nobody is ever
  -- mailed the same forecast twice.
  CREATE TABLE IF NOT EXISTS monthly_forecast (
    subscription_id TEXT NOT NULL,
    period          TEXT NOT NULL,          -- 'YYYY-MM'
    email           TEXT NOT NULL,
    name            TEXT,
    birth_date      TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
    forecast_json   TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    sent_at         INTEGER,
    created_at      INTEGER,
    PRIMARY KEY (subscription_id, period)
  );

  -- Unsubscribing from the monthly email is not the same as cancelling the
  -- subscription, and must not be: someone can want the reading to stop
  -- arriving while their billing is handled separately. Keyed by email so one
  -- opt-out covers every subscription that address ever had.
  CREATE TABLE IF NOT EXISTS monthly_optout (
    email      TEXT PRIMARY KEY,
    created_at INTEGER
  );

  -- Who the lineage and strega quizzes know by e-mail. Those funnels keep the
  -- birth date in the browser, so until this table existed a Plus subscriber
  -- who came from them had no birth date on file and the monthly reading was
  -- skipped. One row per address, newest data wins, empty values never
  -- overwrite a value we already have.
  CREATE TABLE IF NOT EXISTS quiz_profiles (
    email      TEXT PRIMARY KEY,          -- lower-cased, trimmed
    name       TEXT,
    birth_date TEXT,                      -- 'YYYY-MM-DD'
    quiz       TEXT,                      -- 'lin' | 'str' | …
    updated_at INTEGER
  );

  -- Lineage / strega leads: an e-mail with an archetype and no payment yet.
  -- Feeds the two reminder e-mails (1 h, 24 h). One row per quiz session;
  -- the sweep looks at the newest row per (email, quiz) and stops for good
  -- once any row of that pair is paid.
  CREATE TABLE IF NOT EXISTS quiz_leads (
    calculation_id TEXT PRIMARY KEY,
    quiz           TEXT NOT NULL,
    email          TEXT NOT NULL,          -- lower-cased, trimmed
    name           TEXT,
    arch           INTEGER,
    arch_name      TEXT,
    created_at     INTEGER NOT NULL,
    paid_at        INTEGER,
    reminder1_at   INTEGER,
    reminder2_at   INTEGER,
    last_error     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_leads_pair ON quiz_leads (email, quiz);

  -- Every PaymentIntent the lineage / strega quizzes create: opened checkouts
  -- and paid guides, by quiz. Written live (intent created, webhook, second
  -- guide) and refreshed from Stripe by the admin "sync", which also backfills
  -- the months before this table existed. Amounts in cents.
  CREATE TABLE IF NOT EXISTS quiz_payments (
    pi         TEXT PRIMARY KEY,
    quiz       TEXT NOT NULL,              -- 'lin' | 'str'
    arch       INTEGER,
    product    TEXT NOT NULL DEFAULT 'guide',   -- 'guide' | 'second_guide'
    price_key  TEXT,
    amount     INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL,              -- Stripe status ('succeeded' = paid)
    email      TEXT,                       -- lower-cased
    created_at INTEGER NOT NULL,
    paid_at    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_payments_quiz ON quiz_payments (quiz, created_at);

  -- One notice per failed renewal invoice of Lignaggio Plus. The claim is the
  -- primary key, so an hourly sweep can never send the same notice twice.
  CREATE TABLE IF NOT EXISTS dunning_notices (
    invoice_id      TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    email           TEXT NOT NULL,
    created_at      INTEGER,
    sent_at         INTEGER
  );

  -- The day-before-billing notice for Lignaggio Plus. One row per
  -- subscription: claiming the row is what guarantees a single email, however
  -- many times the hourly sweep sees the same trial.
  CREATE TABLE IF NOT EXISTS trial_reminders (
    subscription_id TEXT PRIMARY KEY,
    email           TEXT NOT NULL,
    trial_end       INTEGER,
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

// Only ever moves a row away from the default, never back: whichever request
// arrives with a real mode is the one that knows which funnel this order came
// from.
const stmtUpdateMode = db.prepare(`
  UPDATE sessions SET mode = @mode
   WHERE id = @id AND (mode IS NULL OR mode = 'coppia')
`);

const stmtSetBlocks = db.prepare(`
  UPDATE sessions SET blocks_json = @blocks_json WHERE id = @id
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

// ── Lignaggio Plus — monthly forecast statements ─────────────────────────────
const stmtEnqueueMonthly = db.prepare(`
  INSERT OR IGNORE INTO monthly_forecast
    (subscription_id, period, email, name, birth_date, status, attempts, created_at)
  VALUES (@subscription_id, @period, @email, @name, @birth_date, 'pending', 0, @created_at)
`);

const stmtMonthlyDue = db.prepare(`
  SELECT subscription_id, period, email, name, birth_date, attempts
    FROM monthly_forecast
   WHERE status = 'pending'
     AND attempts < @max_attempts
   ORDER BY created_at ASC
   LIMIT @limit
`);

const stmtMonthlySent = db.prepare(`
  UPDATE monthly_forecast
     SET status = 'sent', forecast_json = @forecast_json, sent_at = @sent_at, last_error = NULL
   WHERE subscription_id = @subscription_id AND period = @period
`);

const stmtMonthlyFailed = db.prepare(`
  UPDATE monthly_forecast
     SET attempts = attempts + 1,
         last_error = @last_error,
         status = CASE WHEN attempts + 1 >= @max_attempts THEN 'failed' ELSE 'pending' END
   WHERE subscription_id = @subscription_id AND period = @period
`);

const stmtMonthlySkipped = db.prepare(`
  UPDATE monthly_forecast
     SET status = 'skipped', last_error = @last_error
   WHERE subscription_id = @subscription_id AND period = @period
`);

const stmtGetMonthly = db.prepare(`
  SELECT * FROM monthly_forecast WHERE subscription_id = ? AND period = ?
`);

const stmtMonthlyStats = db.prepare(`
  SELECT status, COUNT(*) AS n FROM monthly_forecast WHERE period = ? GROUP BY status
`);

const stmtMonthlyRows = db.prepare(`
  SELECT subscription_id, period, email, name, birth_date, status, attempts, last_error, sent_at, created_at
    FROM monthly_forecast
   WHERE period = ?
   ORDER BY created_at ASC
`);

const stmtMonthlyPeriods = db.prepare(`
  SELECT period,
         SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         COUNT(*) AS total
    FROM monthly_forecast
   GROUP BY period
   ORDER BY period DESC
   LIMIT 24
`);

// ── Quiz profiles (lineage / strega) ─────────────────────────────────────────
const stmtSaveQuizProfile = db.prepare(`
  INSERT INTO quiz_profiles (email, name, birth_date, quiz, updated_at)
  VALUES (@email, @name, @birth_date, @quiz, @updated_at)
  ON CONFLICT(email) DO UPDATE SET
    name       = COALESCE(NULLIF(excluded.name, ''), quiz_profiles.name),
    birth_date = COALESCE(NULLIF(excluded.birth_date, ''), quiz_profiles.birth_date),
    quiz       = COALESCE(NULLIF(excluded.quiz, ''), quiz_profiles.quiz),
    updated_at = excluded.updated_at
`);

const stmtGetQuizProfile = db.prepare(`
  SELECT email, name, birth_date, quiz, updated_at FROM quiz_profiles WHERE email = ?
`);

// ── Quiz leads (lineage / strega reminders) ──────────────────────────────────
const stmtSaveQuizLead = db.prepare(`
  INSERT INTO quiz_leads (calculation_id, quiz, email, name, arch, arch_name, created_at)
  VALUES (@calculation_id, @quiz, @email, @name, @arch, @arch_name, @created_at)
  ON CONFLICT(calculation_id) DO UPDATE SET
    email     = excluded.email,
    name      = COALESCE(NULLIF(excluded.name, ''), quiz_leads.name),
    arch      = COALESCE(excluded.arch, quiz_leads.arch),
    arch_name = COALESCE(NULLIF(excluded.arch_name, ''), quiz_leads.arch_name)
`);

/* Newest unpaid lead per (email, quiz), old enough, never reminded, and no
   reminder to that pair in the last week (a retake does not restart the nagging). */
const stmtQuizLeadsDue1 = db.prepare(`
  SELECT l.* FROM quiz_leads l
   WHERE l.paid_at IS NULL AND l.reminder1_at IS NULL AND l.arch IS NOT NULL
     AND l.created_at <= @cutoff
     AND l.calculation_id = (SELECT x.calculation_id FROM quiz_leads x WHERE x.email = l.email AND x.quiz = l.quiz ORDER BY x.created_at DESC, x.rowid DESC LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM quiz_leads p WHERE p.email = l.email AND p.quiz = l.quiz AND p.paid_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM quiz_leads r WHERE r.email = l.email AND r.quiz = l.quiz AND r.reminder1_at IS NOT NULL AND r.reminder1_at > @recent)
   ORDER BY l.created_at ASC
   LIMIT 40
`);

const stmtQuizLeadsDue2 = db.prepare(`
  SELECT l.* FROM quiz_leads l
   WHERE l.paid_at IS NULL AND l.reminder1_at IS NOT NULL AND l.reminder2_at IS NULL
     AND l.created_at <= @cutoff
     AND l.reminder1_at <= @r1cutoff
     AND NOT EXISTS (SELECT 1 FROM quiz_leads p WHERE p.email = l.email AND p.quiz = l.quiz AND p.paid_at IS NOT NULL)
   ORDER BY l.created_at ASC
   LIMIT 40
`);

const stmtQuizLeadReminded1 = db.prepare(`
  UPDATE quiz_leads SET reminder1_at = @now, last_error = @error WHERE calculation_id = @calculation_id
`);
const stmtQuizLeadReminded2 = db.prepare(`
  UPDATE quiz_leads SET reminder2_at = @now, last_error = @error WHERE calculation_id = @calculation_id
`);
const stmtQuizLeadsPaid = db.prepare(`
  UPDATE quiz_leads SET paid_at = @now
   WHERE email = @email AND (@quiz = '' OR quiz = @quiz) AND paid_at IS NULL
`);
const stmtQuizLeadStats = db.prepare(`
  SELECT quiz,
         COUNT(*) AS leads,
         SUM(CASE WHEN reminder1_at IS NOT NULL THEN 1 ELSE 0 END) AS reminded1,
         SUM(CASE WHEN reminder2_at IS NOT NULL THEN 1 ELSE 0 END) AS reminded2,
         SUM(CASE WHEN paid_at IS NOT NULL THEN 1 ELSE 0 END) AS paid,
         SUM(CASE WHEN paid_at IS NOT NULL AND reminder1_at IS NOT NULL AND paid_at > reminder1_at THEN 1 ELSE 0 END) AS paid_after_reminder
    FROM quiz_leads
   GROUP BY quiz
`);
const stmtRecentQuizLeads = db.prepare(`
  SELECT calculation_id, quiz, email, name, arch, arch_name, created_at, paid_at, reminder1_at, reminder2_at, last_error
    FROM quiz_leads ORDER BY created_at DESC LIMIT 60
`);

// ── Quiz payments + per-quiz stats (lineage / strega) ────────────────────────
const stmtRecordQuizPayment = db.prepare(`
  INSERT INTO quiz_payments (pi, quiz, arch, product, price_key, amount, status, email, created_at, paid_at)
  VALUES (@pi, @quiz, @arch, @product, @price_key, @amount, @status, @email, @created_at, @paid_at)
  ON CONFLICT(pi) DO UPDATE SET
    status     = CASE WHEN quiz_payments.status = 'succeeded' THEN 'succeeded' ELSE excluded.status END,
    amount     = CASE WHEN excluded.amount > 0 THEN excluded.amount ELSE quiz_payments.amount END,
    arch       = COALESCE(excluded.arch, quiz_payments.arch),
    price_key  = COALESCE(NULLIF(excluded.price_key, ''), quiz_payments.price_key),
    email      = COALESCE(NULLIF(excluded.email, ''), quiz_payments.email),
    paid_at    = COALESCE(excluded.paid_at, quiz_payments.paid_at)
`);

const stmtQuizPayStats = db.prepare(`
  SELECT
    COUNT(DISTINCT CASE WHEN product = 'guide' THEN COALESCE(NULLIF(email, ''), pi) END)                           AS checkouts,
    SUM(CASE WHEN product = 'guide' AND status = 'succeeded' THEN 1 ELSE 0 END)                                       AS paid,
    COALESCE(SUM(CASE WHEN product = 'guide' AND status = 'succeeded' THEN amount ELSE 0 END), 0)                     AS revenue,
    SUM(CASE WHEN product = 'second_guide' AND status = 'succeeded' THEN 1 ELSE 0 END)                                AS second_count,
    COALESCE(SUM(CASE WHEN product = 'second_guide' AND status = 'succeeded' THEN amount ELSE 0 END), 0)              AS second_revenue,
    SUM(CASE WHEN product = 'guide' AND status = 'succeeded' AND created_at >= @today THEN 1 ELSE 0 END)              AS paid_today,
    COALESCE(SUM(CASE WHEN product = 'guide' AND status = 'succeeded' AND created_at >= @today THEN amount ELSE 0 END), 0) AS revenue_today
  FROM quiz_payments
  WHERE quiz = @quiz AND created_at >= @since
`);

const stmtQuizPayByPrice = db.prepare(`
  SELECT price_key, COUNT(*) AS paid, COALESCE(SUM(amount), 0) AS revenue
    FROM quiz_payments
   WHERE quiz = @quiz AND product = 'guide' AND status = 'succeeded' AND created_at >= @since
   GROUP BY price_key ORDER BY CAST(price_key AS REAL)
`);

/* People, not attempts: the step down creates a second intent for the same
   person, and someone who paid in the end is not "unpaid" at any price. */
const stmtQuizPayUnpaidByPrice = db.prepare(`
  SELECT q.price_key, COUNT(DISTINCT COALESCE(NULLIF(q.email, ''), q.pi)) AS n
    FROM quiz_payments q
   WHERE q.quiz = @quiz AND q.product = 'guide' AND q.status != 'succeeded' AND q.created_at >= @since
     AND NOT EXISTS (SELECT 1 FROM quiz_payments s
                      WHERE s.quiz = q.quiz AND s.product = 'guide' AND s.status = 'succeeded'
                        AND s.email = q.email AND q.email != '')
   GROUP BY q.price_key ORDER BY CAST(q.price_key AS REAL)
`);

const stmtQuizVisitsByPage = db.prepare(`
  SELECT page,
         SUM(count) AS period,
         SUM(CASE WHEN day >= @today THEN count ELSE 0 END) AS today
    FROM visit_counts
   WHERE page LIKE @like AND day >= @since
   GROUP BY page
`);

const stmtQuizLeadStatsPeriod = db.prepare(`
  SELECT COUNT(*) AS leads,
         SUM(CASE WHEN reminder1_at IS NOT NULL THEN 1 ELSE 0 END) AS reminded,
         SUM(CASE WHEN paid_at IS NOT NULL THEN 1 ELSE 0 END) AS paid,
         SUM(CASE WHEN paid_at IS NOT NULL AND reminder1_at IS NOT NULL AND paid_at > reminder1_at THEN 1 ELSE 0 END) AS paid_after_reminder
    FROM quiz_leads WHERE quiz = @quiz AND created_at >= @since
`);

const stmtQuizDailyPayments = db.prepare(`
  SELECT (created_at / 86400000) * 86400000 AS day,
         COUNT(DISTINCT CASE WHEN product = 'guide' THEN COALESCE(NULLIF(email, ''), pi) END) AS checkouts,
         SUM(CASE WHEN product = 'guide' AND status = 'succeeded' THEN 1 ELSE 0 END) AS paid,
         COALESCE(SUM(CASE WHEN product = 'guide' AND status = 'succeeded' THEN amount ELSE 0 END), 0) AS revenue
    FROM quiz_payments
   WHERE quiz = @quiz AND created_at >= @since
   GROUP BY day
`);

const stmtQuizDailyVisits = db.prepare(`
  SELECT day, SUM(count) AS opens
    FROM visit_counts
   WHERE page = @page AND day >= @since
   GROUP BY day
`);

/**
 * Remembers (or refreshes) one PaymentIntent of the lineage / strega quizzes.
 * @param {{pi: string, quiz: string, arch?: number, product?: string, priceKey?: string,
 *          amount?: number, status: string, email?: string, createdAt?: number, paidAt?: number}} p
 */
function recordQuizPayment(p) {
  if (!p || !p.pi || !p.quiz || !p.status) { return false; }
  const arch = parseInt(p.arch, 10);
  stmtRecordQuizPayment.run({
    pi:         String(p.pi),
    quiz:       String(p.quiz),
    arch:       arch >= 1 && arch <= 9 ? arch : null,
    product:    p.product === 'second_guide' ? 'second_guide' : 'guide',
    price_key:  String(p.priceKey || ''),
    amount:     Math.max(0, parseInt(p.amount, 10) || 0),
    status:     String(p.status),
    email:      String(p.email || '').trim().toLowerCase(),
    created_at: p.createdAt || Date.now(),
    paid_at:    p.paidAt || (p.status === 'succeeded' ? (p.createdAt || Date.now()) : null),
  });
  return true;
}

function getQuizPayment(pi) {
  return db.prepare('SELECT * FROM quiz_payments WHERE pi = ?').get(String(pi || '')) || null;
}

/**
 * Everything the admin panel shows for one quiz over the last `days` days:
 * page opens, leads, checkouts, paid guides, revenue, price split, daily rows.
 */
function getQuizStats(quiz, days) {
  const now = Date.now();
  const today = now - (now % 86400000);
  const since = now - days * 86400000;
  const sinceDay = since - (since % 86400000);

  const pages = {};
  for (const r of stmtQuizVisitsByPage.all({ like: quiz + ':%', since: sinceDay, today: today })) {
    pages[r.page.slice(quiz.length + 1)] = { period: r.period || 0, today: r.today || 0 };
  }
  const pay = stmtQuizPayStats.get({ quiz: quiz, since: since, today: today }) || {};
  const leads = stmtQuizLeadStatsPeriod.get({ quiz: quiz, since: since }) || {};
  const prices = stmtQuizPayByPrice.all({ quiz: quiz, since: since }).map(function (r) {
    return { price: r.price_key, paid: r.paid || 0, revenue: (r.revenue || 0) / 100 };
  });
  const unpaid = {};
  for (const r of stmtQuizPayUnpaidByPrice.all({ quiz: quiz, since: since })) { unpaid[r.price_key] = r.n; }

  const dailyDays = Math.min(days, 14);
  const dailySince = today - (dailyDays - 1) * 86400000;
  const byDay = {};
  for (let i = 0; i < dailyDays; i++) { const d = dailySince + i * 86400000; byDay[d] = { day: d, opens: 0, checkouts: 0, paid: 0, revenue: 0 }; }
  for (const r of stmtQuizDailyVisits.all({ page: quiz + ':index', since: dailySince })) { if (byDay[r.day]) { byDay[r.day].opens = r.opens || 0; } }
  for (const r of stmtQuizDailyPayments.all({ quiz: quiz, since: dailySince })) {
    if (byDay[r.day]) { byDay[r.day].checkouts = r.checkouts || 0; byDay[r.day].paid = r.paid || 0; byDay[r.day].revenue = (r.revenue || 0) / 100; }
  }

  const paid = pay.paid || 0, checkouts = pay.checkouts || 0;
  const opens = (pages.index && pages.index.period) || 0;
  return {
    quiz: quiz,
    days: days,
    pages: pages,
    opens: opens,
    starts: (pages.quiz && pages.quiz.period) || 0,
    leads: { total: leads.leads || 0, reminded: leads.reminded || 0, paid: leads.paid || 0, paidAfterReminder: leads.paid_after_reminder || 0 },
    checkouts: checkouts,
    paid: paid,
    paidToday: pay.paid_today || 0,
    revenue: (pay.revenue || 0) / 100,
    revenueToday: (pay.revenue_today || 0) / 100,
    aov: paid ? Number(((pay.revenue || 0) / 100 / paid).toFixed(2)) : 0,
    checkoutRate: checkouts ? Math.min(100, Number((paid / checkouts * 100).toFixed(1))) : 0,
    visitRate: opens ? Number((paid / opens * 100).toFixed(2)) : 0,
    second: { count: pay.second_count || 0, revenue: (pay.second_revenue || 0) / 100 },
    prices: prices,
    unpaidByPrice: unpaid,
    daily: Object.keys(byDay).sort().map(function (k) { return byDay[k]; }),
  };
}

// ── Lignaggio Plus dunning ledger ────────────────────────────────────────────
const stmtClaimDunning = db.prepare(`
  INSERT OR IGNORE INTO dunning_notices (invoice_id, subscription_id, email, created_at)
  VALUES (@invoice_id, @subscription_id, @email, @created_at)
`);
const stmtDunningSent = db.prepare(`UPDATE dunning_notices SET sent_at = @sent_at WHERE invoice_id = @invoice_id`);
const stmtReleaseDunning = db.prepare(`DELETE FROM dunning_notices WHERE invoice_id = ? AND sent_at IS NULL`);
const stmtGetDunning = db.prepare(`SELECT * FROM dunning_notices WHERE invoice_id = ?`);

const stmtClaimTrialReminder = db.prepare(`
  INSERT OR IGNORE INTO trial_reminders (subscription_id, email, trial_end, created_at)
  VALUES (@subscription_id, @email, @trial_end, @created_at)
`);
const stmtTrialReminderSent = db.prepare(`
  UPDATE trial_reminders SET sent_at = @sent_at WHERE subscription_id = @subscription_id
`);
const stmtReleaseTrialReminder = db.prepare(`
  DELETE FROM trial_reminders WHERE subscription_id = ? AND sent_at IS NULL
`);
const stmtGetTrialReminder = db.prepare(`
  SELECT * FROM trial_reminders WHERE subscription_id = ?
`);

/** Claims the reminder for one trial. False when it was already claimed. */
function claimTrialReminder(subscriptionId, email, trialEndSec) {
  const r = stmtClaimTrialReminder.run({
    subscription_id: subscriptionId, email: email,
    trial_end: Number(trialEndSec) || null, created_at: Date.now(),
  });
  return r.changes > 0;
}
function markTrialReminderSent(subscriptionId) {
  stmtTrialReminderSent.run({ subscription_id: subscriptionId, sent_at: Date.now() });
}
/** Gives a claim back after a transient send failure, so the next sweep retries. */
function releaseTrialReminder(subscriptionId) {
  stmtReleaseTrialReminder.run(subscriptionId);
}
function getTrialReminder(subscriptionId) {
  return stmtGetTrialReminder.get(subscriptionId) || null;
}

const stmtIsOptedOut = db.prepare(`
  SELECT 1 FROM monthly_optout WHERE email = ?
`);

const stmtOptOut = db.prepare(`
  INSERT OR IGNORE INTO monthly_optout (email, created_at) VALUES (?, ?)
`);

/* The birth date a subscriber gave when they took the quiz. They paid as
   partner 1, so partner 1 is whose month this is. Most recent session wins:
   somebody who retook the quiz with a corrected date meant the correction. */
const stmtBirthByEmail = db.prepare(`
  SELECT s.partner1_name AS name, s.partner1_birth AS birth_date
    FROM session_emails se
    JOIN sessions s ON s.id = se.calculation_id
   WHERE se.email = ?
     AND s.partner1_birth IS NOT NULL
     AND TRIM(s.partner1_birth) != ''
   ORDER BY s.created_at DESC
   LIMIT 1
`);

/**
 * Claims one subscriber-month. Returns false when it was already claimed,
 * which is how the sweeper stays safe across restarts and overlapping runs.
 * @returns {boolean} true when this call created the row
 */
function enqueueMonthlyForecast(row) {
  const res = stmtEnqueueMonthly.run({
    subscription_id: row.subscriptionId,
    period:          row.period,
    email:           row.email,
    name:            row.name || null,
    birth_date:      row.birthDate || null,
    created_at:      Date.now(),
  });
  return res.changes > 0;
}

function getMonthlyForecastDue(limit, maxAttempts) {
  return stmtMonthlyDue.all({
    limit:        limit || 25,
    max_attempts: maxAttempts || 3,
  });
}

function markMonthlyForecastSent(subscriptionId, period, forecast) {
  stmtMonthlySent.run({
    subscription_id: subscriptionId,
    period:          period,
    forecast_json:   JSON.stringify(forecast || {}),
    sent_at:         Date.now(),
  });
}

function markMonthlyForecastFailed(subscriptionId, period, message, maxAttempts) {
  stmtMonthlyFailed.run({
    subscription_id: subscriptionId,
    period:          period,
    last_error:      String(message || '').slice(0, 500),
    max_attempts:    maxAttempts || 3,
  });
}

function markMonthlyForecastSkipped(subscriptionId, period, reason) {
  stmtMonthlySkipped.run({
    subscription_id: subscriptionId,
    period:          period,
    last_error:      String(reason || '').slice(0, 500),
  });
}

function getMonthlyForecast(subscriptionId, period) {
  return stmtGetMonthly.get(subscriptionId, period) || null;
}

function getMonthlyForecastStats(period) {
  const out = {};
  for (const r of stmtMonthlyStats.all(period)) { out[r.status] = r.n; }
  return out;
}

function isMonthlyOptedOut(email) {
  return !!stmtIsOptedOut.get(String(email || '').trim().toLowerCase());
}

function optOutMonthly(email) {
  stmtOptOut.run(String(email || '').trim().toLowerCase(), Date.now());
}

/**
 * The birth date behind an e-mail address: the couple quiz first (partner 1),
 * then whatever the lineage / strega quizzes told us. Shape: {name, birth_date}.
 */
function findBirthDateByEmail(email) {
  const raw = String(email || '').trim();
  const fromCouple = stmtBirthByEmail.get(raw) || null;
  // A couple-quiz row with a date the forecast cannot read must not hide a
  // good date from the other quizzes (same two shapes monthlyForecast accepts).
  const readable = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{4})$/;
  if (fromCouple && readable.test(String(fromCouple.birth_date || '').trim())) { return fromCouple; }
  const profile = stmtGetQuizProfile.get(raw.toLowerCase());
  if (!profile || !profile.birth_date) { return null; }
  return { name: profile.name || '', birth_date: profile.birth_date };
}

/**
 * Remembers who a quiz visitor is. Empty fields never erase stored ones.
 * @param {{email: string, name?: string, birthDate?: string, quiz?: string}} p
 */
function saveQuizProfile(p) {
  const email = String((p && p.email) || '').trim().toLowerCase();
  if (!email) { return false; }
  stmtSaveQuizProfile.run({
    email:      email,
    name:       String((p && p.name) || '').trim().slice(0, 80),
    birth_date: String((p && p.birthDate) || '').trim().slice(0, 10),
    quiz:       String((p && p.quiz) || '').trim().slice(0, 20),
    updated_at: Date.now(),
  });
  return true;
}

function getQuizProfile(email) {
  return stmtGetQuizProfile.get(String(email || '').trim().toLowerCase()) || null;
}

/**
 * Remembers a lead of the lineage / strega quizzes. Empty name/archetype
 * never erase what an earlier call stored.
 * @param {{calculationId: string, quiz: string, email: string, name?: string, arch?: number, archName?: string}} p
 */
function saveQuizLead(p) {
  const cid = String((p && p.calculationId) || '').trim();
  const email = String((p && p.email) || '').trim().toLowerCase();
  const quiz = String((p && p.quiz) || '').trim();
  if (!cid || !email || !quiz) { return false; }
  const arch = parseInt(p.arch, 10);
  stmtSaveQuizLead.run({
    calculation_id: cid,
    quiz:           quiz,
    email:          email,
    name:           String((p && p.name) || '').trim().slice(0, 80),
    arch:           arch >= 1 && arch <= 9 ? arch : null,
    arch_name:      String((p && p.archName) || '').trim().slice(0, 120),
    created_at:     Date.now(),
  });
  return true;
}

function getQuizLead(calculationId) {
  return db.prepare('SELECT * FROM quiz_leads WHERE calculation_id = ?').get(String(calculationId || '')) || null;
}

/** Leads due for reminder n (1 or 2), at least minAgeMs old. */
function getQuizLeadsDue(n, minAgeMs) {
  const cutoff = Date.now() - minAgeMs;
  if (n === 1) { return stmtQuizLeadsDue1.all({ cutoff: cutoff, recent: Date.now() - 7 * 24 * 60 * 60 * 1000 }); }
  // The second note says "ieri": it waits for the first one to be a day old too.
  return stmtQuizLeadsDue2.all({ cutoff: cutoff, r1cutoff: Date.now() - Math.min(minAgeMs, 23 * 60 * 60 * 1000) });
}

function markQuizLeadReminded(calculationId, n, error) {
  const stmt = n === 1 ? stmtQuizLeadReminded1 : stmtQuizLeadReminded2;
  stmt.run({ calculation_id: String(calculationId || ''), now: Date.now(), error: error || null });
}

/** A paid e-mail gets no more reminders; quiz '' means every quiz of that address. */
function markQuizLeadsPaid(email, quiz) {
  const info = stmtQuizLeadsPaid.run({ email: String(email || '').trim().toLowerCase(), quiz: String(quiz || ''), now: Date.now() });
  return info.changes;
}

function getQuizLeadStats() {
  return stmtQuizLeadStats.all();
}

function getRecentQuizLeads() {
  return stmtRecentQuizLeads.all();
}

function claimDunningNotice(invoiceId, subscriptionId, email) {
  const info = stmtClaimDunning.run({ invoice_id: invoiceId, subscription_id: subscriptionId, email: String(email || '').trim(), created_at: Date.now() });
  return info.changes === 1;
}

function markDunningSent(invoiceId) {
  stmtDunningSent.run({ invoice_id: invoiceId, sent_at: Date.now() });
}

function releaseDunningNotice(invoiceId) {
  stmtReleaseDunning.run(invoiceId);
}

function getDunningNotice(invoiceId) {
  return stmtGetDunning.get(invoiceId) || null;
}

/** Every row of one month, without the forecast text (for the admin panel). */
function getMonthlyForecastRows(period) {
  return stmtMonthlyRows.all(period);
}

/** Per-month totals, newest first (for the admin panel). */
function getMonthlyPeriods() {
  return stmtMonthlyPeriods.all();
}

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
  JOIN sessions s ON s.id = se.calculation_id
  WHERE se.abandoned_sent = 0
    AND (s.payment_status IS NULL OR s.payment_status != 'paid')
    AND se.created_at < @cutoff
`);

/* The second nudge goes only to people who already got the first one and
   still have not paid. The score rides along so the email can quote it. */
const stmtGetAbandoned2Candidates = db.prepare(`
  SELECT se.calculation_id, se.email, s.partner1_name, s.partner2_name, s.compatibility_json
  FROM session_emails se
  JOIN sessions s ON s.id = se.calculation_id
  WHERE se.abandoned_sent = 1
    AND COALESCE(se.abandoned2_sent, 0) = 0
    AND (s.payment_status IS NULL OR s.payment_status != 'paid')
    AND se.created_at < @cutoff
`);
const stmtMarkAbandoned2Sent = db.prepare(`
  UPDATE session_emails SET abandoned2_sent = 1 WHERE calculation_id = ?
`);

const stmtSaveStripeCustomer = db.prepare(`
  UPDATE sessions SET stripe_customer_id = @customer, stripe_pm_id = @pm WHERE id = @id
`);
const stmtGetStripeCustomer = db.prepare(`
  SELECT stripe_customer_id AS customer, stripe_pm_id AS pm FROM sessions WHERE id = ?
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
 * The chapters an order includes.
 *
 * null is "everything": that is what a full purchase means, and what every
 * order predating the à-la-carte listing means. An array names the blocks.
 *
 * @param {string} calculationId
 * @returns {string[]|null}
 */
function getSessionBlocks(calculationId) {
  const row = stmtGetSession.get(calculationId);
  if (!row || !row.blocks_json) { return null; }
  try {
    const parsed = JSON.parse(row.blocks_json);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    // A corrupted list must not lock a paying customer out of their reading.
    return null;
  }
}

/**
 * Adds chapters to an order, keeping what it already had.
 *
 * Additive on purpose: a second purchase extends the first rather than
 * replacing it, and buying a block twice cannot take one away.
 *
 * @param {string} calculationId
 * @param {string[]} blockIds
 */
function addSessionBlocks(calculationId, blockIds) {
  if (!Array.isArray(blockIds) || blockIds.length === 0) { return; }

  const row = stmtGetSession.get(calculationId);
  if (!row) { return; }

  // Already whole: there is nothing to add, and writing a list would narrow it.
  if (row.payment_status === 'paid' && !row.blocks_json) { return; }

  let current = [];
  try { current = row.blocks_json ? JSON.parse(row.blocks_json) : []; } catch (_) { current = []; }
  if (!Array.isArray(current)) { current = []; }

  const merged = current.slice();
  blockIds.forEach(function (id) {
    if (merged.indexOf(id) === -1) { merged.push(id); }
  });

  stmtSetBlocks.run({ id: calculationId, blocks_json: JSON.stringify(merged) });
}

/**
 * Marks an order as covering the entire reading.
 * @param {string} calculationId
 */
/**
 * Records exactly which chapters a FIRST purchase bought. Unlike
 * addSessionBlocks it writes even on a paid row with no list yet — that is
 * precisely the moment a bundle has to be recorded, right after the order is
 * marked paid. Never call it for a later top-up: that would narrow the order.
 */
function setSessionBlocks(calculationId, blockIds) {
  if (!Array.isArray(blockIds)) { return; }
  stmtSetBlocks.run({ id: calculationId, blocks_json: JSON.stringify(blockIds) });
}

function clearSessionBlocks(calculationId) {
  stmtSetBlocks.run({ id: calculationId, blocks_json: null });
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

function getAbandoned2Candidates(minAgeMs) {
  const cutoff = Date.now() - minAgeMs;
  return stmtGetAbandoned2Candidates.all({ cutoff });
}

function markAbandoned2Sent(calculationId) {
  stmtMarkAbandoned2Sent.run(calculationId);
}

/** Remembers the card Stripe saved, so later chapters need no card form. */
function saveStripeCustomer(calculationId, customerId, paymentMethodId) {
  if (!calculationId || !customerId) { return; }
  stmtSaveStripeCustomer.run({ id: calculationId, customer: customerId, pm: paymentMethodId || null });
}

/** @returns {{customer: string, pm: string}|null} null when nothing was saved */
function getStripeCustomer(calculationId) {
  const row = stmtGetStripeCustomer.get(calculationId);
  return row && row.customer ? row : null;
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

/* The lineage and strega quizzes tag their opens with the quiz ('lin:index',
   'str:offer'…), so they stop blending into the couple-quiz counters above. */
const QUIZ_PREFIXES = ['lin:', 'str:'];
const QUIZ_PAGES = new Set(['index', 'quiz', 'analysis', 'offer', 'grazie', 'cookie', 'privacy', 'terms']);

function safeVisitPage(name) {
  for (const prefix of QUIZ_PREFIXES) {
    if (name.indexOf(prefix) === 0) {
      const rest = name.slice(prefix.length);
      return prefix + (QUIZ_PAGES.has(rest) ? rest : 'altro');
    }
  }
  return KNOWN_PAGES.has(name) ? name : 'altro';
}

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
  const safePage = safeVisitPage(name);

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
    WHERE page NOT LIKE '%:%'
  `).get(dayStart, weekAgo);

  const byPage = db.prepare(`
    SELECT page, SUM(count) AS count
    FROM visit_counts
    WHERE day >= ? AND page NOT LIKE '%:%'
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
  claimTrialReminder,
  markTrialReminderSent,
  releaseTrialReminder,
  getTrialReminder,
  enqueueMonthlyForecast,
  getMonthlyForecastDue,
  markMonthlyForecastSent,
  markMonthlyForecastFailed,
  markMonthlyForecastSkipped,
  getMonthlyForecast,
  getMonthlyForecastStats,
  getMonthlyForecastRows,
  getMonthlyPeriods,
  saveQuizProfile,
  getQuizProfile,
  saveQuizLead,
  getQuizLead,
  getQuizLeadsDue,
  markQuizLeadReminded,
  markQuizLeadsPaid,
  getQuizLeadStats,
  getRecentQuizLeads,
  claimDunningNotice,
  markDunningSent,
  recordQuizPayment,
  getQuizPayment,
  getQuizStats,
  releaseDunningNotice,
  getDunningNotice,
  isMonthlyOptedOut,
  optOutMonthly,
  findBirthDateByEmail,
  insertSession,
  updateSessionPreview,
  markSessionPaid,
  getSession,
  getSessionBlocks,
  addSessionBlocks,
  clearSessionBlocks,
  setSessionBlocks,
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
  getAbandonedCandidates,
  getAbandoned2Candidates,
  markAbandoned2Sent,
  saveStripeCustomer,
  getStripeCustomer,
  saveBonusCode,
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
