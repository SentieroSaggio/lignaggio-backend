require('dotenv').config();

const express = require('express');
const path = require('path');
const Stripe = require('stripe');

const PRICE_MAP = {
  '5': process.env.PRICE_5_ID,
  '9': process.env.PRICE_9_ID,
  '13': process.env.PRICE_13_ID,
  '17.67': process.env.PRICE_1767_ID,
};

const app = express();
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
  throw new Error('Missing STRIPE_SECRET_KEY in .env');
}

const stripe = Stripe(stripeSecretKey);
const PORT = process.env.PORT || 4242;
const SUBSCRIPTION_PRICE_ID = process.env.SUBSCRIPTION_PRICE_ID;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/config', (req, res) => {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return res.status(500).json({ error: 'Missing STRIPE_PUBLISHABLE_KEY' });
  }
  res.json({ publishableKey });
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { name, email, arch, price } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }

    const priceKey = String(price || '5');
    const stripePriceId = PRICE_MAP[priceKey] || PRICE_MAP['5'];
    if (!stripePriceId) {
      return res.status(500).json({ error: 'Missing Stripe price configuration' });
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

app.post('/create-subscription', async (req, res) => {
  try {
    const { paymentMethodId, name, email, arch, price } = req.body || {};
    if (!paymentMethodId || !email) {
      return res.status(400).json({ error: 'Missing paymentMethodId or email' });
    }
    if (!SUBSCRIPTION_PRICE_ID) {
      return res.status(500).json({ error: 'Missing SUBSCRIPTION_PRICE_ID' });
    }

    const existing = await stripe.customers.list({ email, limit: 1 });
    let customer = existing.data[0];
    if (!customer) {
      customer = await stripe.customers.create({
        email,
        name: name || '',
      });
    }

    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    } catch (attachError) {
      if (attachError && attachError.code !== 'resource_already_exists') {
        throw attachError;
      }
    }

    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const selectedPriceValue = price ? String(price) : '5';

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: SUBSCRIPTION_PRICE_ID }],
      trial_period_days: 7,
      default_payment_method: paymentMethodId,
      metadata: {
        arch: arch ? String(arch) : '',
        selected_price: selectedPriceValue,
      },
      expand: ['latest_invoice.payment_intent'],
    });

    res.json({ subscriptionId: subscription.id, status: subscription.status });
  } catch (error) {
    console.error('Error creating subscription:', error);
    res.status(500).json({ error: 'Unable to create subscription' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
