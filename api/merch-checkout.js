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

  const validPrices = [
    'price_1TW1HiDICXtS1HCGkHNfRChb', // Black Trucker Gold $45
  ];

  for (const item of items) {
    if (!validPrices.includes(item.priceId)) {
      return res.status(400).json({ error: 'Invalid product' });
    }
  }

  try {
    const params = [
      ['mode', 'payment'],
      ['payment_method_types[0]', 'card'],
      ['payment_method_types[1]', 'affirm'],
      ['shipping_address_collection[allowed_countries][0]', 'US'],
      ['shipping_options[0][shipping_rate]', 'shr_1TWIGyDICXtS1HCGCYJsazDl'],
      ['success_url', 'https://www.permianraptorindex.com/merch?success=1'],
      ['cancel_url', 'https://www.permianraptorindex.com/merch?canceled=1'],
    ];

    items.forEach((item, i) => {
      params.push(['line_items[' + i + '][price]', item.priceId]);
      params.push(['line_items[' + i + '][quantity]', String(item.quantity || 1)]);
    });

    const encoded = params.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: encoded,
    });

    const session = await r.json();
    if (!r.ok) {
      console.error('[merch-checkout] Stripe error:', JSON.stringify(session));
      return res.status(500).json({ error: session.error?.message, param: session.error?.param, code: session.error?.code });
    }

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('[merch-checkout] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
