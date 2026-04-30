// Raptor Inventory Scraper — Marketcheck API
// Single API call returns all new F-150 Raptors within 100 miles of Midland TX
// Consistent, structured, VIN-level data. No AI guessing.

const MARKETCHECK_URL = 'https://mc-api.marketcheck.com/v2/search/car/active';
const MIDLAND_ZIP     = '79701';
const RADIUS_MILES    = 100; // free tier limit

export async function scrapeRaptors() {
  // Single query — Marketcheck stores both Raptor and Raptor R under trim=Raptor
  // We split by engine size: 5.2L supercharged V8 = Raptor R, 3.5L V6 = base Raptor
  const listings = await fetchTrim('Raptor');

  const seen = new Map();
  for (const v of listings) {
    if (!seen.has(v.vin)) seen.set(v.vin, v);
  }

  const vehicles = [...seen.values()];
  const raptor   = vehicles.filter(v => v.trim !== 'Raptor R').length;
  const raptorR  = vehicles.filter(v => v.trim === 'Raptor R').length;
  console.log(`[marketcheck] ${vehicles.length} total (${raptor} Raptor, ${raptorR} Raptor R)`);

  // Build dealer summary
  const dm = new Map();
  for (const v of vehicles) {
    const key = v.dealer_name;
    if (!dm.has(key)) {
      dm.set(key, {
        name:    v.dealer_name,
        city:    v.dealer_city,
        state:   v.dealer_state,
        url:     v.dealer_url,
        miles:   null,
        raptor:  0,
        raptorR: 0,
      });
    }
    const d = dm.get(key);
    if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
  }

  console.log(`[marketcheck] Total: ${vehicles.length} (${raptor} Raptor, ${raptorR} Raptor R)`);

  return {
    total:   vehicles.length,
    raptor,
    raptorR,
    vehicles,
    dealers: [...dm.values()].sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR)),
    hasData: true,
  };
}

async function fetchTrim(trim) {
  const params = new URLSearchParams({
    api_key:   process.env.MARKETCHECK_API_KEY,
    make:      'ford',
    model:     'f-150',
    trim,
    car_type:  'new',
    zip:       MIDLAND_ZIP,
    radius:    String(RADIUS_MILES),
    rows:      '100',
    fields:    'vin,heading,price,msrp,exterior_color,dom,vdp_url,dealer,build,in_transit,vehicle_status',
  });

  const res = await fetch(`${MARKETCHECK_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Marketcheck ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  const listings = data.listings || [];

  return listings.map(v => {
    // Raptor R has 5.2L supercharged V8. Base Raptor has 3.5L V6.
    // Marketcheck stores both under trim="Raptor" so we detect by engine.
    const engineSize = parseFloat(v.build?.engine_size || 0);
    const detectedTrim = engineSize >= 5.0 ? 'Raptor R' : 'Raptor';

    return {
      vin:          v.vin,
      model_year:   v.build?.year || new Date().getFullYear(),
      model:        'F-150',
      trim:         detectedTrim,
      color:        v.exterior_color || null,
      msrp:         v.msrp || v.price || null,
      days_on_lot:  v.dom || 0,
      in_transit:   v.in_transit || false,
      dealer_name:  v.dealer?.name  || 'Unknown',
      dealer_city:  v.dealer?.city  || '',
      dealer_state: v.dealer?.state || 'TX',
      dealer_url:   v.dealer?.website ? `https://www.${v.dealer.website}` : null,
      vehicle_url:  v.vdp_url || null,
    };
  });
}

export async function fetchWTI() {
  // OilPriceAPI — real-time NYMEX WTI
  if (process.env.OIL_PRICE_API_KEY) {
    try {
      const res = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', {
        headers: { 'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}`, 'Content-Type': 'application/json' },
        signal:  AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j     = await res.json();
        const price = j?.data?.price ? parseFloat(j.data.price) : null;
        if (price && price > 10) { console.log(`[wti] OilPriceAPI: $${price}`); return { price, prevPrice: null, change: null }; }
      }
    } catch (e) { console.error('[wti] OilPriceAPI failed:', e.message); }
  }

  // EIA fallback
  if (process.env.EIA_API_KEY) {
    try {
      const res = await fetch(
        `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const j    = await res.json();
        const rows = j?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price && price > 10) { console.log(`[wti] EIA: $${price}`); return { price, prevPrice: prev, change: prev ? +(price-prev).toFixed(2) : null }; }
      }
    } catch (e) { console.error('[wti] EIA failed:', e.message); }
  }

  // Yahoo Finance fallback
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1m&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' },
      signal:  AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d     = await res.json();
      const meta  = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || null;
      const prev  = meta?.previousClose || null;
      if (price && price > 50) { console.log(`[wti] Yahoo: $${price}`); return { price, prevPrice: prev, change: prev ? +(price-prev).toFixed(2) : null }; }
    }
  } catch (e) { console.error('[wti] Yahoo failed:', e.message); }

  return { price: null, prevPrice: null, change: null };
}

export function generateCommentary(total, wti) {
  const oil = wti?.price ? `$${wti.price.toFixed(0)} WTI` : 'unknown oil prices';
  if (total === 0) return `Zero F-150 Raptors on any lot within 100 miles at ${oil}. Either Ford has a supply problem or every roughneck in West Texas just got a signing bonus.`;
  if (total < 8)   return `Only ${total} F-150 Raptors left within 100 miles at ${oil}. Basin's cooking — dealers can't keep them on the lot.`;
  if (total < 20)  return `${total} F-150 Raptors in stock at ${oil}. Inventory's moving. Someone just got their completion bonus.`;
  if (total < 40)  return `${total} trucks sitting at ${oil}. Normal-ish. Watch the trend.`;
  if (total < 60)  return `${total} F-150 Raptors accumulating at ${oil}. Spending is slowing. Check the rig count.`;
  if (total < 80)  return `${total} trucks on the lots at ${oil}. Roughnecks tightening up. Repo man on standby.`;
  return           `${total} F-150 Raptors collecting dust at ${oil}. Full bust mode. Repo man working overtime on Andrews Highway.`;
}
