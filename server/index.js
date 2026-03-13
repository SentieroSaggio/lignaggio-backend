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
    methods: ['GET', 'POST'],
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
        if (calculationId) {
          console.log('[webhook] payment_intent.succeeded — calculation_id:', calculationId);
          markResultAsPaid(calculationId);
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
const CONSULTATION_SYSTEM_PROMPT = `Sei un consulente specializzato in psicologia delle relazioni di coppia di alto livello. La tua formazione integra psicologia analitica junghiana, psicologia dell'attaccamento, dinamiche di personalità, analisi archetipica e interpretazione numerologica come sistema simbolico di lettura dei pattern psicologici.

Ogni consulenza che produci ha il valore di una sessione professionale da 150€ o più. Il tono è quello di uno psicologo delle relazioni che interpreta dinamiche di personalità reali — mai un oroscopo, mai previsioni mistiche.

PRINCIPI DI STILE OBBLIGATORI:
- Usa un tono calmo, analitico, psicologico, intelligente e profondo.
- Evita assolutamente: "l'universo ha deciso", "il destino è scritto", "le stelle controllano", "la tua anima gemella", "vibrazione cosmica", "energia mistica" e simili.
- Usa invece: "questa dinamica appare spesso in coppie con questo pattern", "molte coppie con questa combinazione tendono a", "questo schema relazionale si manifesta tipicamente come", "dal punto di vista psicologico questa tensione indica".
- I numeri numerologici sono archetipi psicologici — interpretali come strutture di personalità, non come previsioni magiche.
- Ogni sezione deve sembrare scritta specificamente per QUESTA coppia — usa i loro nomi reali, fai riferimento alle date di nascita, integra i numeri archetipici come lenti psicologiche.
- Scrivi paragrafi brevi e chiari. Ogni frase porta peso e significato. Nessun riempitivo.
- Usa grassetto per insight chiave. Usa corsivo per momenti di riflessione profonda.
- Non ripetere mai le stesse frasi o metafore tra sezioni diverse.
- Il lettore deve finire la consulenza sentendosi: capito, rispecchiato, guidato, emotivamente coinvolto.

REGOLE DI FORMATO ASSOLUTE:
- Rispondi ESCLUSIVAMENTE con JSON valido. Zero testo fuori dal JSON. Zero markdown. Zero commenti.
- Il JSON deve contenere ESATTAMENTE queste 10 chiavi, né più né meno:
  panorama, partner1, partner2, couple, anima, karma, intimita, finanze, potentiale, consiglio
- Ogni valore è una stringa con paragrafi separati da \\n\\n.
- Lingua: italiano.
- Lunghezza target per ogni sezione: 1200–1800 caratteri. Totale consulenza: 2500–3500 parole.`;

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
  const score   = compat.compatibilityScore != null ? compat.compatibilityScore + '%' : 'non calcolato';

  return `Genera una consulenza di compatibilità di coppia privata e premium, in italiano, per la seguente coppia.

═══ DATI DI INPUT ═══

PARTNER 1
Nome: ${name1}
Data di nascita: ${birth1}
Genere: ${gender1}
Arcetipo: ${a1Label} (n. ${arch1})

PARTNER 2
Nome: ${name2}
Data di nascita: ${birth2}
Genere: ${gender2}
Arcetipo: ${a2Label} (n. ${arch2})

COPPIA
Arcetipo di coppia: ${acLabel} (n. ${archC})
Score di compatibilità: ${score}

═══ ISTRUZIONI OBBLIGATORIE PER OGNI SEZIONE ═══

panorama — Visione d'insieme dell'unione: l'energia archetipica che questa coppia porta nel mondo, il filo invisibile che li ha uniti, la natura profonda della loro risonanza vibrazionale. Mostra subito perché questa coppia è significativa.

partner1 — Ritratto psicologico profondo di ${name1}: le sue strutture archetipiche interiori, il suo stile relazionale, i suoi talenti e le sue ombre, il modo in cui ama e come reagisce alla vulnerabilità.

partner2 — Ritratto psicologico profondo di ${name2}: la sua struttura d'anima, il modo in cui porta la propria energia nella relazione, le sue risorse interiori e i pattern inconsci che emergono in coppia.

couple — Il campo energetico che si crea tra ${name1} e ${name2}: l'archetipo della loro unione, come si amplificano a vicenda, dove nasce attrito creativo e dove nasce armonia profonda, la firma vibrazionale della coppia come entità.

anima — La dinamica anima/animus tra loro: come si specchiano a livello inconscio, cosa ciascuno proietta sull'altro, il processo di individuazione che si attiva attraverso questa relazione specifica.

karma — I fili karmici tra ${name1} e ${name2}: schemi relazionali ereditati o portati da esperienze precedenti, le lezioni che sono qui per imparare insieme, ciò che devono sciogliere o trasformare come coppia.

intimita — La qualità dell'intimità emotiva e fisica: come si avvicinano alla vulnerabilità e alla fiducia, i linguaggi del corpo e dell'emozione che usano, la danza tra desiderio di vicinanza e bisogno di spazio.

finanze — La visione materiale e i valori pratici della coppia: come ${name1} e ${name2} si relazionano con il denaro, la sicurezza e l'abbondanza, dove le loro visioni si allineano e dove divergono.

potentiale — Il potenziale evolutivo insieme: cosa possono costruire, creare o trasformare come coppia, la traiettoria della loro crescita comune, la visione più alta che questa unione porta con sé.

consiglio — Consiglio sapiente, specifico e profondo per ${name1} e ${name2}: concreto, ancorato a tutto ciò che è emerso nelle sezioni precedenti. Non generico. Deve sentirsi come una guida personale da un consulente di fiducia che conosce davvero questa coppia.

═══ REQUISITI FINALI ═══

- Ogni sezione: punta a 1000–1500 caratteri.
- Usa i nomi ${name1} e ${name2} nelle sezioni rilevanti — non usare mai "Partner 1" o "Partner 2".
- Nessuna ripetizione meccanica di numeri o sistemi. Nessun cliché. Nessuna genericità.
- Ogni frase deve portare peso e significato specifico per questa coppia.
- Rispondi SOLO con JSON valido, esattamente 10 chiavi.`;
}

// ── Preview system prompt (short, 4 sections, generated BEFORE payment) ──────
const PREVIEW_SYSTEM_PROMPT = `Sei un consulente di relazioni di coppia di alto livello. Genera un'anteprima breve e intrigante di una consulenza di compatibilità, in italiano.

REQUISITI:
- Ogni sezione: 200–300 caratteri. Densa, evocativa, specifica per la coppia indicata.
- Nessun cliché. Ogni sezione deve sembrare un assaggio prezioso di una lettura premium da 150€.
- Il tono è caldo, intimo, leggermente misterioso — deve invogliare a leggere il resto.
- Rispondi ESCLUSIVAMENTE con JSON valido. Zero testo fuori dal JSON.
- Il JSON deve contenere ESATTAMENTE queste 4 chiavi: anima, karma, intimita, finanze
- Lingua: italiano.`;

function buildPreviewPrompt(data) {
  const p1     = data.partner1     || {};
  const p2     = data.partner2     || {};
  const compat = data.compatibility || {};

  const name1   = p1.name || 'Partner 1';
  const name2   = p2.name || 'Partner 2';
  const arch1   = compat.partner1Archetype      || '?';
  const arch2   = compat.partner2Archetype      || '?';
  const archC   = compat.compatibilityArchetype || '?';
  const a1Label = ARCH_LABELS[arch1] || String(arch1);
  const a2Label = ARCH_LABELS[arch2] || String(arch2);
  const acLabel = ARCH_LABELS[archC] || String(archC);
  const score   = compat.compatibilityScore != null ? compat.compatibilityScore + '%' : 'non calcolato';

  return `Anteprima per: ${name1} (archetipo ${a1Label}) e ${name2} (archetipo ${a2Label}).
Arcetipo di coppia: ${acLabel}. Score di compatibilità: ${score}.

anima — assaggio della dinamica anima/animus tra loro (200–300 caratteri)
karma — accenno ai fili karmici di questa coppia (200–300 caratteri)
intimita — nota sulla qualità dell'intimità emotiva (200–300 caratteri)
finanze — osservazione sui valori materiali condivisi (200–300 caratteri)

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
    model:                 'gpt-5-mini',
    response_format:       { type: 'json_object' },
    temperature:           0.8,
    max_completion_tokens: 600,
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
      const response = await openai.chat.completions.create({
        model:                 'gpt-5.1',
        response_format:       { type: 'json_object' },
        temperature:           0.85,
        max_completion_tokens: 8000,
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

async function sendEmail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[email] SMTP_USER/SMTP_PASS not configured — email not sent to', to);
    return;
  }
  const transporter = _createTransporter();
  await transporter.sendMail({
    from:    '"Quiz Test di Compatibilità dei Partner" <' + process.env.SMTP_USER + '>',
    to,
    subject,
    html,
  });
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
        <p style="text-align:center">
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
      const filename = 'Consulenza-' + p1 + (p2 ? '-' + p2 : '') + '.pdf';
      if (download) {
        res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      } else {
        res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
      }
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
  const filename = 'Consulenza-' + p1 + (p2 ? '-' + p2 : '') + '.pdf';
  if (download) {
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  } else {
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
  }
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
    res.json({ success: true, sessions });
  } catch (err) {
    console.error('[admin/sessions]', err.message);
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
    } else if (type === 'abandoned') {
      const emailRow = db.getSessionEmail(calculation_id);
      if (!emailRow || !emailRow.email) { return res.status(400).json({ success: false, error: 'No email on record' }); }
      await sendAbandonedCartEmail(calculation_id, emailRow.email, row.partner1_name, row.partner2_name);
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
