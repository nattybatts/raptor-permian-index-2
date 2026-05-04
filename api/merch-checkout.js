// POST /api/merch-checkout
// Creates a Stripe Checkout session for merch purchases
// Accepts: { items: [{ priceId, quantity, productName }] }
// Legacy single-item: { priceId, productName } also still works

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const validPrices = [
    'price_1TSO1NDICXtS1HCGpMMGr8qq', // Black Hat $40
    'price_1TSO1lDICXtS1HCGNbWpDSK1', // White Hat $40
    'price_1TSO5eDICXtS1HCGR1R6WzU8', // Black Trucker Gold $50
    'price_1TSO8RDICXtS1HCGvPiQGGKQ', // White Trucker Black $50
    'price_1TSO80DICXtS1HCGpHEbD0vI', // Diesel Surcharge $40
  ];

  // Normalise to items array (support legacy single-item calls too)
  let items = [];
  if (req.body?.items) {
    items = req.body.items;
  } else if (req.body?.priceId) {
    items = [{ priceId: req.body.priceId, quantity: 1, productName: req.body.productName }];
  }

  if (!items.length) return res.status(400).json({ error: 'No items in cart' });

  // Validate all price IDs
  for (const item of items) {
    if (!validPrices.includes(item.priceId)) {
      return res.status(400).json({ error: `Invalid product: ${item.priceId}` });
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10) {
      return res.status(400).json({ error: 'Quantity must be between 1 and 10' });
    }
  }

  try {
    const params = new URLSearchParams({
      'mode': 'payment',
      'shipping_address_collection[allowed_countries][0]': 'US',
      'shipping_options[0][shipping_rate]': 'shr_1TSO0bDICXtS1HCGASkhU929',
      'success_url': 'https://www.permianraptorindex.com/merch?success=1',
      'cancel_url':  'https://www.permianraptorindex.com/merch?canceled=1',
      'metadata[type]': 'merch',
      'metadata[product_names]': items.map(i => `${i.quantity}x ${i.productName || i.priceId}`).join(', '),
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'link',
    });

    // Add line items
    items.forEach((item, i) => {
      params.set(`line_items[${i}][price]`, item.priceId);
      params.set(`line_items[${i}][quantity]`, String(item.quantity));
    });

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
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
