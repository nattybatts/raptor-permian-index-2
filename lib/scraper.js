import { DEALERS } from './dealers.js';

const OPENAI_API = 'https://api.openai.com/v1/responses';

// Split into two focused searches to be thorough:
// 1. Inventory search across all dealers
// 2. WTI price from a reliable source

async function searchInventory() {
  const dealerLines = DEALERS.map(d =>
    `${d.name} (${d.city} TX) — ${d.url}`
  ).join('\n');

  const prompt = `You must search the web inventory pages for each of these specific Ford dealerships and find every new Ford F-150 Raptor and Raptor R currently listed for sale. Search each dealer one by one.

DEALERS TO CHECK:
${dealerLines}

For each dealer search: "[dealer name] new raptor inventory" and also visit their website inventory page filtering to Raptor trim.

I need ONLY new vehicles (not used/pre-owned). Trim must specifically say "Raptor" or "Raptor R".

For every truck found return in this exact JSON format with no other text:
{"vehicles":[{"vin":"<17-char VIN>","trim":"<Raptor or Raptor R>","model_year":<year>,"model":"F-150","dealer_name":"<name>","dealer_city":"<city>","dealer_state":"TX","msrp":<price or null>,"vehicle_url":"<direct link to this truck>","dealer_url":"<dealer homepage>"}]}

If no Raptors found at a dealer, do not include that dealer. Only include trucks you actually confirmed exist on a listing page.`;

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

  if (!res.ok) throw new Error(`OpenAI inventory ${res.status}: ${await res.text().catch(()=>'')}`);
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

async function searchWTI() {
  // Use OpenAI web search to get live WTI price - bypasses Yahoo rate limiting
  const res = await fetch(OPENAI_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      tools: [{ type: 'web_search_preview' }],
      input: 'What is the current WTI crude oil price per barrel right now? Check finance.yahoo.com for CL=F or marketwatch.com or bloomberg. Return ONLY a JSON object like this with no other text: {"price": 108.42, "change": 1.23}',
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) return null;
  const data = await res.json();

  let raw = '';
  for (const item of (data.output || [])) {
    if (item.type === 'message') {
      for (const block of (item.content || [])) {
        if (block.type === 'output_text') raw += block.text;
      }
    }
  }

  try {
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e >= 0) {
      const result = JSON.parse(raw.slice(s, e + 1));
      console.log('[wti] OpenAI price:', result.price);
      return result;
    }
  } catch (err) {
    console.error('[wti] parse error:', err.message, raw.slice(0, 200));
  }
  return null;
}

export async function scrapeRaptors() {
  // Run inventory search and WTI search in parallel
  const [invRaw, wtiResult] = await Promise.allSettled([
    searchInventory(),
    searchWTI(),
  ]);

  let raw = invRaw.status === 'fulfilled' ? invRaw.value : '';
  if (invRaw.status === 'rejected') console.error('[inventory] error:', invRaw.reason?.message);

  // Parse inventory JSON
  let result = { vehicles: [], commentary: null };
  try {
    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s >= 0 && e >= 0) result = JSON.parse(raw.slice(s, e + 1));
  } catch (err) {
    console.error('[scraper] JSON parse error:', err.message);
    console.error('[scraper] raw was:', raw.slice(0, 500));
  }

  // Attach WTI to result if found
  if (wtiResult.status === 'fulfilled' && wtiResult.value?.price) {
    result.wtiPrice = wtiResult.value.price;
    result.wtiChange = wtiResult.value.change;
  }

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

  console.log(`[scraper] final: ${vehicles.length} vehicles (${raptor} Raptor, ${raptorR} Raptor R), WTI $${result.wtiPrice || 'unknown'}`);

  return {
    total: vehicles.length, raptor, raptorR, vehicles,
    dealers:    [...dm.values()].sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR)),
    commentary: result.commentary || null,
    wtiPrice:   result.wtiPrice   || null,
    wtiChange:  result.wtiChange  || null,
    hasData:    true,
  };
}

export async function fetchWTI() {
  // EIA is the most reliable — official US government WTI spot price
  // Try this first, always
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

  // Yahoo Finance fallback — but only trust it if price looks right (>$50)
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
      const prev  = meta?.previousClose || meta?.chartPreviousClose || null;
      if (price && price > 50) {
        console.log(`[wti] Yahoo: $${price}`);
        return { price, prevPrice: prev, change: prev ? +(price - prev).toFixed(2) : null };
      }
    }
  } catch (e) { console.error('[wti] Yahoo failed:', e.message); }
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
    } catch {}
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
