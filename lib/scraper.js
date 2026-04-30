import { DEALERS } from './dealers.js';

const OPENAI_API = 'https://api.openai.com/v1/responses';

export async function scrapeRaptors() {
  const dealerLines = DEALERS.map(d =>
    `- ${d.name}, ${d.city} ${d.state} (${d.miles}mi) — ${d.url}`
  ).join('\n');

  const prompt = `Search the web for new Ford F-150 Raptor and Ford F-150 Raptor R trucks currently in stock at Ford dealerships within 150 miles of Midland TX. Check ALL of these specific dealers:

${dealerLines}

For each dealer, search their website inventory for NEW (not used) Ford F-150 Raptor or Raptor R trucks. Search queries like:
- "new raptor" site:sewellford.com
- "new raptor" site:rogersford.com
- "new raptor" site:baileytoliverford.com
- "new raptor" site:starfordbigspring.com
- "new raptor" site:arrowford.net
- "new raptor" site:stanleyfordsweetwater.com
- new ford raptor in stock midland odessa lubbock texas 2025 2026

For every individual NEW truck listing found, record:
- VIN (17 chars, shown on every listing page)
- Trim: MUST be "Raptor" or "Raptor R" — skip all other trims
- Model year
- MSRP/Price (exact dollar number if shown, null if not listed)
- Dealer name and city
- Direct URL to that specific vehicle page

Return ONLY valid JSON, no markdown:
{"vehicles":[{"vin":"1FTFW1RG0SFC00777","trim":"Raptor","model_year":2026,"model":"F-150","dealer_name":"Sewell Ford","dealer_city":"Odessa","dealer_state":"TX","msrp":104560,"vehicle_url":"https://...","dealer_url":"https://www.sewellford.com"}],"commentary":"sardonic one-liner about Permian Basin OFS health based on inventory level — low stock good, high stock bad"}`;

  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      tools: [{ type: 'web_search_preview', search_context_size: 'high' }],
      input: prompt,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();

  let raw = '';
  for (const item of (data.output || [])) {
    if (item.type === 'message') {
      for (const block of (item.content || [])) {
        if (block.type === 'output_text') raw += block.text;
      }
    }
  }

  console.log('[scraper] raw length:', raw.length);
  console.log('[scraper] raw preview:', raw.slice(0, 800));

  raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON. Response: ' + raw.slice(0, 400));

  const result = JSON.parse(raw.slice(s, e + 1));

  const seen = new Map();
  for (const v of (result.vehicles || [])) {
    const vin = (v.vin || '').trim().toUpperCase();
    const key = vin.length === 17 ? vin : `${v.dealer_name}|${v.trim}|${v.model_year}|${v.msrp}`;
    if (!seen.has(key)) {
      seen.set(key, {
        vin:          vin.length === 17 ? vin : null,
        model_year:   Number(v.model_year) || new Date().getFullYear(),
        model:        v.model || 'F-150',
        trim:         v.trim  || 'Raptor',
        msrp:         v.msrp  ? Number(v.msrp) : null,
        color:        null,
        dealer_name:  v.dealer_name  || 'Unknown',
        dealer_city:  v.dealer_city  || '',
        dealer_state: v.dealer_state || 'TX',
        dealer_url:   v.dealer_url   || null,
        vehicle_url:  v.vehicle_url  || null,
      });
    }
  }

  const vehicles = [...seen.values()];
  const raptor   = vehicles.filter(v => v.trim !== 'Raptor R').length;
  const raptorR  = vehicles.filter(v => v.trim === 'Raptor R').length;

  const dm = new Map();
  for (const d of DEALERS) {
    dm.set(d.name, { name: d.name, city: d.city, state: d.state, url: d.url, miles: d.miles, raptor: 0, raptorR: 0 });
  }
  for (const v of vehicles) {
    const key = [...dm.keys()].find(k =>
      k.toLowerCase().includes((v.dealer_name || '').toLowerCase().split(' ')[0]) ||
      (v.dealer_name || '').toLowerCase().includes(k.toLowerCase().split(' ')[0])
    ) || v.dealer_name;
    if (!dm.has(key)) dm.set(key, { name: v.dealer_name, city: v.dealer_city, state: v.dealer_state, url: v.dealer_url, miles: null, raptor: 0, raptorR: 0 });
    const d = dm.get(key);
    if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
  }

  console.log(`[scraper] done: ${vehicles.length} vehicles (${raptor} Raptor, ${raptorR} Raptor R)`);

  return {
    total: vehicles.length, raptor, raptorR, vehicles,
    dealers:    [...dm.values()].sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR)),
    commentary: result.commentary || null,
    hasData:    true,
  };
}

export async function fetchWTI() {
  // Yahoo Finance front-month WTI futures — CL=F
  // Using v8 finance chart API which returns regularMarketPrice (current session price)
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1m&range=1d',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (res.ok) {
      const data  = await res.json();
      const meta  = data?.chart?.result?.[0]?.meta;
      // regularMarketPrice is the live/most recent trade price
      const price = meta?.regularMarketPrice || null;
      const prev  = meta?.previousClose || meta?.chartPreviousClose || null;
      if (price) {
        console.log(`[wti] Yahoo Finance CL=F: $${price}`);
        return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
      }
    }
  } catch (e) { console.error('[wti] Yahoo v8 failed:', e.message); }

  // Fallback: Yahoo Finance v10 quote
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v10/finance/quoteSummary/CL%3DF?modules=price',
      {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (res.ok) {
      const data  = await res.json();
      const price = data?.quoteSummary?.result?.[0]?.price?.regularMarketPrice?.raw || null;
      const prev  = data?.quoteSummary?.result?.[0]?.price?.regularMarketPreviousClose?.raw || null;
      if (price) {
        console.log(`[wti] Yahoo v10 CL=F: $${price}`);
        return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
      }
    }
  } catch (e) { console.error('[wti] Yahoo v10 failed:', e.message); }

  // EIA fallback
  if (process.env.EIA_API_KEY) {
    try {
      const res = await fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const j = await res.json();
        const rows = j?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price) return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
      }
    } catch (e) { console.error('[wti] EIA failed:', e.message); }
  }

  return { price: null, prevPrice: null, change: null };
}

export function generateCommentary(total, wti) {
  const oil = wti?.price ? `$${wti.price.toFixed(0)} WTI` : 'unknown oil prices';
  if (total === 0) return `Zero Raptors on any lot within 150 miles at ${oil}. Either Ford has a supply problem or every roughneck in West Texas just got a signing bonus.`;
  if (total < 8)   return `Only ${total} Raptors left within 150 miles at ${oil}. Basin's cooking — dealers can't keep them on the lot.`;
  if (total < 20)  return `${total} Raptors in stock at ${oil}. Inventory's moving. Someone just got their completion bonus.`;
  if (total < 40)  return `${total} trucks sitting at ${oil}. Normal-ish. Watch the trend.`;
  if (total < 60)  return `${total} Raptors accumulating at ${oil}. Spending is slowing. Check the rig count.`;
  if (total < 80)  return `${total} trucks on the lots at ${oil}. Roughnecks tightening up. Repo man on standby.`;
  return           `${total} Raptors collecting dust at ${oil}. Full bust mode. Repo man working overtime on Andrews Highway.`;
}
