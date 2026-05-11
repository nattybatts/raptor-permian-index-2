// GET /api/oil
// Returns current WTI and Brent prices. Called by the frontend on every page load.
// Keeps API keys server-side -- never exposed to the browser.
//
// Source priority (both WTI and Brent fetched in parallel):
//   1. OilPriceAPI  -- real-time NYMEX, requires API key
//   2. Yahoo Finance -- real-time futures: CL=F (WTI), BZ=F (Brent), no key needed
//   3. EIA          -- last resort; daily data with a publication lag, price may be days old

async function fetchYahoo(symbol) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
  return price ? parseFloat(price) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at edge for 10 minutes -- stale-while-revalidate intentionally omitted
  // to prevent the edge from serving a stuck stale price indefinitely.
  res.setHeader('Cache-Control', 'public, s-maxage=600');

  try {
    // 1. OilPriceAPI -- real-time NYMEX WTI + Brent
    if (process.env.OIL_PRICE_API_KEY) {
      try {
        const [wtiRes, brtRes] = await Promise.all([
          fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', {
            headers: { 'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(6000),
          }),
          fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=BRENT_CRUDE_USD', {
            headers: { 'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(6000),
          }),
        ]);
        const wtiJson = wtiRes.ok ? await wtiRes.json() : null;
        const brtJson = brtRes.ok ? await brtRes.json() : null;
        const wti = wtiJson?.data?.price ? parseFloat(wtiJson.data.price) : null;
        const brent = brtJson?.data?.price ? parseFloat(brtJson.data.price) : null;
        if (wti && wti > 20 && wti < 150 && brent && brent > 20 && brent < 150) {
          return res.status(200).json({ price: wti, brent, source: 'oilpriceapi', fetched_at: Date.now() });
        }
      } catch (e) { /* fall through */ }
    }

    // 2. Yahoo Finance -- CL=F (WTI) and BZ=F (Brent), fetched in parallel
    try {
      const [wti, brent] = await Promise.all([fetchYahoo('CL=F'), fetchYahoo('BZ=F')]);
      if (wti && wti > 10 && wti < 150 && brent && brent > 10 && brent < 150) {
        return res.status(200).json({ price: wti, brent, source: 'yahoo', fetched_at: Date.now() });
      }
    } catch (e) { /* fall through */ }

    // 3. EIA -- last resort; WTI only (no real-time Brent), daily lag
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
            // No real-time Brent from EIA; omit rather than guess
            return res.status(200).json({ price, brent: null, source: 'eia', fetched_at: Date.now() });
          }
        }
      } catch (e) { /* fall through */ }
    }

    return res.status(200).json({ price: null, brent: null, source: 'unavailable' });

  } catch (err) {
    return res.status(200).json({ price: null, brent: null, error: err.message });
  }
}
