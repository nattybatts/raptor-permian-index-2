import { DEALERS } from './dealers.js';

const OPENAI_API = 'https://api.openai.com/v1/responses';

async function searchInventory() {
  const dealerLines = DEALERS.map(d =>
    `${d.name} (${d.city} TX) — ${d.url}`
  ).join('\n');

  const prompt = `Search the web inventory pages for each of these specific Ford dealerships and find every new Ford F-150 Raptor and Raptor R currently listed for sale. Search each dealer one by one.

DEALERS TO CHECK:
${dealerLines}

For each dealer search their website for new Raptor inventory. Only include NEW vehicles (not used). Trim must specifically say "Raptor" or "Raptor R".

Return ONLY this JSON with no other text:
{"vehicles":[{"vin":"<17-char VIN>","trim":"<Raptor or Raptor R>","model_year":<year>,"model":"F-150","dealer_name":"<name>","dealer_city":"<city>","dealer_state":"TX","msrp":<price or null>,"vehicle_url":"<direct URL to this truck>","dealer_url":"<dealer homepage>"}],"commentary":"<sardonic one-liner about Permian Basin OFS health based on count — low stock = boom, high stock = bust>"}`;

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

  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();

  let raw = '';
  for (const item of (data.output || [])) {
    if (item.type === 'message') {
      for (const block of (item.content || [])) {
        if (block.type === 'output_text') raw += block.text;
      }
    }
  }
  console.log('[inventory] raw length:', raw.length);
  console.log('[inventory] preview:', raw.slice(0, 600));
  return raw;
}

export async function fetchWTI() {
  // 1. Alpha Vantage — same source as isoilabove100.com, free key, reliable
  if (process.env.ALPHA_VANTAGE_KEY) {
    try {
      const res = await fetch(
        `https://www.alphavantage.co/query?function=BRENT&interval=daily&apikey=${process.env.ALPHA_VANTAGE_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const j = await res.json();
        const data = j?.data || [];
        if (data.length > 0 && data[0].value !== '.') {
          const brent = parseFloat(data[0].value);
          // WTI trades roughly $2-4 below Brent
          const wti = +(brent - 3).toFixed(2);
          console.log(`[wti] Alpha Vantage Brent: $${brent} → WTI est: $${wti}`);
          return { price: wti, brent, prevPrice: data[1] ? parseFloat(data[1].value) - 3 : null, change: null };
        }
      }
    } catch (e) { console.error('[wti] Alpha Vantage failed:', e.message); }

    // Also try WTI directly from Alpha Vantage
    try {
      const res = await fetch(
        `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${process.env.ALPHA_VANTAGE_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const j = await res.json();
        const data = j?.data || [];
        if (data.length > 0 && data[0].value !== '.') {
          const price = parseFloat(data[0].value);
          const prev  = data[1] ? parseFloat(data[1].value) : null;
          console.log(`[wti] Alpha Vantage WTI: $${price}`);
          return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
        }
      }
    } catch (e) { console.error('[wti] Alpha Vantage WTI failed:', e.message); }
  }

  // 2. EIA fallback
  if (process.env.EIA_API_KEY) {
    try {
      const res = await fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const j = await res.json();
        const rows = j?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price && price > 10) {
          console.log(`[wti] EIA: $${price}`);
          return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
        }
      }
    } catch (e) { console.error('[wti] EIA failed:', e.message); }
  }

  // 3. Yahoo Finance last resort
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1m&range=1d',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': 'https://finance.yahoo.com',
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (res.ok) {
      const d = await res.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || null;
      const prev  = meta?.previousClose || null;
      if (price && price > 50) {
        console.log(`[wti] Yahoo: $${price}`);
        return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
      }
    }
  } catch (e) { console.error('[wti] Yahoo failed:', e.message); }

  console.error('[wti] ALL sources failed');
  return { price: null, prevPrice: null, change: null };
}

export async function scrapeRaptors() {
  const [invRaw, wtiResult] = await Promise.allSettled([
    searchInventory(),
    fetchWTI(),
  ]);

  let raw = invRaw.status === 'fulfilled' ? invRaw.value : '';
  if (invRaw.status === 'rejected') console.error('[inventory] error:', invRaw.reason?.message);

  let result = { vehicles: [], commentary: null };
  try {
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e >= 0) result = JSON.parse(raw.slice(s, e + 1));
  } catch (err) {
    console.error('[scraper] JSON parse error:', err.message, raw.slice(0, 300));
  }

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
  const wti      = wtiResult.status === 'fulfilled' ? wtiResult.value : { price: null };

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

  console.log(`[scraper] ${vehicles.length} vehicles (${raptor}R / ${raptorR}RR), WTI $${wti.price}`);

  return {
    total: vehicles.length, raptor, raptorR, vehicles,
    dealers:    [...dm.values()].sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR)),
    commentary: result.commentary || null,
    wtiPrice:   wti.price,
    wtiChange:  wti.change,
    hasData:    true,
  };
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
