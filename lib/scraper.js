// Raptor Inventory Scraper — Marketcheck API
// Single API call, all F-150 Raptors within 100 miles of Midland TX
// Consistent, structured, VIN-level data. No AI guessing.

const MARKETCHECK_URL = 'https://mc-api.marketcheck.com/v2/search/car/active';

export async function scrapeRaptors() {
  const params = new URLSearchParams({
    api_key:  process.env.MARKETCHECK_API_KEY,
    make:     'ford',
    model:    'f-150',
    trim:     'Raptor',
    car_type: 'new',
    zip:      '79701',
    radius:   '100',
    rows:     '100',
    fields:   'vin,heading,price,msrp,exterior_color,dom,dom_180,vdp_url,dealer,build,in_transit,first_seen_at_date',
  });

  const res = await fetch(`${MARKETCHECK_URL}?${params}`, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Marketcheck ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data     = await res.json();
  const listings = data.listings || [];
  console.log(`[marketcheck] num_found: ${data.num_found}, listings: ${listings.length}`);

  const vehicles = listings.map(v => ({
    vin:          v.vin,
    model_year:   v.build?.year || new Date().getFullYear(),
    model:        'F-150',
    trim:         'Raptor',
    color:        v.exterior_color || null,
    msrp:         v.msrp || v.price || null,
    days_on_lot:     v.dom      || 0,
    days_on_lot_180: v.dom_180  || v.dom || 0,
    first_listed:    v.first_seen_at_date ? v.first_seen_at_date.slice(0,10) : null,
    in_transit:      v.in_transit || false,
    dealer_name:  v.dealer?.name  || 'Unknown',
    dealer_city:  v.dealer?.city  || '',
    dealer_state: v.dealer?.state || 'TX',
    dealer_url:   v.dealer?.website ? `https://www.${v.dealer.website}` : null,
    vehicle_url:  v.vdp_url || null,
    dealer_lat:   v.dealer?.latitude  ? parseFloat(v.dealer.latitude)  : null,
    dealer_lng:   v.dealer?.longitude ? parseFloat(v.dealer.longitude) : null,
  }));

  // Build dealer summary
  const dm = new Map();
  for (const v of vehicles) {
    if (!dm.has(v.dealer_name)) {
      dm.set(v.dealer_name, {
        name:  v.dealer_name,
        city:  v.dealer_city,
        state: v.dealer_state,
        url:   v.dealer_url,
        miles: null,
        count: 0,
      });
    }
    dm.get(v.dealer_name).count++;
  }

  console.log(`[marketcheck] ${vehicles.length} Raptors across ${dm.size} dealers`);

  return {
    total:   vehicles.length,
    raptor:  vehicles.length,
    raptorR: 0,
    vehicles,
    dealers: [...dm.values()].sort((a, b) => b.count - a.count),
    hasData: true,
  };
}

export async function fetchWTI() {
  if (process.env.OIL_PRICE_API_KEY) {
    try {
      const res = await fetch('https://api.oilpriceapi.com/v1/prices/latest?by_code=WTI_USD', {
        headers: { 'Authorization': `Token ${process.env.OIL_PRICE_API_KEY}`, 'Content-Type': 'application/json' },
        signal:  AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const j = await res.json();
        const price = j?.data?.price ? parseFloat(j.data.price) : null;
        if (price && price > 10) { console.log(`[wti] OilPriceAPI: $${price}`); return { price, prevPrice: null, change: null }; }
      }
    } catch (e) { console.error('[wti] OilPriceAPI:', e.message); }
  }

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
        if (price && price > 10) { console.log(`[wti] EIA: $${price}`); return { price, prevPrice: prev, change: prev ? +(price-prev).toFixed(2) : null }; }
      }
    } catch (e) { console.error('[wti] EIA:', e.message); }
  }

  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1m&range=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com' },
      signal:  AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d = await res.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || null;
      const prev  = meta?.previousClose || null;
      if (price && price > 50) { console.log(`[wti] Yahoo: $${price}`); return { price, prevPrice: prev, change: prev ? +(price-prev).toFixed(2) : null }; }
    }
  } catch (e) { console.error('[wti] Yahoo:', e.message); }

  return { price: null, prevPrice: null, change: null };
}

export function generateCommentary(total, wti) {
  const oil = wti?.price ? `$${wti.price.toFixed(0)} WTI` : 'unknown oil prices';
  if (total === 0) return `Zero Raptors on any lot within 100 miles at ${oil}. Either Ford has a supply problem or every roughneck in West Texas just got a signing bonus.`;
  if (total < 8)   return `Only ${total} Raptors left within 100 miles at ${oil}. Basin's cooking — dealers can't keep them on the lot.`;
  if (total < 20)  return `${total} Raptors in stock at ${oil}. Inventory's moving. Someone just got their completion bonus.`;
  if (total < 40)  return `${total} trucks sitting at ${oil}. Normal-ish. Watch the trend.`;
  if (total < 60)  return `${total} Raptors accumulating at ${oil}. Spending is slowing. Check the rig count.`;
  if (total < 80)  return `${total} trucks on the lots at ${oil}. Roughnecks tightening up. Repo man on standby.`;
  return           `${total} Raptors collecting dust at ${oil}. Full bust mode. Repo man working overtime on Andrews Highway.`;
}
