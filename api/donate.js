// POST /api/donate
// Body: { amount_cents: 500, display_name: "Roughneck Rick", message: "Keep it up" }
// Returns: { url: "https://checkout.stripe.com/..." }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let body;
  try { body = req.body; }
  catch { return res.status(400).json({ error: 'Invalid body' }); }

  const amount  = parseInt(body?.amount_cents);
  const name    = (body?.display_name || 'Anonymous').slice(0, 60);
  const message = (body?.message      || '').slice(0, 140);

  if (!amount || amount < 100 || amount > 50000) {
    return res.status(400).json({ error: 'Amount must be between $1 and $500' });
  }

  const { default: Stripe } = await import('stripe');
  const stripe   = new Stripe(process.env.STRIPE_SECRET_KEY);
  const baseUrl  = process.env.NEXT_PUBLIC_BASE_URL || `https://${req.headers.host}`;

  const session = await stripe.checkout.sessions.create({
    mode:          'payment',
    payment_method_types: ['card'], // Apple Pay & Google Pay auto-enable on compatible devices
    line_items: [{
      quantity: 1,
      price_data: {
        currency:     'usd',
        unit_amount:  amount,
        product_data: {
          name:        "Donate to @RealPETE2020's Ford Raptor Fund",
          description: 'Permian Raptor Index — keeping the lights on',
        },
      },
    }],
    metadata: { display_name: name, message },
    success_url: `${baseUrl}/?donated=1`,
    cancel_url:  `${baseUrl}/`,
  });

  return res.status(200).json({ url: session.url });
}
