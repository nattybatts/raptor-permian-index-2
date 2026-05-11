// GET /api/oil
// Returns current WTI price. Called by the frontend every 15 minutes.
// Keeps OIL_PRICE_API_KEY server-side — never exposed to the browser.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at edge for 10 minutes — stale-while-revalidate intentionally omitted
  // to prevent the edge from serving a stuck stale price indefinitely.
  res.setHeader('Cache-Control', 'public, s-maxage=600');

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
        // Sanity check: WTI spot should realistically be between $20-$150
        // Rejects stale futures prices or clearly bad data from the free tier
        if (price && price > 20 && price < 150) {
          return res.status(200).json({ price, source: 'oilpriceapi', fetched_at: Date.now() });
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
        // Same sanity check on EIA data
        if (price && price > 20 && price < 150) {
          return res.status(200).json({ price, source: 'eia', fetched_at: Date.now() });
        }
      }
    }

    // Yahoo Finance fallback — CL=F is WTI crude futures
    try {
      const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1m&range=1d', {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' },
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const d = await r.json();
        const meta = d?.chart?.result?.[0]?.meta;
        const price = meta?.regularMarketPrice ? parseFloat(meta.regularMarketPrice) : null;
        if (price && price > 10 && price < 150) {
          return res.status(200).json({ price, source: 'yahoo', fetched_at: Date.now() });
        }
      }
    } catch (e) { /* fall through */ }

    return res.status(200).json({ price: null, source: 'unavailable' });

  } catch (err) {
    return res.status(200).json({ price: null, error: err.message });
  }
}
