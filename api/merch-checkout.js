// POST /api/merch-checkout
// Creates a Stripe Checkout session for merch purchases
// Body: { items: [{ priceId, quantity, productName }] }

export default async function handler(req, res) {
if (req.method !== ‘POST’) return res.status(405).json({ error: ‘Method not allowed’ });

const body = req.body || {};
const items = body.items;

if (!items || !Array.isArray(items) || items.length === 0) {
return res.status(400).json({ error: ‘Price ID required’ });
}

// Validate all price IDs are known products
const validPrices = [
‘price_1TW1HiDICXtS1HCGkHNfRChb’, // Black Trucker Gold $45
];

for (const item of items) {
if (!validPrices.includes(item.priceId)) {
return res.status(400).json({ error: ‘Invalid product’ });
}
}

try {
const { default: Stripe } = await import(‘stripe’);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

```
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card', 'affirm'],
  allow_promotion_codes: true,
  line_items: items.map(item => ({
    price: item.priceId,
    quantity: item.quantity || 1,
  })),
  shipping_address_collection: {
    allowed_countries: ['US'],
  },
  shipping_options: [{
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: 0, currency: 'usd' },
      display_name: 'Free Shipping',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 7 },
        maximum: { unit: 'business_day', value: 14 },
      },
    },
  }],
  success_url: 'https://www.permianraptorindex.com/merch?success=1',
  cancel_url:  'https://www.permianraptorindex.com/merch?canceled=1',
});

return res.status(200).json({ url: session.url });
```

} catch (err) {
console.error(’[merch-checkout] error:’, err.message);
return res.status(500).json({ error: err.message });
}
}
