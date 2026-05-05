// POST /api/merch-checkout
// Creates a Stripe Checkout session for merch purchases
// Body: { items: [{ priceId, quantity, productName }] }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const items = body.items;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Price ID required' });
  }

  // Validate all price IDs are known products
  const validPrices = [
    'price_1TSO1NDICXtS1HCGpMMGr8qq', // Black Hat $40
    'price_1TSO1lDICXtS1HCGNbWpDSK1', // White Hat $40
    'price_1TSO5eDICXtS1HCGR1R6WzU8', // Black Trucker Gold $50
    'price_1TSO8RDICXtS1HCGvPiQGGKQ', // White Trucker Black $50
    'price_1TSO80DICXtS1HCGpHEbD0vI', // Diesel Surcharge $40
  ];

  for (const item of items) {
    if (!validPrices.includes(item.priceId)) {
      return res.status(400).json({ error: 'Invalid product' });
    }
  }

  try {
    // Build line_items params for each cart item
    const lineItemParams = {};
    items.forEach((item, i) => {
      lineItemParams[`line_items[${i}][price]`]    = item.priceId;
      lineItemParams[`line_items[${i}][quantity]`] = String(item.quantity || 1);
    });

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'payment',
        ...lineItemParams,
        'shipping_address_collection[allowed_countries][0]': 'US',
        'shipping_options[0][shipping_rate]': 'shr_1TSO0bDICXtS1HCGASkhU929',
        'success_url': 'https://www.permianraptorindex.com/merch?success=1',
        'cancel_url':  'https://www.permianraptorindex.com/merch?canceled=1',
        'payment_method_types[0]': 'card',
        'payment_method_types[1]': 'affirm',
      }),
    });

    const session = await r.json();
    if (!r.ok) {
      console.error('[merch-checkout] Stripe error:', session);
      return res.status(500).json({ error: session.error?.message || 'Stripe error' });
    }

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[merch-checkout] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
