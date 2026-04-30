// GET /api/oil
// Returns current WTI price. Called by the frontend every 15 minutes.
// Keeps OIL_PRICE_API_KEY server-side — never exposed to the browser.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at edge for 10 minutes — multiple users hitting at same time
  // share one upstream request instead of hammering OilPriceAPI
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=300');

  try {
    // OilPriceAPI — real-time NYMEX WTI
    if (process.env.OIL_PRICE_API_KEY) {
      const r = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', {
        headers: {
          'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(6000),
      });
      if (r.ok) {
        const j = await r.json();
        const price = j?.data?.price ? parseFloat(j.data.price) : null;
        if (price && price > 10) {
          return res.status(200).json({ price, source: 'oilpriceapi' });
        }
      }
    }

    // EIA fallback
    if (process.env.EIA_API_KEY) {
      const r = await fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=1`,
        { signal: AbortSignal.timeout(6000) }
      );
      if (r.ok) {
        const j = await r.json();
        const price = j?.response?.data?.[0]?.value ? parseFloat(j.response.data[0].value) : null;
        if (price && price > 10) {
          return res.status(200).json({ price, source: 'eia' });
        }
      }
    }

    return res.status(200).json({ price: null, source: 'unavailable' });

  } catch (err) {
    return res.status(200).json({ price: null, error: err.message });
  }
}
