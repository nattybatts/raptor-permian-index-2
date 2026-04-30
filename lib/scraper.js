// Raptor Inventory Scraper — OpenAI version
// Uses GPT-4o with web search to find current Raptor inventory near Midland TX

import { DEALERS } from './dealers.js';

const OPENAI_API = 'https://api.openai.com/v1/responses';

export async function scrapeRaptors() {
  const prompt = `Search the web for new Ford F-150 Raptor and Ford F-150 Raptor R trucks currently in stock at Ford dealerships near Midland TX and Odessa TX. Also check Lubbock TX, Big Spring TX, and Abilene TX dealers.

Search for:
- new ford raptor in stock sewellford.com
- new ford f-150 raptor odessa texas dealer
- new ford raptor r midland texas in stock
- rogers ford midland new raptor
- new ford raptor for sale near 79701

For every NEW truck listing you find (not used), record:
- VIN (17 characters)
- Trim: "Raptor" or "Raptor R" only — skip all other F-150 trims
- Model year
- Price/MSRP (exact dollar amount, or null if not shown)
- Dealer name and city
- Direct URL to that specific vehicle listing

Also get today's WTI crude oil price.

Respond with ONLY a JSON object, no markdown, no explanation:
{"wtiPrice":71.5,"vehicles":[{"vin":"1FTFW1RG0SFC00777","trim":"Raptor","model_year":2025,"model":"F-150","dealer_name":"Sewell Ford","dealer_city":"Odessa","dealer_state":"TX","msrp":104560,"vehicle_url":"https://...","dealer_url":"https://www.sewellford.com"}],"commentary":"one sardonic sentence: low stock = boom times, high stock = bust"}`;

  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      tools: [{ type: 'web_search_preview' }],
      input: prompt,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI API ${res.status}: ${txt.slice(0, 300)}`);
  }

  const data = await res.json();

  // Extract text from OpenAI responses format
  let raw = '';
  for (const item of (data.output || [])) {
    if (item.type === 'message') {
      for (const block of (item.content || [])) {
        if (block.type === 'output_text') raw += block.text;
      }
    }
  }

  console.log('[scraper] raw length:', raw.length);
  console.log('[scraper] raw preview:', raw.slice(0, 500));

  raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON found. Response: ' + raw.slice(0, 400));

  const result = JSON.parse(raw.slice(s, e + 1));

  // Dedupe by VIN
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

  // Seed dealer map with known dealers at 0
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
  try {
    if (process.env.EIA_API_KEY) {
      const res = await fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const j = await res.json();
        const rows = j?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price) return { price, prevPrice: prev, change: prev ? price - prev : null };
      }
    }
  } catch {}
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const d    = await res.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || null;
      const prev  = meta?.chartPreviousClose || null;
      if (price) return { price, prevPrice: prev, change: prev ? price - prev : null };
    }
  } catch {}
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
