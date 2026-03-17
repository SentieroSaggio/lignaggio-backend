require('dotenv').config();

const express = require('express');
const path = require('path');
const Stripe = require('stripe');
const cors = require('cors');
const OpenAI = require('openai');
const crypto = require('crypto');

// ── Persistent storage (SQLite via better-sqlite3) ─────────────────────────
const db = require('../db');

// ── PDF generator ─────────────────────────────────────────────────────────
const { generatePremiumPDF } = require('../services/pdfGenerator');

// -----------------------------------------------------
// Конфиг цен (price_id берём из переменных окружения)
// -----------------------------------------------------
const PRICE_MAP = {
  '1.59': process.env.PRICE_159_ID,
  '3.59': process.env.PRICE_359_ID,
  '7.59': process.env.PRICE_759_ID,
  '5': process.env.PRICE_5_ID,
  '9': process.env.PRICE_9_ID,
  '13': process.env.PRICE_13_ID,
  '17.67': process.env.PRICE_1767_ID,
  '19': process.env.SUBSCRIPTION_PRICE_ID,
};

const AUTO_SUBSCRIPTION_PRICE_KEYS = new Set(['1.59', '3.59', '7.59', '5', '9', '13', '17.67']);
const SUBSCRIPTION_TRIAL_DAYS = 7;

const app = express();

// ── Stripe initialization ─────────────────────────────────────────────────────
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  console.error('❌ FATAL: Missing STRIPE_SECRET_KEY in environment. Server cannot start.');
  process.exit(1);
}
const stripe = Stripe(stripeSecretKey);

// ── OpenAI initialization ─────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set — consultation generation will fail at runtime.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── PRICE_MAP health warnings ─────────────────────────────────────────────────
const REQUIRED_PRICE_KEYS = ['1.59', '3.59', '7.59', '17.67'];
REQUIRED_PRICE_KEYS.forEach(function (k) {
  if (!PRICE_MAP[k]) {
    console.warn('⚠️  PRICE_MAP: missing env var for price key "' + k + '" — payments at this price will fail.');
  }
});

// ── In-memory result cache (SQLite is the persistent source of truth) ────────
// Shape: { [calculation_id]: { calculationId, _partnerData, payment, preview, result, compatibility, createdAt } }
// Rebuilt from DB on first access after server restart.
const generatedResults = {};

const PORT = process.env.PORT || 4242;
const SUBSCRIPTION_PRICE_ID = process.env.SUBSCRIPTION_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ── Bonus promo code generator ────────────────────────────────
const BONUS_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateServerBonusCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += BONUS_CHARS[Math.floor(Math.random() * BONUS_CHARS.length)];
  }
  return code;
}

// =====================================================
// 0) CORS — разрешаем фронтенд lignaggio.it
// =====================================================
app.use(
  cors({
    origin: [
      'https://lignaggio.it',
      'https://www.lignaggio.it',
      'http://localhost:4242', // на будущее, для локальных тестов
    ],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// =====================================================
// 1) WEBHOOK — ОБЯЗАТЕЛЬНО ДО ЛЮБЫХ body-parser’ов
// =====================================================
/**
 * Очень важно:
 *  - для /webhook используем express.raw({ type: 'application/json' })
 *  - НИ ОДИН другой body-parser не должен применяться к этому маршруту.
 */
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!WEBHOOK_SECRET) {
      console.error('❌ Missing STRIPE_WEBHOOK_SECRET in environment');
      return res.status(500).send('Webhook secret not configured');
    }

    const sig = req.headers['stripe-signature'];

    let event;
    try {
      // req.body здесь — Buffer, это то, что нужно Stripe
      event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Логируем тип события и при необходимости обрабатываем
    console.log('🔔 Webhook event received:', event.type);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;
        console.log('✅ PaymentIntent succeeded:', paymentIntent.id);

        const customerId    = paymentIntent.customer;
        const paymentMethodId = paymentIntent.payment_method;
        const metadata      = paymentIntent.metadata || {};

        // ── New compatibility quiz: mark result as paid, persist to DB ──────────
        const calculationId = metadata.calculation_id;
        const selectedPrice  = metadata.selected_price || metadata.price || null;
        if (calculationId) {
          console.log('[webhook] payment_intent.succeeded — calculation_id:', calculationId);
          markResultAsPaid(calculationId, selectedPrice);
          // Fire-and-forget: generate full consultation asynchronously after payment.
          // Do NOT await — webhook must respond to Stripe quickly (< 30 s).
          generateFullConsultation(calculationId).catch(function (err) {
            console.error('[webhook] generateFullConsultation error for:', calculationId, err.message);
          });
        }
        // ─────────────────────────────────────────────────────────────────────────

        if (!SUBSCRIPTION_PRICE_ID) {
          console.warn('⚠️ SUBSCRIPTION_PRICE_ID is not set, skip subscription creation');
          break;
        }

        const eligibleForAutoSubscription = isAutoSubscriptionEligible(metadata);

        if (!eligibleForAutoSubscription) {
          console.log('ℹ️ Price is not eligible for automatic subscription, skipping');
          break;
        }

        if (!customerId || !paymentMethodId) {
          console.warn('⚠️ Missing customer or payment method, skip subscription creation');
          break;
        }

        try {
          const alreadySubscribed = await customerHasActiveSubscription(customerId);

          if (alreadySubscribed) {
            console.log('ℹ️ Customer already has active subscription, skipping creation');
            break;
          }

          const subscription = await stripe.subscriptions.create({
            customer: customerId,
            items: [{ price: SUBSCRIPTION_PRICE_ID }],
            default_payment_method: paymentMethodId,
            trial_period_days: SUBSCRIPTION_TRIAL_DAYS,
            metadata: {
              email: metadata.email || '',
              archetype: metadata.arch || metadata.archetype || '',
              one_time_price: metadata.selected_price || metadata.price || '',
              origin: 'one_time_payment',
              payment_intent: paymentIntent.id,
            },
          }, {
            idempotencyKey: `pi_${paymentIntent.id}_subscription`,
          });

          console.log('🌀 Subscription created from payment_intent:', subscription.id);
        } catch (subError) {
          console.error('❌ Failed to create subscription from payment_intent:', subError);
        }

        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log('💶 Invoice payment succeeded:', invoice.id);
        break;
      }
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('🧾 Checkout session completed:', session.id);
        break;
      }
      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  }
);

// =====================================================
// 2) ОСТАЛЬНЫЕ МИДДЛВАРЫ (после /webhook)
// =====================================================
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// =====================================================
// 3) /config — отдаём publishable key на фронт
// =====================================================
app.get('/config', (req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res
      .status(500)
      .json({ error: 'Missing STRIPE_PUBLISHABLE_KEY in environment' });
  }

  res.json({ publishableKey });
});

// -----------------------------------------------------
// Helper: берём сумму и валюту из Stripe Price
// -----------------------------------------------------
async function getAmountFromPriceKey(priceKey) {
  priceKey = String(priceKey).trim().replace(',', '.');
  console.log('DEBUG PRICE_MAP[1.59]=', PRICE_MAP['1.59'], 'priceKey=', JSON.stringify(priceKey));
  const stripePriceId = PRICE_MAP[priceKey];
  if (!stripePriceId) {
    throw new Error(`Unknown price key: ${priceKey}`);
  }

  const price = await stripe.prices.retrieve(stripePriceId);
  if (!price || typeof price.unit_amount !== 'number') {
    throw new Error(`Invalid Stripe price for ${stripePriceId}`);
  }

  return {
    amount: price.unit_amount,
    currency: price.currency || 'eur',
    stripePriceId,
  };
}

function isAutoSubscriptionEligible(metadata) {
  if (!metadata) {
    return false;
  }

  const rawPrice = String(metadata.selected_price || metadata.price || '')
    .trim()
    .replace(',', '.');

  return AUTO_SUBSCRIPTION_PRICE_KEYS.has(rawPrice);
}

async function customerHasActiveSubscription(customerId) {
  if (!customerId || !SUBSCRIPTION_PRICE_ID) {
    return false;
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 20,
  });

  return subscriptions.data.some((sub) => {
    if (!sub || sub.status === 'canceled' || sub.status === 'incomplete_expired') {
      return false;
    }

    return sub.items.data.some(
      (item) => item.price && item.price.id === SUBSCRIPTION_PRICE_ID
    );
  });
}

// ── Result access helpers (new compatibility quiz) ────────────────

/**
 * Generates a cryptographically secure random access token for a result.
 * TODO: In production, store this token in a real DB and require it for every result fetch.
 */
function generateAccessToken(calculationId) {
  // 48 random bytes → URL-safe base64 (~64 chars)
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Marks a generated result as paid and issues an access token.
 * Persists status to SQLite and updates the in-memory cache.
 */
function markResultAsPaid(calculationId) {
  const token    = generateAccessToken(calculationId);
  const grantedAt = new Date().toISOString();

  // ── Persist to DB ──────────────────────────────────────────────────────────
  // If the session row exists update it; if it doesn't (webhook beat the preview
  // call) the DB update is a no-op — generateFullConsultation will retry.
  try {
    db.markSessionPaid(calculationId, token);
    console.log('[db] Session marked paid in DB for calculation_id:', calculationId);
    // Generate bonus code server-side (idempotent)
    try {
      const code = db.saveBonusCode(calculationId, generateServerBonusCode());
      console.log('[bonus] Code assigned for', calculationId, ':', code);
    } catch (bcErr) {
      console.error('[bonus] saveBonusCode error:', bcErr.message);
    }
  } catch (dbErr) {
    console.error('[markResultAsPaid] DB write error:', dbErr.message);
  }

  // ── Update in-memory cache (if present) ───────────────────────────────────
  const stored = generatedResults[calculationId];
  if (stored) {
    if (!stored.payment) {
      stored.payment = { status: 'pending', paymentIntentId: null, accessToken: null, accessGrantedAt: null };
    }
    stored.payment.status          = 'paid';
    stored.payment.accessToken     = token;
    stored.payment.accessGrantedAt = grantedAt;
    // Keep backward-compat alias
    stored.resultAccess = {
      calculationId,
      paymentStatus:   'paid',
      accessToken:     token,
      accessGrantedAt: grantedAt,
    };
  }

  console.log('[PAYMENT CONFIRMED] calculation_id:', calculationId);
  // Return true unconditionally — DB is the source of truth now
  return true;
}

// =====================================================
// 4) /create-payment-intent — разовый платёж
// =====================================================
app.post('/create-payment-intent', async (req, res) => {
  try {
    // Old quiz fields + new compatibility quiz optional fields (calculation_id, compatibility_score, priceId)
    const { name, email, arch, archetype, price, calculation_id, compatibility_score, priceId } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }

    const archetypeValue = arch ?? archetype ?? '';

    // priceId field (new quiz) can override the legacy 'price' key lookup if provided
    const priceKey = String(price || '5');

    let amountInfo;
    try {
      amountInfo = await getAmountFromPriceKey(priceKey);
    } catch (err) {
      console.error('Error resolving price:', err);
      return res.status(500).json({ error: 'Price configuration error' });
    }

    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    let customer;
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({
        email,
        name: name || '',
        metadata: { arch: archetypeValue, selected_price: priceKey },
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInfo.amount,
      currency: amountInfo.currency,
      receipt_email: email,
      automatic_payment_methods: { enabled: true },
      customer: customer.id,
      setup_future_usage: 'off_session',
      metadata: {
        // Legacy fields — kept for old quiz backward compatibility
        name:                name || '',
        email,
        arch:                archetypeValue,
        selected_price:      priceKey,
        price_id:            amountInfo.stripePriceId,
        // New compatibility quiz fields (empty string when not sent by old quizzes)
        calculation_id:      calculation_id             || '',
        compatibility_score: compatibility_score != null ? String(compatibility_score) : '',
      },
    });

    // Save email for abandoned-cart tracking
    if (calculation_id && email) {
      try { db.saveSessionEmail(calculation_id, email); } catch (_) {}
    }

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Unable to create payment intent' });
  }
});

// =====================================================
// 5) /create-subscription — подписка
// =====================================================
app.post('/create-subscription', async (req, res) => {
  try {
    const { paymentMethodId, name, email, arch, price } = req.body || {};

    if (!paymentMethodId || !email) {
      return res
        .status(400)
        .json({ error: 'Missing paymentMethodId or email' });
    }

    if (!SUBSCRIPTION_PRICE_ID) {
      return res
        .status(500)
        .json({ error: 'Missing SUBSCRIPTION_PRICE_ID in environment' });
    }

    // Ищем или создаём покупателя
    const existing = await stripe.customers.list({ email, limit: 1 });
    let customer = existing.data[0];

    if (!customer) {
      customer = await stripe.customers.create({
        email,
        name: name || '',
        metadata: {
          arch: arch || '',
          selected_price: String(price || ''),
        },
      });
    }

    // Привязываем payment method к покупателю
    try {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customer.id,
      });
    } catch (attachError) {
      if (!attachError || attachError.code !== 'resource_already_exists') {
        throw attachError;
      }
    }

    // Делаем его дефолтным
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const alreadySubscribed = await customerHasActiveSubscription(customer.id);
    if (alreadySubscribed) {
      console.log('ℹ️ Customer already subscribed via manual endpoint, skipping creation');
      return res.json({ status: 'already_subscribed' });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: SUBSCRIPTION_PRICE_ID }],
      default_payment_method: paymentMethodId,
      trial_period_days: SUBSCRIPTION_TRIAL_DAYS,
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        arch: arch || '',
        selected_price: String(price || ''),
        email,
        origin: 'manual_subscription_endpoint',
      },
    });

    res.json({
      subscriptionId: subscription.id,
      status: subscription.status,
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ error: 'Unable to create subscription' });
  }
});

// =====================================================
// 6) Простой healthcheck
// =====================================================
app.get('/', (req, res) => {
  res.send('Lignaggio backend is running');
});

// =====================================================
// NEW COMPATIBILITY QUIZ — GPT CONSULTATION GENERATION
// =====================================================

// ── GPT prompt helpers ────────────────────────────────────────────
const CONSULTATION_SYSTEM_PROMPT = `Sei un esperto di Matrice del Destino, astrologia e numerologia, specializzato nell'analisi della compatibilità di coppia. Unisci numerologia, astrologia e psicologia delle relazioni per produrre consulenze personali di altissimo livello — come un appuntamento privato con uno specialista da 150€.

PRINCIPI DI STILE OBBLIGATORI:
- Rivolgiti DIRETTAMENTE al cliente: usa "Lei", "il Suo partner", "nella vostra relazione".
- Chiama i partner SEMPRE per nome in ogni sezione — mai "Partner 1" o "Partner 2".
- Ogni affermazione è ancorata a un numero, un pianeta o un elemento astrologico calcolato dalla data di nascita.
- Crea l'effetto di riconoscimento: descrivi pattern specifici in cui la coppia si riconosce.
- Cornice mistica: karma, energie, vibrazioni, influenze planetarie — ma con profondità, non banalità.
- Raccomandazioni pratiche in ogni sezione.
- Paragrafi corti: massimo 3-4 frasi ciascuno.
- Usa \\n\\n per separare i paragrafi.

CALCOLI NUMEROLOGICI (eseguili tu prima di scrivere):
- Numero del Cammino di Vita = somma di tutte le cifre della data di nascita ridotta a cifra singola (eccetto master number 11, 22, 33).
- Numero di compatibilità della coppia = somma dei due Cammini di Vita ridotta a cifra singola (eccetto master number).
- Numero karmico = giorno di nascita P1 + giorno di nascita P2 ridotto a cifra singola.
- Numero dell'Anima = cifre del solo giorno di nascita di ciascun partner ridotte a cifra singola.

CALCOLI ASTROLOGICI (eseguili tu):
- Segno zodiacale di ogni partner dalla data di nascita.
- Elemento (Fuoco/Terra/Aria/Acqua) di ogni segno.
- Pianeta dominante di ogni segno.
- Compatibilità degli elementi tra i due partner.

REGOLE DI FORMATO ASSOLUTE:
- Rispondi ESCLUSIVAMENTE con JSON valido. Zero testo fuori dal JSON. Zero markdown. Zero commenti.
- Il JSON deve contenere ESATTAMENTE queste 10 chiavi, né più né meno:
  panorama, partner1, partner2, couple, anima, karma, intimita, finanze, potentiale, consiglio
- Ogni valore è una stringa con paragrafi separati da \\n\\n.
- Lingua: italiano. Registro formale ("Lei").
- Lunghezza totale di tutte le sezioni: 7000–9000 caratteri (con spazi).
- Limiti per sezione (caratteri con spazi): panorama 700-900, partner1 700-900, partner2 700-900, couple 800-1100, anima 700-900, karma 700-900, intimita 700-900, finanze 700-900, potentiale 700-900, consiglio 500-700.`;

const ARCH_LABELS = {
  1:'Iniziatore', 2:'Intuito', 3:'Creativo', 4:'Costruttore', 5:'Avventuriero',
  6:'Armonizzatore', 7:'Ricercatore', 8:'Potere', 9:'Umanitario', 10:'Completamento',
  11:'Illuminato', 12:'Sacrificio', 13:'Trasformazione', 14:'Adattamento',
  15:'Abbondanza', 16:'Risveglio', 17:'Stella', 18:'Illusione', 19:'Sole',
  20:'Giudizio', 21:'Mondo', 22:'Costruttore Maestro',
};

function buildConsultationPrompt(data) {
  const p1     = data.partner1     || {};
  const p2     = data.partner2     || {};
  const compat = data.compatibility || {};

  const name1   = p1.name      || 'Partner 1';
  const name2   = p2.name      || 'Partner 2';
  const birth1  = p1.birthDate || 'sconosciuta';
  const birth2  = p2.birthDate || 'sconosciuta';
  const gender1 = p1.gender    || 'non specificato';
  const gender2 = p2.gender    || 'non specificato';

  const arch1   = compat.partner1Archetype      || '?';
  const arch2   = compat.partner2Archetype      || '?';
  const archC   = compat.compatibilityArchetype || '?';
  const a1Label = ARCH_LABELS[arch1] || String(arch1);
  const a2Label = ARCH_LABELS[arch2] || String(arch2);
  const acLabel = ARCH_LABELS[archC] || String(archC);
  const score   = compat.compatibilityScore != null ? compat.compatibilityScore : 'non calcolato';

  // Include quiz context if available
  const quizContext = data.quizContext || [];
  let quizBlock = '';
  if (quizContext.length > 0) {
    const lines = quizContext.map(function (a) {
      return '- ' + (a.questionText || a.questionId) + ': ' + (a.selectedAnswerText || a.selectedAnswerKey);
    }).join('\n');
    quizBlock = '\n\n═══ RISPOSTE AL QUIZ ═══\n' + lines;
  }

  return `Genera una consulenza di compatibilità premium, in italiano (registro formale "Lei"), per la seguente coppia.

═══ DATI DI INPUT ═══

PARTNER 1
Nome: ${name1}
Data di nascita: ${birth1}
Genere: ${gender1}
Archetipo: ${a1Label} (n. ${arch1})

PARTNER 2
Nome: ${name2}
Data di nascita: ${birth2}
Genere: ${gender2}
Archetipo: ${a2Label} (n. ${arch2})

COPPIA
Archetipo di coppia: ${acLabel} (n. ${archC})
Score di compatibilità: ${score}%${quizBlock}

═══ ISTRUZIONI PER OGNI SEZIONE ═══

panorama — Quadro d'insieme del legame. Entrambi i nomi obbligatori. Descrivi il tipo di legame (karmico, destinale, trasformazionale). Cita il numero di compatibilità della coppia calcolato e il suo significato. Compatibilità degli elementi zodiacali. Tono di apertura: "Il vostro incontro non è casuale. Il numero della vostra compatibilità è [X], il che significa…"

partner1 — Rivolgersi direttamente a ${name1} con "Lei". Numero del Cammino di Vita + segno zodiacale + pianeta dominante + archetipo. Ruolo che ${name1} porta nella coppia. Punti di forza e sfide. Tono: "${name1}, il Suo Cammino di Vita porta il numero [X]…"

partner2 — Descrivere ${name2} attraverso come influenza ${name1} e la dinamica di coppia. Numero del Cammino + segno zodiacale + elemento + pianeta. Tono: "${name2} è entrato/a nella vita di ${name1} con un motivo preciso. Il suo segno [segno] porta l'energia di [pianeta]…"

couple — La dinamica di coppia come entità. Archetipi + elementi + numero di compatibilità. Ruoli naturali, punti di forza e zone di tensione. Raccomandazione concreta. Tono: "Quando ${name1} e ${name2} sono insieme, si genera l'energia del numero [X]…"

anima — Legame spirituale ed emotivo profondo. Numero karmico calcolato. Perché si sono incontrati a livello d'anima. Quale lezione reciproca. Tono: "Il numero karmico della vostra unione è [X]. A livello d'anima vi siete incontrati per…"

karma — Componente karmica della relazione. Cosa sciogliere o trasformare. Lezioni di vite passate riflesse nell'archetipo. Raccomandazione. Tono: "L'archetipo [X] rispecchia un debito karmico che le vostre anime stanno lavorando a sciogliere…"

intimita — Dinamica intima attraverso elementi e numeri dell'anima. Attrazione e polarità. Come mantenere la connessione. Cosa può raffreddarla. Tono: "L'elemento di ${name1} è [X], quello di ${name2} è [Y]. Insieme creano…"

finanze — Vita materiale e finanziaria della coppia. Numeri di vita applicati all'abbondanza. Chi gestisce, chi ispira. Raccomandazione pratica. Tono: "L'energia finanziaria è determinata dal numero [X] che governa la vostra coppia. Per ${name1} e ${name2} l'abbondanza arriva attraverso…"

potentiale — Futuro della coppia. Verso dove porta il cammino comune. Cosa si sblocca superando le sfide karmiche. Visione più alta. Tono: "Il potenziale evolutivo della vostra unione porta il numero [X]. Se attraverserete…"

consiglio — 3 consigli concreti, ciascuno ancorato a un numero o pianeta. Messaggio finale caldo e incoraggiante. Tono: "${name1} e ${name2}, ecco tre indicazioni pratiche: 1. … 2. … 3. … Il vostro incontro è un dono."

═══ REQUISITI FINALI ═══
- Totale: 7000–9000 caratteri con spazi. Rispetta i limiti per sezione.
- Usa i nomi ${name1} e ${name2} in ogni sezione.
- Calcola correttamente i numeri numerologici e i segni zodiacali dalle date di nascita fornite.
- Ogni affermazione ancorata a numero, pianeta o elemento calcolato.
- Rispondi SOLO con JSON valido, esattamente 10 chiavi.`;
}

// ── Preview system prompt (short, 4 sections, generated BEFORE payment) ──────
const PREVIEW_SYSTEM_PROMPT = `Sei un esperto di Matrice del Destino, astrologia e numerologia. Genera un'anteprima breve e intrigante di una consulenza di compatibilità, in italiano (registro formale "Lei").

REQUISITI:
- 4 sezioni: anima, karma, intimita, finanze. Ciascuna 200–300 caratteri.
- Ogni sezione: densa, evocativa, specifica per la coppia. Usa i NOMI dei partner.
- L'ultima frase di ogni sezione si interrompe nel momento più interessante — crea curiosità irresistibile, invoglia a sbloccare la versione completa.
- Tono: caldo, esperto, leggermente misterioso. Come un assaggio da 150€.
- Rispondi ESCLUSIVAMENTE con JSON valido. Zero testo fuori dal JSON.
- Il JSON deve contenere ESATTAMENTE queste 4 chiavi: anima, karma, intimita, finanze
- Lingua: italiano.`;

function buildPreviewPrompt(data) {
  const p1     = data.partner1     || {};
  const p2     = data.partner2     || {};
  const compat = data.compatibility || {};

  const name1   = p1.name || 'Partner 1';
  const name2   = p2.name || 'Partner 2';
  const birth1  = p1.birthDate || 'sconosciuta';
  const birth2  = p2.birthDate || 'sconosciuta';
  const arch1   = compat.partner1Archetype      || '?';
  const arch2   = compat.partner2Archetype      || '?';
  const archC   = compat.compatibilityArchetype || '?';
  const a1Label = ARCH_LABELS[arch1] || String(arch1);
  const a2Label = ARCH_LABELS[arch2] || String(arch2);
  const acLabel = ARCH_LABELS[archC] || String(archC);
  const score   = compat.compatibilityScore != null ? compat.compatibilityScore : 'non calcolato';

  return `Anteprima per: ${name1} (nato/a ${birth1}, archetipo ${a1Label}) e ${name2} (nato/a ${birth2}, archetipo ${a2Label}).
Archetipo di coppia: ${acLabel}. Score di compatibilità: ${score}%.

Genera 4 sezioni anteprima (200–300 caratteri ciascuna) che usino i nomi reali, citino un numero o un elemento calcolato dalla data di nascita, e si interrompano sull'elemento più intrigante per spingere all'acquisto:
anima, karma, intimita, finanze

JSON valido, esattamente 4 chiavi.`;
}

// ── extractPreviewExcerpt — derives a teaser from a full consultation section ─
function extractPreviewExcerpt(text, maxChars = 350) {
  if (!text) return '';
  const first = text.split('\n\n')[0] || text;
  if (first.length <= maxChars) return first;
  const cut = first.slice(0, maxChars);
  return cut.replace(/\s+\S*$/, '') + '…';
}

// ── generatePreview — cheap 4-section preview, called BEFORE payment ──────────
async function generatePreview(data) {
  const response = await openai.chat.completions.create({
    model:                 'gpt-5.4',
    response_format:       { type: 'json_object' },
    temperature:           0.7,
    max_completion_tokens: 800,
    messages: [
      { role: 'system', content: PREVIEW_SYSTEM_PROMPT },
      { role: 'user',   content: buildPreviewPrompt(data) },
    ],
  });

  const raw    = response.choices[0].message.content;
  const parsed = JSON.parse(raw);

  const required = ['anima', 'karma', 'intimita', 'finanze'];
  const missing  = required.filter(k => !parsed[k]);
  if (missing.length > 0) {
    throw new Error('Preview missing keys: ' + missing.join(', '));
  }

  return {
    anima:    parsed.anima,
    karma:    parsed.karma,
    intimita: parsed.intimita,
    finanze:  parsed.finanze,
  };
}

// ── generateFullConsultation — full 10-section consultation, called AFTER payment ─
// Normally triggered from the Stripe webhook (fire-and-forget).
// Also available as a fallback from POST /api/generate-consultation.
// Returns true on success, false on failure. Never throws.

/**
 * Resolve partner data for a given calculation_id.
 * Checks in-memory cache first, then falls back to DB.
 * Retries up to maxRetries times with delayMs delay to handle the race
 * where the webhook fires before /api/generate-preview has committed.
 */
async function resolvePartnerDataWithRetry(calculationId, maxRetries, delayMs) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 1. In-memory cache
    const stored = generatedResults[calculationId];
    if (stored && stored._partnerData) {
      return { source: 'memory', stored };
    }

    // 2. DB
    try {
      const row = db.getSession(calculationId);
      if (row) {
        const compat  = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
        const preview = row.preview_json       ? JSON.parse(row.preview_json)       : {};
        const reconstructed = {
          calculationId,
          _partnerData: {
            partner1:      { name: row.partner1_name, gender: row.partner1_gender, birthDate: row.partner1_birth },
            partner2:      { name: row.partner2_name, gender: row.partner2_gender, birthDate: row.partner2_birth },
            compatibility: compat,
          },
          payment: {
            status:      row.payment_status,
            accessToken: row.access_token,
          },
          preview,
          result: { consultation: null, imageUrl: null, pdfUrl: null },
          compatibility: compat,
        };
        // Populate in-memory cache so future calls hit memory
        generatedResults[calculationId] = reconstructed;
        return { source: 'db', stored: reconstructed };
      }
    } catch (dbErr) {
      console.error('[resolvePartnerData] DB read error on attempt', attempt, ':', dbErr.message);
    }

    if (attempt < maxRetries) {
      console.log('[resolvePartnerData] Session not found yet, retrying (' + attempt + '/' + maxRetries + ') for:', calculationId);
      await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
    }
  }
  return null;
}

async function generateFullConsultation(calculationId) {
  console.log('[generateFullConsultation] Starting for calculation_id:', calculationId);

  // Retry up to 5 times with 1 s delay to handle race condition
  const resolved = await resolvePartnerDataWithRetry(calculationId, 5, 1000);
  if (!resolved) {
    console.error('[generateFullConsultation] Session not found after retries for:', calculationId);
    return false;
  }

  const { stored }    = resolved;
  const partnerData   = stored._partnerData;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // ── Single-step: Generate full consultation directly ──────────────
      // (Removed the separate outline step — saves ~15 seconds per generation)
      const response = await openai.chat.completions.create({
        model:                 'gpt-5.4',
        response_format:       { type: 'json_object' },
        temperature:           0.7,
        max_completion_tokens: 9000,
        messages: [
          { role: 'system', content: CONSULTATION_SYSTEM_PROMPT },
          { role: 'user',   content: buildConsultationPrompt(partnerData) },
        ],
      });

      const raw    = response.choices[0].message.content;
      const parsed = JSON.parse(raw);

      const required = ['panorama','partner1','partner2','couple','anima',
                        'karma','intimita','finanze','potentiale','consiglio'];
      const missing  = required.filter(k => !parsed[k]);

      if (missing.length > 0) {
        console.warn('[generateFullConsultation] Attempt', attempt, '— missing keys:', missing);
        continue;
      }

      // ── Persist consultation to DB ──────────────────────────────────────
      try {
        db.insertConsultation(calculationId, parsed, null, null);
        console.log('[db] Consultation saved for calculation_id:', calculationId);
      } catch (dbErr) {
        console.error('[generateFullConsultation] DB save error:', dbErr.message);
      }

      // ── Update in-memory cache ──────────────────────────────────────────
      if (!stored.result) {
        stored.result = { consultation: null, imagePrompt: null, imageUrl: null, pdfUrl: null };
      }
      stored.result.consultation = parsed;

      // Auto-send full consultation by email (fire-and-forget)
      sendConsultationEmail(calculationId, parsed, stored._partnerData).catch(function (err) {
        console.error('[email] sendConsultationEmail error for:', calculationId, err.message);
      });

      // Generate premium PDF (fire-and-forget)
      const pdfData = {
        partner1:      partnerData.partner1,
        partner2:      partnerData.partner2,
        compatibility: partnerData.compatibility,
        consultation:  parsed,
      };
      generatePremiumPDF(pdfData, calculationId).then(function (pdfPath) {
        console.log('[pdf] Premium PDF ready for:', calculationId, pdfPath);
        // Update DB pdf_url
        try {
          const existing = db.getConsultation(calculationId);
          if (existing) {
            db.insertConsultation(calculationId, parsed, null, pdfPath);
          }
        } catch (_) {}
      }).catch(function (err) {
        console.error('[pdf] generatePremiumPDF error for:', calculationId, err.message);
      });

      console.log('[FULL CONSULTATION GENERATED] calculation_id:', calculationId);
      return true;

    } catch (err) {
      console.error('[generateFullConsultation] Attempt', attempt, 'error:', err.message);
    }
  }

  console.error('[generateFullConsultation] All attempts failed for calculation_id:', calculationId);
  return false;
}

// ── Data validation ──────────────────────────────────────────────────────────
const ALLOWED_GENDERS = new Set(['m', 'f', 'male', 'female', 'uomo', 'donna',
  'altro', 'other', 'non-binary', 'non specificato']);

function validatePartner(partner, label) {
  if (!partner || typeof partner !== 'object') {
    return label + ': missing partner data';
  }
  const name = String(partner.name || '').trim();
  if (!name) { return label + ': missing name'; }
  if (name.length > 80) { return label + ': name too long (max 80 chars)'; }

  const birth = String(partner.birthDate || '').trim();
  if (!birth) { return label + ': missing birthDate'; }
  // Accept YYYY-MM-DD or DD/MM/YYYY
  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.test(birth);
  const itMatch  = /^\d{2}\/\d{2}\/\d{4}$/.test(birth);
  if (!isoMatch && !itMatch) { return label + ': invalid birthDate format'; }
  const d = new Date(isoMatch ? birth : birth.split('/').reverse().join('-'));
  if (isNaN(d.getTime())) { return label + ': invalid birthDate value'; }
  if (d.getFullYear() < 1900 || d > new Date()) { return label + ': birthDate out of range'; }

  const gender = String(partner.gender || '').trim().toLowerCase();
  if (!gender) { return label + ': missing gender'; }
  if (!ALLOWED_GENDERS.has(gender)) { return label + ': invalid gender value'; }

  return null; // valid
}

// ── POST /api/generate-preview ──────────────────────────────────────────────────
// Called during the analysis phase, BEFORE payment.
// Creates the stored entry and generates a short 4-section teaser preview.
app.post('/api/generate-preview', async (req, res) => {
  const { calculation_id, partner1, partner2, compatibility } = req.body || {};

  if (!calculation_id || !String(calculation_id).trim()) {
    return res.status(400).json({ success: false, error: 'missing_calculation_id' });
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const err1 = validatePartner(partner1, 'partner1');
  if (err1) { return res.status(400).json({ success: false, error: err1 }); }
  const err2 = validatePartner(partner2, 'partner2');
  if (err2) { return res.status(400).json({ success: false, error: err2 }); }

  console.log('[generate-preview] Request for calculation_id:', calculation_id);

  const compat = compatibility || {};

  // Return cached preview if already generated (check memory then DB)
  const existing = generatedResults[calculation_id];
  if (existing && existing.preview && existing.preview.anima) {
    console.log('[generate-preview] Memory cache hit for:', calculation_id);
    return res.json({ success: true, calculationId: calculation_id, cached: true, preview: existing.preview });
  }
  // Check DB cache
  try {
    const dbRow = db.getSession(calculation_id);
    if (dbRow && dbRow.preview_json) {
      const cachedPreview = JSON.parse(dbRow.preview_json);
      if (cachedPreview && cachedPreview.anima) {
        console.log('[generate-preview] DB cache hit for:', calculation_id);
        return res.json({ success: true, calculationId: calculation_id, cached: true, preview: cachedPreview });
      }
    }
  } catch (dbErr) {
    console.error('[generate-preview] DB cache check error:', dbErr.message);
  }

  // ── Insert session row in DB (idempotent: INSERT OR IGNORE) ───────────────
  try {
    db.insertSession(calculation_id, partner1, partner2, compat);
    console.log('[db] Session inserted for calculation_id:', calculation_id);
  } catch (dbErr) {
    console.error('[generate-preview] DB insert error:', dbErr.message);
  }

  // ── Create or refresh in-memory entry ────────────────────────────────────
  if (!generatedResults[calculation_id]) {
    generatedResults[calculation_id] = {
      calculationId: calculation_id,
      _partnerData:  { partner1: partner1 || {}, partner2: partner2 || {}, compatibility: compat },
      payment: {
        status:          'pending',
        paymentIntentId: null,
        accessToken:     null,
        accessGrantedAt: null,
      },
      preview: {
        anima:    null,
        karma:    null,
        intimita: null,
        finanze:  null,
      },
      result: {
        consultation: null,
        imagePrompt:  null,
        imageUrl:     null,
        pdfUrl:       null,
      },
      compatibility: {
        score:             compat.compatibilityScore    != null ? compat.compatibilityScore    : null,
        band:              compat.compatibilityBand     != null ? compat.compatibilityBand     : null,
        partner1Archetype: compat.partner1Archetype     != null ? compat.partner1Archetype     : null,
        partner2Archetype: compat.partner2Archetype     != null ? compat.partner2Archetype     : null,
      },
      createdAt: new Date().toISOString(),
    };
  } else {
    generatedResults[calculation_id]._partnerData = {
      partner1:      partner1 || {},
      partner2:      partner2 || {},
      compatibility: compat,
    };
  }

  try {
    const data    = { partner1: partner1 || {}, partner2: partner2 || {}, compatibility: compat };
    const preview = await generatePreview(data);

    // Persist preview to DB
    try {
      db.updateSessionPreview(calculation_id, preview);
      console.log('[db] Preview saved for calculation_id:', calculation_id);
    } catch (dbErr) {
      console.error('[generate-preview] DB preview save error:', dbErr.message);
    }

    generatedResults[calculation_id].preview = preview;

    console.log('[PREVIEW GENERATED] calculation_id:', calculation_id);
    return res.json({ success: true, calculationId: calculation_id, preview });
  } catch (err) {
    console.error('[generate-preview] Error:', err.message);
    return res.status(500).json({ success: false, error: 'preview_generation_failed' });
  }
});

// ── POST /api/generate-consultation ────────────────────────────────────────────
// Requires payment to be confirmed (payment.status === 'paid').
// Full consultation is normally triggered automatically via the Stripe webhook.
// This endpoint is a POST-PAYMENT FALLBACK.
app.post('/api/generate-consultation', async (req, res) => {
  const { calculation_id } = req.body || {};

  if (!calculation_id || !String(calculation_id).trim()) {
    return res.status(400).json({ success: false, error: 'missing_calculation_id' });
  }

  console.log('[generate-consultation] Request for calculation_id:', calculation_id);

  // Resolve stored entry from memory or DB
  let stored = generatedResults[calculation_id];
  if (!stored) {
    try {
      const row = db.getSession(calculation_id);
      if (row) {
        const compat  = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
        const preview = row.preview_json       ? JSON.parse(row.preview_json)       : {};
        stored = {
          calculationId: row.id,
          _partnerData: {
            partner1:      { name: row.partner1_name, gender: row.partner1_gender, birthDate: row.partner1_birth },
            partner2:      { name: row.partner2_name, gender: row.partner2_gender, birthDate: row.partner2_birth },
            compatibility: compat,
          },
          payment:       { status: row.payment_status, accessToken: row.access_token },
          preview,
          result:        { consultation: null, imageUrl: null, pdfUrl: null },
          compatibility: compat,
        };
        generatedResults[calculation_id] = stored;
      }
    } catch (dbErr) {
      console.error('[generate-consultation] DB read error:', dbErr.message);
    }
  }

  if (!stored) {
    console.warn('[generate-consultation] No session found for calculation_id:', calculation_id);
    return res.status(400).json({ success: false, error: 'preview_required' });
  }

  // Guard: full consultation only generated after confirmed payment
  const paymentStatus = (stored.payment && stored.payment.status)
    || (stored.resultAccess && stored.resultAccess.paymentStatus)
    || 'pending';

  if (paymentStatus !== 'paid') {
    console.warn('[generate-consultation] Payment not confirmed for calculation_id:', calculation_id);
    return res.status(402).json({ success: false, error: 'payment_required' });
  }

  // Check if consultation already exists in DB or memory
  if (stored.result && stored.result.consultation) {
    console.log('[generate-consultation] Consultation already in memory for:', calculation_id);
    return res.json({ success: true, calculationId: calculation_id, cached: true });
  }
  try {
    const dbConsult = db.getConsultation(calculation_id);
    if (dbConsult && dbConsult.consultation_json) {
      console.log('[generate-consultation] Consultation already in DB for:', calculation_id);
      return res.json({ success: true, calculationId: calculation_id, cached: true });
    }
  } catch (dbErr) {
    console.error('[generate-consultation] DB consultation check error:', dbErr.message);
  }

  // Payment confirmed but consultation missing — generate now (fallback)
  console.log('[generate-consultation] Generating (post-payment fallback) for:', calculation_id);
  const ok = await generateFullConsultation(calculation_id);
  if (!ok) {
    return res.status(500).json({ success: false, error: 'generation_failed' });
  }
  return res.json({ success: true, calculationId: calculation_id });
});

// ── GET /api/result?cid=... ────────────────────────────────────────
app.get('/api/result', async (req, res) => {
  const { cid, token } = req.query;

  if (!cid || !String(cid).trim()) {
    return res.status(400).json({ success: false, error: 'missing_calculation_id' });
  }

  console.log('[api/result] Fetching result for cid:', cid);

  try {
    // ── Resolve stored entry: memory → DB ─────────────────────────────────
    let stored = generatedResults[cid];

    if (!stored) {
      const row = db.getSession(cid);
      if (!row) {
        console.log('[api/result] Session not found for cid:', cid);
        return res.status(404).json({ success: false, error: 'result_not_found' });
      }

      const compat  = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
      const preview = row.preview_json       ? JSON.parse(row.preview_json)       : {};

      // Check db for consultation
      let consultation = null;
      try {
        const consultRow = db.getConsultation(cid);
        if (consultRow && consultRow.consultation_json) {
          consultation = JSON.parse(consultRow.consultation_json);
        }
      } catch (_) {}

      stored = {
        calculationId: row.id,
        _partnerData: {
          partner1:      { name: row.partner1_name, gender: row.partner1_gender, birthDate: row.partner1_birth },
          partner2:      { name: row.partner2_name, gender: row.partner2_gender, birthDate: row.partner2_birth },
          compatibility: compat,
        },
        payment:       { status: row.payment_status, accessToken: row.access_token },
        preview,
        result:        { consultation, imageUrl: null, pdfUrl: null },
        compatibility: compat,
      };
      // Populate memory cache
      generatedResults[cid] = stored;
    } else {
      // If in memory but consultation missing, also check DB
      if (!stored.result || !stored.result.consultation) {
        try {
          const consultRow = db.getConsultation(cid);
          if (consultRow && consultRow.consultation_json) {
            if (!stored.result) { stored.result = {}; }
            stored.result.consultation = JSON.parse(consultRow.consultation_json);
          }
        } catch (_) {}
      }
      // Also sync payment status from DB (ensures webhook updates are reflected)
      try {
        const dbRow = db.getSession(cid);
        if (dbRow && dbRow.payment_status === 'paid' &&
            stored.payment && stored.payment.status !== 'paid') {
          stored.payment.status      = 'paid';
          stored.payment.accessToken = dbRow.access_token;
        }
      } catch (_) {}
    }

    // ── Resolve payment status ──────────────────────────────────────────────
    const access        = stored.payment || stored.resultAccess || null;
    const paymentStatus = (access && (access.status || access.paymentStatus)) || 'pending';

    // ── Compatibility output ────────────────────────────────────────────────
    const compatOut = stored.compatibility || {};

    // ── UNPAID: only return preview ───────────────────────────────────────
    if (paymentStatus !== 'paid') {
      console.log('[api/result] Payment pending — returning preview only for cid:', cid);
      return res.json({
        success:       true,
        calculationId: stored.calculationId,
        paymentStatus: 'pending',
        resultReady:   false,
        preview:       stored.preview || {},
        compatibility: compatOut,
      });
    }

    // ── PAID: verify token if provided ────────────────────────────────────
    if (token) {
      const storedToken = access && access.accessToken;
      if (!storedToken || token !== storedToken) {
        console.log('[api/result] Invalid token for cid:', cid);
        return res.status(403).json({ success: false, error: 'invalid_token' });
      }
    }

    // ── Resolve consultation ──────────────────────────────────────────────
    const consultation = (stored.result && stored.result.consultation) || stored.consultation || null;
    const resultLocked = stored.result || {};
    const resultReady  = consultation !== null;

    console.log('[api/result] Access granted for cid:', cid, '— resultReady:', resultReady);

    res.json({
      success:       true,
      calculationId: stored.calculationId,
      paymentStatus: 'paid',
      resultReady,
      compatibility: compatOut,
      consultation,
      preview:       stored.preview || {},
      imageUrl:      resultLocked.imageUrl || null,
      pdfUrl:        resultLocked.pdfUrl   || null,
    });

  } catch (err) {
    console.error('[api/result] error:', err.message);
    res.status(500).json({ success: false, error: 'server_error' });
  }
});

// =====================================================
// GET /health — system health check
// =====================================================
app.get('/health', function (req, res) {
  const stripeReady = Boolean(process.env.STRIPE_SECRET_KEY);
  const openaiReady = Boolean(process.env.OPENAI_API_KEY);

  let dbReady = false;
  try {
    // A lightweight read to confirm DB is reachable
    db.getSession('__health_probe__');
    dbReady = true;
  } catch (_) {
    dbReady = false;
  }

  res.json({
    status:   'ok',
    stripe:   stripeReady,
    openai:   openaiReady,
    database: dbReady,
  });
});

// =====================================================
// AUTOMATED EMAILS — nodemailer
// =====================================================
const nodemailer = require('nodemailer');

const SITE_URL = process.env.SITE_URL || 'https://lignaggio.it';

const CONSULT_SECTION_ORDER = [
  'panorama','partner1','partner2','couple',
  'anima','karma','intimita','finanze','potentiale','consiglio',
];
const CONSULT_SECTION_TITLES = {
  panorama:   'Panorama della coppia',
  partner1:   'Ritratto di {p1}',
  partner2:   'Ritratto di {p2}',
  couple:     'Il campo energetico della coppia',
  anima:      'Dinamica Anima / Animus',
  karma:      'Fili karmici',
  intimita:   'Intimità',
  finanze:    'Finanze e valori materiali',
  potentiale: 'Potenziale evolutivo',
  consiglio:  'Consiglio',
};

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _buildConsultBody(consultation, p1Name, p2Name) {
  let html = '';
  for (const key of CONSULT_SECTION_ORDER) {
    const text = consultation[key];
    if (!text) continue;
    const title = (CONSULT_SECTION_TITLES[key] || key)
      .replace('{p1}', escapeHtml(p1Name))
      .replace('{p2}', escapeHtml(p2Name));
    const paragraphs = String(text).split('\n\n').map(function (p) {
      return '<p style="margin:0 0 12px">' + escapeHtml(p.trim()) + '</p>';
    }).join('');
    html += `
      <div style="margin-bottom:28px">
        <h3 style="color:#6b21a8;margin:0 0 10px;font-size:16px">${title}</h3>
        ${paragraphs}
      </div>`;
  }
  return html;
}

function _createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.ionos.it',
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendEmail({ to, subject, html, attachments }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[email] SMTP_USER/SMTP_PASS not configured — email not sent to', to);
    return;
  }
  const transporter = _createTransporter();
  const mailOptions = {
    from:    '"Quiz Test di Compatibilità dei Partner" <' + process.env.SMTP_USER + '>',
    to,
    subject,
    html,
  };
  if (Array.isArray(attachments) && attachments.length > 0) {
    mailOptions.attachments = attachments;
  }
  await transporter.sendMail(mailOptions);
  console.log('[email] Sent to', to, '—', subject);
}

async function sendConsultationEmail(calculationId, consultation, partnerData) {
  const emailRow   = db.getSessionEmail(calculationId);
  if (!emailRow || !emailRow.email) return;
  if (emailRow.thank_you_sent) return;

  const p1     = (partnerData && partnerData.partner1) || {};
  const p2     = (partnerData && partnerData.partner2) || {};
  const p1Name = p1.name || 'Partner 1';
  const p2Name = p2.name || 'Partner 2';
  const compat = (partnerData && partnerData.compatibility) || {};
  const score  = compat.compatibilityScore != null ? compat.compatibilityScore + '%' : null;

  const resultUrl = SITE_URL + '/result-unlocked.html?cid=' + encodeURIComponent(calculationId);
  const bodyHtml  = _buildConsultBody(consultation, p1Name, p2Name);
  const bonusCode = db.getBonusCode(calculationId);

  const bonusBlock = bonusCode ? `
        <div style="margin:28px 0;padding:20px 24px;background:linear-gradient(135deg,#1e0533 0%,#3b0764 100%);border-radius:10px;border:1px solid rgba(167,139,250,0.3);text-align:center">
          <p style="margin:0 0 8px 0;color:#c4b5fd;font-size:13px;letter-spacing:0.08em;text-transform:uppercase">✦ Il tuo codice sconto esclusivo</p>
          <p style="margin:0 0 10px 0;font-family:monospace;font-size:26px;font-weight:700;letter-spacing:0.18em;color:#fff">${escapeHtml(bonusCode)}</p>
          <p style="margin:0;color:#a78bfa;font-size:13px">Usa questo codice per ottenere il <strong style="color:#fff">10% di sconto</strong> sul tuo prossimo acquisto su lignaggio.it</p>
        </div>` : '';

  const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:auto;color:#222;line-height:1.6">
      <div style="background:#6b21a8;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;font-size:20px;margin:0">✦ La tua consulenza di compatibilità è pronta</h1>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
        <p>Ciao <strong>${escapeHtml(p1Name)}</strong>,</p>
        <p>La consulenza completa per <strong>${escapeHtml(p1Name)}</strong> e <strong>${escapeHtml(p2Name)}</strong> è stata generata.${score ? ' Score di compatibilità: <strong>' + score + '</strong>.' : ''}</p>
        <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
        ${bodyHtml}
        <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
        ${bonusBlock}
        <p style="text-align:center;margin-top:24px">
          <a href="${resultUrl}" style="background:#6b21a8;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">
            Visualizza la consulenza online ✦
          </a>
        </p>
        <p style="margin-top:32px;font-size:12px;color:#999;text-align:center">
          © Quiz Test di Compatibilità dei Partner · lignaggio.it
        </p>
      </div>
    </div>`;

  await sendEmail({
    to:      emailRow.email,
    subject: 'Quiz Test di Compatibilità dei Partner – La tua consulenza è pronta',
    html,
  });
  db.markThankYouSent(calculationId);
}

async function sendAbandonedCartEmail(calculationId, email, p1Name, p2Name) {
  const resumeUrl = SITE_URL + '/offer.html?resume=' + encodeURIComponent(calculationId);
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:auto;color:#222;line-height:1.6">
      <div style="background:#6b21a8;padding:24px 32px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;font-size:20px;margin:0">✦ La tua consulenza ti aspetta</h1>
      </div>
      <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
        <p>Ciao,</p>
        <p>Hai completato il <strong>Quiz Test di Compatibilità dei Partner</strong> per <strong>${escapeHtml(p1Name || 'te')}</strong>${p2Name ? ' e <strong>' + escapeHtml(p2Name) + '</strong>' : ''}, ma non hai ancora sbloccato la consulenza completa.</p>
        <p>La tua analisi è ancora disponibile. Riprendi da dove ti eri fermato/a:</p>
        <p style="text-align:center;margin:28px 0">
          <a href="${resumeUrl}" style="background:#6b21a8;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:600;font-size:16px">
            Riprendi la consulenza →
          </a>
        </p>
        <p style="font-size:13px;color:#666">
          Il tuo score di compatibilità e tutti i dati inseriti sono stati salvati. Clicca il pulsante e sblocca subito la tua lettura personalizzata.
        </p>
        <p style="margin-top:32px;font-size:12px;color:#999;text-align:center">
          © Quiz Test di Compatibilità dei Partner · lignaggio.it
        </p>
      </div>
    </div>`;

  await sendEmail({
    to:      email,
    subject: 'Quiz Test di Compatibilità dei Partner – I tuoi risultati ti aspettano',
    html,
  });
  db.markAbandonedSent(calculationId);
}

async function checkAbandonedSessions() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  try {
    const candidates = db.getAbandonedCandidates(60 * 60 * 1000); // 1 hour
    for (const row of candidates) {
      try {
        await sendAbandonedCartEmail(
          row.calculation_id,
          row.email,
          row.partner1_name || '',
          row.partner2_name || '',
        );
      } catch (err) {
        console.error('[abandoned-cart] Error sending to', row.email, err.message);
      }
    }
  } catch (err) {
    console.error('[abandoned-cart] checkAbandonedSessions error:', err.message);
  }
}

setInterval(checkAbandonedSessions, 5 * 60 * 1000); // every 5 minutes

// ── GET /api/session/:calculationId — public session resume ──────────────────
app.get('/api/session/:calculationId', function (req, res) {
  const calculationId = String(req.params.calculationId || '').trim();
  if (!calculationId) {
    return res.status(400).json({ error: 'Missing calculationId' });
  }

  const row = db.getSession(calculationId);
  if (!row) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const compat = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
  const preview = row.preview_json ? JSON.parse(row.preview_json) : null;

  res.json({
    success: true,
    session: {
      calculationId,
      partner1: {
        name:      row.partner1_name   || '',
        gender:    row.partner1_gender || '',
        birthDate: row.partner1_birth  || '',
      },
      partner2: {
        name:      row.partner2_name   || '',
        gender:    row.partner2_gender || '',
        birthDate: row.partner2_birth  || '',
      },
      compatibility: compat,
      preview:       preview,
      paymentStatus: row.payment_status || 'pending',
    },
  });
});

// =====================================================
// GET /api/report/:calculation_id — Download premium PDF
// =====================================================
app.get('/api/report/:calculation_id', function (req, res) {
  const calculationId = String(req.params.calculation_id || '').trim();
  if (!calculationId) {
    return res.status(400).json({ error: 'Missing calculation_id' });
  }

  // Verify payment
  const row = db.getSession(calculationId);
  if (!row) {
    return res.status(404).json({ error: 'Session not found' });
  }
  if (row.payment_status !== 'paid') {
    return res.status(402).json({ error: 'Payment required' });
  }

  const path = require('path');
  const fs   = require('fs');
  const pdfPath = path.join(__dirname, '..', 'storage', 'reports', 'report_' + calculationId + '.pdf');

  if (!fs.existsSync(pdfPath)) {
    // PDF not yet ready — try to generate it now (await)
    const consulRow = db.getConsultation(calculationId);
    if (!consulRow) {
      return res.status(404).json({ error: 'Consultation not ready yet. Try again in a few seconds.' });
    }
    const consultation = JSON.parse(consulRow.consultation_json);
    const compat  = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
    const pdfData = {
      partner1:      { name: row.partner1_name, birthDate: row.partner1_birth, gender: row.partner1_gender },
      partner2:      { name: row.partner2_name, birthDate: row.partner2_birth, gender: row.partner2_gender },
      compatibility: compat,
      consultation,
    };
    generatePremiumPDF(pdfData, calculationId).then(function () {
      const download = String(req.query.download || '') === 'true';
      const p1 = row.partner1_name ? row.partner1_name.replace(/\s+/g, '-') : 'report';
      const p2 = row.partner2_name ? row.partner2_name.replace(/\s+/g, '-') : '';
      const rawFilename = 'Consulenza-' + p1 + (p2 ? '-' + p2 : '') + '.pdf';
      const asciiFilename = rawFilename.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '-') || 'Consulenza-report.pdf';
      const encodedFilename = encodeURIComponent(rawFilename);
      const disposition = download ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', disposition + '; filename="' + asciiFilename + '"; filename*=UTF-8\'\'' + encodedFilename);
      res.setHeader('Content-Type', 'application/pdf');
      res.sendFile(pdfPath);
    }).catch(function (err) {
      console.error('[api/report] PDF generation error:', err.message);
      res.status(500).json({ error: 'PDF generation failed: ' + err.message });
    });
    return;
  }

  const download = String(req.query.download || '') === 'true';
  const p1 = row.partner1_name ? row.partner1_name.replace(/\s+/g, '-') : 'report';
  const p2 = row.partner2_name ? row.partner2_name.replace(/\s+/g, '-') : '';
  const rawFilename = 'Consulenza-' + p1 + (p2 ? '-' + p2 : '') + '.pdf';
  const asciiFilename = rawFilename.replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, '-') || 'Consulenza-report.pdf';
  const encodedFilename = encodeURIComponent(rawFilename);
  const disposition = download ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', disposition + '; filename="' + asciiFilename + '"; filename*=UTF-8\'\'' + encodedFilename);
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(pdfPath);
});

// =====================================================
// ADMIN ROUTES — Basic Auth
// =====================================================
function adminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded  = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 1) { throw new Error('bad format'); }
    const email    = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      return next();
    }
  } catch (_) {}
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/admin/sessions', adminAuth, function (req, res) {
  try {
    const sessions = db.getAllSessions();
    // Auto-assign bonus codes for paid sessions that were created before this feature
    for (const s of sessions) {
      if (s.payment_status === 'paid' && !s.bonus_code) {
        s.bonus_code = db.saveBonusCode(s.id, generateServerBonusCode());
      }
    }
    res.json({ success: true, sessions });
  } catch (err) {
    console.error('[admin/sessions]', err.message);
    res.status(500).json({ success: false, error: 'server_error' });
  }
});

// Public endpoint: return bonus code for a calculation_id (no auth)
app.get('/api/bonus-code', function (req, res) {
  const cid = String(req.query.cid || '').trim();
  if (!cid) { return res.status(400).json({ success: false, error: 'missing_cid' }); }
  try {
    const code = db.getBonusCode(cid);
    if (!code) { return res.status(404).json({ success: false, error: 'not_found' }); }
    res.json({ success: true, bonus_code: code });
  } catch (err) {
    console.error('[bonus-code]', err.message);
    res.status(500).json({ success: false, error: 'server_error' });
  }
});

app.get('/api/admin/session/:id', adminAuth, function (req, res) {
  try {
    const id      = String(req.params.id || '').trim();
    const session = db.getAdminSession(id);
    if (!session) { return res.status(404).json({ success: false, error: 'Not found' }); }
    res.json({ success: true, session });
  } catch (err) {
    console.error('[admin/session]', err.message);
    res.status(500).json({ success: false, error: 'server_error' });
  }
});

app.post('/api/admin/send-email', adminAuth, async function (req, res) {
  const { calculation_id, type } = req.body || {};
  if (!calculation_id || !type) {
    return res.status(400).json({ success: false, error: 'Missing params' });
  }
  try {
    const row = db.getSession(calculation_id);
    if (!row) { return res.status(404).json({ success: false, error: 'Session not found' }); }

    if (type === 'thank_you' || type === 'consultation') {
      const consulRow = db.getConsultation(calculation_id);
      if (!consulRow) { return res.status(400).json({ success: false, error: 'No consultation yet' }); }
      const consultation = JSON.parse(consulRow.consultation_json);
      const compat = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
      // Force-send: temporarily clear thank_you_sent by calling the mailer directly
      const emailRow = db.getSessionEmail(calculation_id);
      if (!emailRow || !emailRow.email) { return res.status(400).json({ success: false, error: 'No email on record' }); }
      const p1Name = row.partner1_name || 'Partner 1';
      const p2Name = row.partner2_name || 'Partner 2';
      const score  = compat.compatibilityScore != null ? compat.compatibilityScore + '%' : null;
      const bonusCode = db.getBonusCode(calculation_id);
      const bonusBlockAdmin = bonusCode ? `
        <div style="margin:28px 0;padding:20px 24px;background:#f5f0ff;border:2px dashed #9333ea;border-radius:10px;text-align:center">
          <p style="margin:0 0 8px;font-size:13px;color:#6b21a8;font-weight:700;">&#127873; Bonus esclusivo per te</p>
          <p style="margin:0 0 12px;font-size:13px;color:#333">Usa questo codice per ottenere il <strong>10% di sconto</strong> sul corso <em>Matrice della Compatibilit&agrave;</em>:</p>
          <div style="display:inline-block;background:#fff;border:1.5px solid #9333ea;border-radius:8px;padding:10px 28px">
            <span style="font-family:monospace;font-size:28px;font-weight:900;letter-spacing:0.2em;color:#6b21a8">${escapeHtml(bonusCode)}</span>
          </div>
          <p style="margin:12px 0 0;font-size:11px;color:#888">Codice personale &middot; Valido fino al 31 maggio</p>
        </div>` : '';
      const resultUrl = SITE_URL + '/quiz-test/result-unlocked.html?cid=' + encodeURIComponent(calculation_id);
      const bodyHtml  = _buildConsultBody(consultation, p1Name, p2Name);
      await sendEmail({
        to:      emailRow.email,
        subject: 'Quiz Test di Compatibilità dei Partner – La tua consulenza è pronta',
        html: `<div style="font-family:sans-serif;max-width:640px;margin:auto;color:#222;line-height:1.6">
          <div style="background:#6b21a8;padding:24px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;font-size:20px;margin:0">✦ La tua consulenza di compatibilità è pronta</h1>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
            <p>Ciao <strong>${escapeHtml(p1Name)}</strong>,</p>
            <p>La consulenza completa per <strong>${escapeHtml(p1Name)}</strong> e <strong>${escapeHtml(p2Name)}</strong> è stata generata.${score ? ' Score di compatibilità: <strong>' + score + '</strong>.' : ''}</p>
            ${bonusBlockAdmin}
            <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
            ${bodyHtml}
            <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
            <p style="text-align:center">
              <a href="${resultUrl}" style="background:#6b21a8;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">Visualizza la consulenza online ✦</a>
            </p>
            <p style="margin-top:32px;font-size:12px;color:#999;text-align:center">© Quiz Test di Compatibilità dei Partner · lignaggio.it</p>
          </div>
        </div>`,
      });
    } else if (type === 'abandoned') {
      const emailRow = db.getSessionEmail(calculation_id);
      if (!emailRow || !emailRow.email) { return res.status(400).json({ success: false, error: 'No email on record' }); }
      await sendAbandonedCartEmail(calculation_id, emailRow.email, row.partner1_name, row.partner2_name);
    } else if (type === 'custom') {
      // Admin-composed custom email with optional PDF attachment
      const { to, subject, message, attach_pdf } = req.body;
      if (!to || !subject) { return res.status(400).json({ success: false, error: 'Missing to/subject' }); }
      let attachments = [];
      if (attach_pdf) {
        const consulRow = db.getConsultation(calculation_id);
        if (!consulRow) { return res.status(400).json({ success: false, error: 'No consultation — PDF cannot be generated' }); }
        const consultation = JSON.parse(consulRow.consultation_json);
        const compat       = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
        const p1Name       = row.partner1_name || 'Partner 1';
        const p2Name       = row.partner2_name || 'Partner 2';
        const { generatePDF } = require('../services/pdfGenerator');
        const pdfBuffer = await generatePDF({ calculationId: calculation_id, consultation, compatibility: compat, partner1Name: p1Name, partner2Name: p2Name });
        attachments = [{ filename: 'consulenza-compatibilita.pdf', content: pdfBuffer, contentType: 'application/pdf' }];
      }
      const bodyText = message
        ? message.replace(/\n/g, '<br>')
        : 'Messaggio dall\'amministratore del Quiz Test di Compatibilità dei Partner.';
      await sendEmail({
        to,
        subject,
        html: `<div style="font-family:sans-serif;max-width:640px;margin:auto;color:#222;line-height:1.6">
          <div style="background:#6b21a8;padding:24px 32px;border-radius:8px 8px 0 0">
            <h1 style="color:#fff;font-size:18px;margin:0">✦ Quiz Test di Compatibilità dei Partner</h1>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
            <p>${bodyText}</p>
            <p style="margin-top:32px;font-size:12px;color:#999;text-align:center">© Quiz Test di Compatibilità dei Partner · lignaggio.it</p>
          </div>
        </div>`,
        attachments,
      });
    } else {
      return res.status(400).json({ success: false, error: 'Unknown type' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/send-email]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/send-consultation', adminAuth, async function (req, res) {
  const { calculation_id } = req.body || {};
  if (!calculation_id) { return res.status(400).json({ success: false, error: 'Missing calculation_id' }); }
  try {
    const row = db.getSession(calculation_id);
    if (!row) { return res.status(404).json({ success: false, error: 'Session not found' }); }
    const consulRow = db.getConsultation(calculation_id);
    if (!consulRow) { return res.status(400).json({ success: false, error: 'No consultation' }); }
    const consultation = JSON.parse(consulRow.consultation_json);
    const compat = row.compatibility_json ? JSON.parse(row.compatibility_json) : {};
    const emailRow = db.getSessionEmail(calculation_id);
    if (!emailRow || !emailRow.email) { return res.status(400).json({ success: false, error: 'No email on record' }); }
    const p1Name   = row.partner1_name || 'Partner 1';
    const p2Name   = row.partner2_name || 'Partner 2';
    const score    = compat.compatibilityScore != null ? compat.compatibilityScore + '%' : null;
    const resultUrl = SITE_URL + '/quiz-test/result-unlocked.html?cid=' + encodeURIComponent(calculation_id);
    const bodyHtml  = _buildConsultBody(consultation, p1Name, p2Name);
    await sendEmail({
      to:      emailRow.email,
      subject: 'Quiz Test di Compatibilità dei Partner – La tua consulenza è pronta',
      html: `<div style="font-family:sans-serif;max-width:640px;margin:auto;color:#222;line-height:1.6">
        <div style="background:#6b21a8;padding:24px 32px;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;font-size:20px;margin:0">✦ La tua consulenza di compatibilità è pronta</h1>
        </div>
        <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
          <p>Ciao <strong>${escapeHtml(p1Name)}</strong>,</p>
          <p>La consulenza completa per <strong>${escapeHtml(p1Name)}</strong> e <strong>${escapeHtml(p2Name)}</strong> è stata generata.${score ? ' Score di compatibilità: <strong>' + score + '</strong>.' : ''}</p>
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
          ${bodyHtml}
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">
          <p style="text-align:center">
            <a href="${resultUrl}" style="background:#6b21a8;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600">Visualizza la consulenza online ✦</a>
          </p>
          <p style="margin-top:32px;font-size:12px;color:#999;text-align:center">© Quiz Test di Compatibilità dei Partner · lignaggio.it</p>
        </div>
      </div>`,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/send-consultation]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Delete a single session ────────────────────────────────────────────────
app.delete('/api/admin/session/:id', adminAuth, function (req, res) {
  const id = String(req.params.id || '').trim();
  if (!id) { return res.status(400).json({ success: false, error: 'Missing id' }); }
  try {
    db.deleteSession(id);
    res.json({ success: true });
  } catch (err) {
    console.error('[admin/delete-session]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Bulk-delete sessions ───────────────────────────────────────────────────
app.post('/api/admin/sessions/delete', adminAuth, function (req, res) {
  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) { return res.status(400).json({ success: false, error: 'No ids provided' }); }
  const errors = [];
  ids.forEach(function (id) {
    try { db.deleteSession(String(id).trim()); }
    catch (err) { errors.push(id + ': ' + err.message); }
  });
  if (errors.length) {
    return res.status(500).json({ success: false, error: errors.join('; ') });
  }
  res.json({ success: true, deleted: ids.length });
});

// ── Analytics stats routes ─────────────────────────────────────────────────
app.get('/api/admin/stats/overview', adminAuth, function (req, res) {
  try {
    const data = db.getStatsOverview();
    res.json(data);
  } catch (err) {
    console.error('[admin/stats/overview]', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/admin/stats/funnel', adminAuth, function (req, res) {
  try {
    const data = db.getStatsFunnel();
    res.json(data);
  } catch (err) {
    console.error('[admin/stats/funnel]', err.message);
    res.status(500).json({ stages: [] });
  }
});

app.get('/api/admin/stats/pages', adminAuth, function (req, res) {
  // Derive full quiz funnel pages from session data
  try {
    const overview = db.getStatsOverview();
    const quiz   = overview.visitors.total  || 0;
    const email  = overview.preview.total   || 0;
    const paid   = overview.payments.total  || 0;
    const consult = db.getStatsFunnel().stages.find(function(s){ return s.name === 'Consulenza generata'; });
    const consulted = (consult && consult.value) || 0;

    // Drop-off from previous step
    const pages = [
      { page: 'quiz-test/',                    label: 'Start — index.html',           views: quiz,     unique: quiz,     dropoff: 0 },
      { page: 'quiz-test/offer.html',           label: 'Offer page (email captured)',   views: email,    unique: email,    dropoff: quiz   > 0 ? Math.round((1 - email    / quiz)   * 100) : 0 },
      { page: 'quiz-test/result-unlocked.html', label: 'Result unlocked (paid)',        views: paid,     unique: paid,     dropoff: email  > 0 ? Math.round((1 - paid     / email)  * 100) : 0 },
      { page: 'quiz-test/consultation',         label: 'Consulenza generata',           views: consulted,unique: consulted,dropoff: paid   > 0 ? Math.round((1 - consulted/ paid)   * 100) : 0 },
    ];
    res.json({ pages });
  } catch (err) {
    console.error('[admin/stats/pages]', err.message);
    res.status(500).json({ pages: [] });
  }
});

app.get('/api/admin/stats/realtime', adminAuth, function (req, res) {
  try {
    const data = db.getStatsRealtime();
    res.json(data);
  } catch (err) {
    console.error('[admin/stats/realtime]', err.message);
    res.status(500).json({ active: 0 });
  }
});

app.get('/api/admin/stats/revenue-breakdown', adminAuth, function (req, res) {
  try {
    const data = db.getStatsRevenueBreakdown();
    res.json(data);
  } catch (err) {
    console.error('[admin/stats/revenue-breakdown]', err.message);
    res.status(500).json({ breakdown: [] });
  }
});

// =====================================================
// 7) Запуск сервера
// =====================================================
app.listen(PORT, () => {
  console.log('\n🚀 Server started — port ' + PORT);
  console.log('💾 Database connected — backend/database/quiz.db');
  console.log('💳 Stripe ready —', process.env.STRIPE_SECRET_KEY ? '✅' : '❌ KEY MISSING');
  console.log('🤖 OpenAI ready —', process.env.OPENAI_API_KEY    ? '✅' : '⚠️  KEY MISSING');
  console.log('🔔 Webhook secret —', process.env.STRIPE_WEBHOOK_SECRET ? '✅' : '⚠️  KEY MISSING');
  console.log('');
});
