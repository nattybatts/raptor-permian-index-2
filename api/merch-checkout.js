// POST /api/merch-checkout
// Creates a Stripe Checkout session for merch purchases

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { priceId, productName } = req.body || {};
  if (!priceId) return res.status(400).json({ error: 'Price ID required' });

  // Validate price ID is one of our known products
  const validPrices = [
    'price_1TSO1NDICXtS1HCGpMMGr8qq', // Black Hat $40
    'price_1TSO1lDICXtS1HCGNbWpDSK1', // White Hat $40
    'price_1TSO5eDICXtS1HCGR1R6WzU8', // Black Trucker Gold $50
    'price_1TSO8RDICXtS1HCGvPiQGGKQ', // White Trucker Black $50
    'price_1TSO80DICXtS1HCGpHEbD0vI', // Diesel Surcharge $40
  ];
  if (!validPrices.includes(priceId)) {
    return res.status(400).json({ error: 'Invalid product' });
  }

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        'mode': 'payment',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'shipping_address_collection[allowed_countries][0]': 'US',
        'shipping_options[0][shipping_rate]': 'shr_1TSO0bDICXtS1HCGASkhU929',
        'success_url': 'https://www.permianraptorindex.com/merch?success=1',
        'cancel_url':  'https://www.permianraptorindex.com/merch?canceled=1',
        'metadata[product_name]': productName || 'Hat',
        'payment_method_types[0]': 'card',
        'payment_method_types[1]': 'link',
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
