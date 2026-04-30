// GET /api/vehicle?vin=1FTFW1RG2TFB03906
// Fetches live vehicle detail from Marketcheck for the popup
// Keeps API key server-side

export default async function handler(req, res) {
  const { vin } = req.query;

  if (!vin || vin.length !== 17) {
    return res.status(400).json({ error: 'Invalid VIN' });
  }

  // Sanitize VIN — alphanumeric only
  if (!/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
    return res.status(400).json({ error: 'Invalid VIN format' });
  }

  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');

  try {
    const params = new URLSearchParams({
      api_key: process.env.MARKETCHECK_API_KEY,
      vin:     vin.toUpperCase(),
      rows:    '1',
      fields:  'vin,heading,price,msrp,exterior_color,interior_color,dom,dom_180,vdp_url,dealer,build,in_transit,vehicle_status,first_seen_at_date,media',
    });

    const r = await fetch(
      `https://mc-api.marketcheck.com/v2/search/car/active?${params}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    );

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(200).json({ listing: null, error: `Marketcheck ${r.status}`, detail: txt.slice(0, 200) });
    }

    const data = await r.json();
    const listing = data.listings?.[0] || null;

    return res.status(200).json({ listing, vin });

  } catch (err) {
    return res.status(200).json({ listing: null, error: err.message });
  }
}
