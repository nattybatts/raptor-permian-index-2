export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=300');

  // Try each source independently — timeout on one doesn't kill the rest
  const sources = [
    async () => {
      if (!process.env.OIL_PRICE_API_KEY) return null;
      const r = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', {
        headers: { 'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const price = j?.data?.price ? parseFloat(j.data.price) : null;
      return price > 10 ? { price, source: 'oilpriceapi' } : null;
    },
    async () => {
      if (!process.env.EIA_API_KEY) return null;
      const r = await fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=1`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      const j = await r.json();
      const price = j?.response?.data?.[0]?.value ? parseFloat(j.response.data[0].value) : null;
      return price > 10 ? { price, source: 'eia' } : null;
    },
    async () => {
      // Yahoo Finance fallback — no key needed
      const r = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=1d',
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      const j = await r.json();
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      return price > 10 ? { price: parseFloat(price), source: 'yahoo' } : null;
    },
    async () => {
      // Also try Brent from Yahoo as last resort for WTI approximation
      const r = await fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d',
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) return null;
      const j = await r.json();
      const brent = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      // WTI typically trades ~$2-4 below Brent
      const price = brent > 10 ? parseFloat(brent) - 3 : null;
      return price > 10 ? { price, source: 'yahoo_brent_approx' } : null;
    },
  ];

  for (const source of sources) {
    try {
      const result = await source();
      if (result) {
        // Also fetch Brent for display
        let brent = null;
        try {
          const br = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BZ=F?interval=1d&range=1d',
            { signal: AbortSignal.timeout(4000) });
          if (br.ok) {
            const bj = await br.json();
            brent = bj?.chart?.result?.[0]?.meta?.regularMarketPrice;
            if (brent) brent = parseFloat(brent);
          }
        } catch {}

        return res.status(200).json({ ...result, brent });
      }
    } catch (e) {
      // This source failed — try next
      console.log(`[oil] source failed: ${e.message}`);
      continue;
    }
  }

  return res.status(200).json({ price: null, source: 'all_failed' });
}