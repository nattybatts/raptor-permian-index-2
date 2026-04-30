import { DEALERS } from './dealers.js';

const OPENAI_API = 'https://api.openai.com/v1/responses';

// One focused API call per dealer — all run in parallel
async function searchDealer(dealer) {
  const prompt = `Search for new Ford F-150 Raptor and Ford F-150 Raptor R trucks currently listed for sale at ${dealer.name} in ${dealer.city}, ${dealer.state}.

Website: ${dealer.url}
Inventory page to check: ${dealer.inventoryUrl}

IMPORTANT: Only F-150 Raptor and F-150 Raptor R. Do NOT include Ranger Raptor. F-150 only.
Only NEW vehicles, not used or pre-owned.

Return ONLY this JSON, no other text:
{"vehicles":[{"vin":"<17-char VIN>","trim":"<Raptor or Raptor R>","model_year":<year>,"model":"F-150","msrp":<number or null>,"vehicle_url":"<direct URL to this specific truck listing or null>"}]}

If none found: {"vehicles":[]}`;

  try {
    const res = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        tools: [{ type: 'web_search_preview', search_context_size: 'medium' }],
        input: prompt,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`[${dealer.name}] OpenAI error ${res.status}`);
      return [];
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

    raw = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s < 0 || e < 0) { console.log(`[${dealer.name}] no JSON`); return []; }

    const result = JSON.parse(raw.slice(s, e + 1));

    // Filter out any Ranger Raptors that slipped through
    const vehicles = (result.vehicles || [])
      .filter(v => (v.model || '').toUpperCase().includes('F-150') || !(v.model || '').toUpperCase().includes('RANGER'))
      .filter(v => v.trim === 'Raptor' || v.trim === 'Raptor R')
      .map(v => ({
        ...v,
        model: 'F-150',
        dealer_name:  dealer.name,
        dealer_city:  dealer.city,
        dealer_state: dealer.state,
        dealer_url:   dealer.url,
      }));

    console.log(`[${dealer.name}] ${vehicles.length} F-150 Raptors`);
    return vehicles;

  } catch (err) {
    console.error(`[${dealer.name}] error:`, err.message);
    return [];
  }
}

export async function fetchWTI() {
  // OilPriceAPI — real-time NYMEX WTI futures price
  // Free tier: 1,000 requests/month. Sign up at oilpriceapi.com
  if (process.env.OIL_PRICE_API_KEY) {
    try {
      const res = await fetch(
        'https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD',
        {
          headers: {
            'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (res.ok) {
        const j = await res.json();
        const price = j?.data?.price ? parseFloat(j.data.price) : null;
        if (price && price > 10) {
          console.log(`[wti] OilPriceAPI: $${price}`);
          return { price, prevPrice: null, change: null };
        }
      }
    } catch (e) { console.error('[wti] OilPriceAPI failed:', e.message); }
  }

  // EIA fallback — official US gov daily spot price
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

  // Alpha Vantage — daily close only, not real-time
  if (process.env.ALPHA_VANTAGE_KEY) {
    try {
      const res = await fetch(
        `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${process.env.ALPHA_VANTAGE_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const j = await res.json();
        const data = j?.data || [];
        if (data.length > 0 && data[0].value && data[0].value !== '.') {
          const price = parseFloat(data[0].value);
          if (price > 10) {
            console.log(`[wti] Alpha Vantage (daily close): $${price}`);
            return { price, prevPrice: null, change: null };
          }
        }
      }
    } catch (e) { console.error('[wti] Alpha Vantage failed:', e.message); }
  }

  // Yahoo Finance last resort
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1m&range=1d',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
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
  console.log(`[scraper] searching ${DEALERS.length} dealers in parallel + WTI price...`);

  const [wtiResult, ...dealerResults] = await Promise.allSettled([
    fetchWTI(),
    ...DEALERS.map(d => searchDealer(d)),
  ]);

  const wti = wtiResult.status === 'fulfilled' ? wtiResult.value : { price: null };

  const allVehicles = [];
  for (const r of dealerResults) {
    if (r.status === 'fulfilled') allVehicles.push(...r.value);
  }

  // Dedupe by VIN
  const seen = new Map();
  for (const v of allVehicles) {
    const vin = (v.vin || '').trim().toUpperCase();
    const key = vin.length === 17 ? vin : `${v.dealer_name}|${v.trim}|${v.model_year}|${v.msrp}`;
    if (!seen.has(key)) {
      seen.set(key, {
        vin:          vin.length === 17 ? vin : null,
        model_year:   Number(v.model_year) || new Date().getFullYear(),
        model:        'F-150',
        trim:         v.trim,
        msrp:         v.msrp ? Number(v.msrp) : null,
        color:        null,
        dealer_name:  v.dealer_name,
        dealer_city:  v.dealer_city,
        dealer_state: v.dealer_state,
        dealer_url:   v.dealer_url,
        vehicle_url:  v.vehicle_url || null,
      });
    }
  }

  const vehicles = [...seen.values()];
  const raptor  = vehicles.filter(v => v.trim !== 'Raptor R').length;
  const raptorR = vehicles.filter(v => v.trim === 'Raptor R').length;

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

  console.log(`[scraper] FINAL: ${vehicles.length} F-150 Raptors (${raptor} Raptor, ${raptorR} Raptor R), WTI $${wti.price}`);

  return {
    total: vehicles.length, raptor, raptorR, vehicles,
    dealers:    [...dm.values()].sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR)),
    commentary: generateCommentary(vehicles.length, wti),
    wtiPrice:   wti.price,
    hasData:    true,
  };
}

export function generateCommentary(total, wti) {
  const oil = wti?.price ? `$${wti.price.toFixed(0)} WTI` : 'unknown oil prices';
  if (total === 0) return `Zero F-150 Raptors on any lot within 150 miles at ${oil}. Either Ford has a supply problem or every roughneck in West Texas just got a signing bonus.`;
  if (total < 8)   return `Only ${total} F-150 Raptors left within 150 miles at ${oil}. Basin's cooking — dealers can't keep them on the lot.`;
  if (total < 20)  return `${total} F-150 Raptors in stock at ${oil}. Inventory's moving. Someone just got their completion bonus.`;
  if (total < 40)  return `${total} trucks sitting at ${oil}. Normal-ish. Watch the trend.`;
  if (total < 60)  return `${total} F-150 Raptors accumulating at ${oil}. Spending is slowing. Check the rig count.`;
  if (total < 80)  return `${total} trucks on the lots at ${oil}. Roughnecks tightening up. Repo man on standby.`;
  return           `${total} F-150 Raptors collecting dust at ${oil}. Full bust mode. Repo man working overtime on Andrews Highway.`;
}
