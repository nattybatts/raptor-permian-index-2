// POST /api/donation-webhook
// Stripe sends a webhook here after a successful payment
// Verifies the Stripe signature then records the donation in Supabase

import { supabase } from '../lib/supabase.js';

export const config = {
  api: { bodyParser: false }, // Must receive raw body for Stripe signature verification
};

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody  = await getRawBody(req);
  const sig      = req.headers['stripe-signature'];
  const secret   = process.env.STRIPE_WEBHOOK_SECRET;

  // Dynamically import stripe (keeps bundle small)
  let event;
  try {
    const { default: Stripe } = await import('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.error('Stripe webhook verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature invalid' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const amount  = session.amount_total || 0;
    const name    = session.metadata?.display_name || 'Anonymous';
    const message = session.metadata?.message      || null;

    const { error } = await supabase
      .from('donations')
      .insert({ amount_cents: amount, display_name: name, message });

    if (error) {
      console.error('Donation insert failed:', error.message);
      return res.status(500).json({ error: 'DB insert failed' });
    }

    console.log(`Donation recorded: $${(amount/100).toFixed(2)} from ${name}`);
  }

  return res.status(200).json({ received: true });
}
