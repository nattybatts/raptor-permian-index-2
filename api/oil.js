// GET /api/oil
// Returns current WTI price. Called by the frontend every 15 minutes.
// Keeps OIL_PRICE_API_KEY server-side -- never exposed to the browser.
//
// Source priority:
//   1. OilPriceAPI  -- real-time NYMEX, requires API key
//   2. Yahoo Finance -- real-time CL=F futures, no key needed
//   3. EIA          -- last resort; daily data with a publication lag, price may be days old

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at edge for 10 minutes -- stale-while-revalidate intentionally omitted
  // to prevent the edge from serving a stuck stale price indefinitely.
  res.setHeader('Cache-Control', 'public, s-maxage=600');

  try {
    // 1. OilPriceAPI -- real-time NYMEX WTI
    if (process.env.OIL_PRICE_API_KEY) {
      try {
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
          if (price && price > 20 && price < 150) {
            return res.status(200).json({ price, source: 'oilpriceapi', fetched_at: Date.now() });
          }
        }
      } catch (e) { /* fall through */ }
    }

    // 2. Yahoo Finance -- real-time CL=F WTI futures, no API key needed
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

    // 3. EIA -- last resort only; publishes daily with a lag so price may be days old
    if (process.env.EIA_API_KEY) {
      try {
        const r = await fetch(
          `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=1`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (r.ok) {
          const j = await r.json();
          const price = j?.response?.data?.[0]?.value ? parseFloat(j.response.data[0].value) : null;
          if (price && price > 20 && price < 150) {
            return res.status(200).json({ price, source: 'eia', fetched_at: Date.now() });
          }
        }
      } catch (e) { /* fall through */ }
    }

    return res.status(200).json({ price: null, source: 'unavailable' });

  } catch (err) {
    return res.status(200).json({ price: null, error: err.message });
  }
}
