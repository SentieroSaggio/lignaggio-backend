require('dotenv').config();

const express = require('express');
const path = require('path');
const Stripe = require('stripe');

// -----------------------------------------------------
// Конфиг цен (price_id берём из переменных окружения)
// -----------------------------------------------------
const PRICE_MAP = {
  '5': process.env.PRICE_5_ID,
  '9': process.env.PRICE_9_ID,
  '13': process.env.PRICE_13_ID,
  '17.67': process.env.PRICE_1767_ID,
};

const app = express();

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
if (!stripeSecretKey) {
  throw new Error('Missing STRIPE_SECRET_KEY in environment');
}

const stripe = Stripe(stripeSecretKey);

const PORT = process.env.PORT || 4242;
const SUBSCRIPTION_PRICE_ID = process.env.SUBSCRIPTION_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// =====================================================
// 1) WEBHOOK — ОБЯЗАТЕЛЬНО ДО ЛЮБЫХ app.use(...)
// =====================================================
/**
 * Очень важно:
 *  - для /webhook используем express.raw({ type: 'application/json' })
 *  - НИ ОДИН другой body-parser не должен применяться к этому маршруту.
 */
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
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
        break;
      }

      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log('✅ Checkout session completed:', session.id);
        break;
      }

      default:
        console.log(`ℹ️ Unhandled event type: ${event.type}`);
    }

    // Stripe ждёт 2xx, иначе будет считать, что webhook упал
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
    return res.status(500).json({ error: 'Missing STRIPE_PUBLISHABLE_KEY' });
  }
  res.json({ publishableKey });
});

// =====================================================
// 4) Создание PaymentIntent (разовый платёж)
// =====================================================
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { name, email, arch, price } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }

    const priceKey = String(price || '5');
    const stripePriceId = PRICE_MAP[priceKey] || PRICE_MAP['5'];

    if (!stripePriceId) {
      return res
        .status(500)
        .json({ error: 'Missing Stripe price configuration' });
    }

    const stripePrice = await stripe.prices.retrieve(stripePriceId);

    if (!stripePrice || typeof stripePrice.unit_amount !== 'number') {
      return res.status(500).json({ error: 'Stripe price unavailable' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: stripePrice.unit_amount,
      currency: stripePrice.currency || 'eur',
      automatic_payment_methods: { enabled: true },
      setup_future_usage: 'off_session',
      metadata: {
        email: email,
        name: name || '',
        arch: arch ? String(arch) : '',
        selected_price: priceKey,
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('Error creating PaymentIntent:', error);
    res.status(500).json({ error: 'Unable to create payment intent' });
  }
});

// =====================================================
// 5) Создание подписки
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
      });
    }

    // Привязываем способ оплаты
    try {
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customer.id,
      });
    } catch (attachError) {
      if (attachError && attachError.code !== 'resource_already_exists') {
        throw attachError;
      }
    }

    // Делаем его дефолтным
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const selectedPriceValue = price ? String(price) : '5';

    // Создаём подписку
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: SUBSCRIPTION_PRICE_ID },
      ],
      trial_period_days: 7,
      default_payment_method: paymentMethodId,
      metadata: {
        arch: arch ? String(arch) : '',
        selected_price: selectedPriceValue,
      },
      expand: ['latest_invoice.payment_intent'],
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
// 6) Запуск сервера
// =====================================================
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});