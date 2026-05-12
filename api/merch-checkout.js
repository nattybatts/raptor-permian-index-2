// POST /api/merch-checkout
export default async function handler(req, res) {
if (req.method !== ‘POST’) return res.status(405).json({ error: ‘Method not allowed’ });

const items = (req.body || {}).items;
if (!items || !Array.isArray(items) || items.length === 0) {
return res.status(400).json({ error: ‘Price ID required’ });
}

const validPrices = [‘price_1TW1HiDICXtS1HCGkHNfRChb’];
for (const item of items) {
if (!validPrices.includes(item.priceId)) {
return res.status(400).json({ error: ‘Invalid product’ });
}
}

try {
const lineItemParams = {};
items.forEach((item, i) => {
lineItemParams[`line_items[${i}][price]`]    = item.priceId;
lineItemParams[`line_items[${i}][quantity]`] = String(item.quantity || 1);
});

```
const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({
    'mode': 'payment',
    ...lineItemParams,
    'success_url': 'https://www.permianraptorindex.com/merch?success=1',
    'cancel_url':  'https://www.permianraptorindex.com/merch?canceled=1',
  }),
});

const session = await r.json();
if (!r.ok) return res.status(500).json({ error: session.error?.message || 'Stripe error' });
return res.status(200).json({ url: session.url });
```

} catch (err) {
return res.status(500).json({ error: err.message });
}
}
