// Ford Dealer Inventory Scraper
// All 3 trim queries run IN PARALLEL with a hard 7s timeout each
// Total budget: ~7s for Ford fetches + ~2s for WTI = fits in 10s free tier limit

const MIDLAND_ZIP  = '79701';
const RADIUS_MILES = 150;
const CURRENT_YEAR = new Date().getFullYear();
const FORD_URL     = 'https://shop.ford.com/aemservices/cache/inventory/dealer/search';
const FORD_TIMEOUT = 7000; // hard 7s — must finish before Vercel kills us
const WTI_TIMEOUT  = 4000;

const RAPTOR_TRIMS = [
  { model: 'F-150',  trim: 'Raptor',   isR: false },
  { model: 'F-150',  trim: 'Raptor R', isR: true  },
  { model: 'Ranger', trim: 'Raptor',   isR: false },
];

async function queryFord(model, trim) {
  const url = new URL(FORD_URL);
  url.searchParams.set('zipcode',       MIDLAND_ZIP);
  url.searchParams.set('radius',        String(RADIUS_MILES));
  url.searchParams.set('make',          'Ford');
  url.searchParams.set('model',         model);
  url.searchParams.set('trim',          trim);
  url.searchParams.set('year',          String(CURRENT_YEAR));
  url.searchParams.set('lang',          'en');
  url.searchParams.set('country',       'US');
  url.searchParams.set('inventoryType', 'Dealer');
  url.searchParams.set('maxResults',    '500');

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(FORD_TIMEOUT),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  return (
    data?.Result?.Vehicles ||
    data?.result?.vehicles ||
    data?.vehicles         ||
    data?.inventory        ||
    []
  );
}

function buildUrl(v) {
  const vin    = v.VIN || v.vin || '';
  const dealer = v.DealerCode || v.dealerCode || '';
  if (vin && dealer) return `https://shop.ford.com/inventory/FordVehicleDetailPage?dealerCode=${dealer}&vin=${vin}`;
  return v.VehicleDetailUrl || v.vehicleDetailUrl || null;
}

function normalize(raw, model, isR) {
  const vin = (raw.VIN || raw.vin || raw.Vin || '').trim().toUpperCase();
  if (!vin || vin.length !== 17) return null;
  return {
    vin,
    model_year:   parseInt(raw.ModelYear  || raw.modelYear  || CURRENT_YEAR),
    model:        raw.Model      || raw.model      || model,
    trim:         raw.Trim       || raw.trim        || (isR ? 'Raptor R' : 'Raptor'),
    color:        raw.ExtColor   || raw.extColor    || raw.ExteriorColor || null,
    msrp:         parseFloat(raw.MSRP || raw.msrp  || raw.Price || 0)   || null,
    dealer_name:  raw.DealerName || raw.dealerName  || raw.dealer?.name  || 'Unknown Dealer',
    dealer_city:  raw.DealerCity || raw.dealerCity  || raw.dealer?.city  || '',
    dealer_state: raw.DealerState|| raw.dealerState || 'TX',
    dealer_url:   raw.DealerWebsite || raw.dealerUrl || null,
    vehicle_url:  buildUrl(raw),
  };
}

export async function scrapeRaptors() {
  // Fire ALL three Ford API calls simultaneously
  const results = await Promise.allSettled(
    RAPTOR_TRIMS.map(({ model, trim, isR }) =>
      queryFord(model, trim).then(rows => ({ rows, model, isR }))
    )
  );

  const vinMap = new Map();

  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Ford API call failed:', result.reason?.message);
      continue;
    }
    const { rows, model, isR } = result.value;
    console.log(`Ford ${model} ${isR?'Raptor R':'Raptor'}: ${rows.length} results`);
    for (const raw of rows) {
      const v = normalize(raw, model, isR);
      if (v && !vinMap.has(v.vin)) vinMap.set(v.vin, v);
    }
  }

  const vehicles = Array.from(vinMap.values());
  const raptors  = vehicles.filter(v => v.trim !== 'Raptor R');
  const raptorRs = vehicles.filter(v => v.trim === 'Raptor R');

  const dealerMap = new Map();
  for (const v of vehicles) {
    if (!dealerMap.has(v.dealer_name)) {
      dealerMap.set(v.dealer_name, { name: v.dealer_name, city: v.dealer_city, state: v.dealer_state, url: v.dealer_url, raptor: 0, raptorR: 0 });
    }
    const d = dealerMap.get(v.dealer_name);
    if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
  }

  return {
    total:    vehicles.length,
    raptor:   raptors.length,
    raptorR:  raptorRs.length,
    vehicles,
    dealers:  Array.from(dealerMap.values()).sort((a,b) => (b.raptor+b.raptorR)-(a.raptor+a.raptorR)),
    hasData:  vehicles.length > 0,
  };
}

export async function fetchWTI() {
  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(WTI_TIMEOUT) });
    if (!res.ok) throw new Error('EIA HTTP ' + res.status);
    const json = await res.json();
    const rows = json?.response?.data || [];
    const price    = rows[0]?.value ? parseFloat(rows[0].value) : null;
    const prevPrice= rows[1]?.value ? parseFloat(rows[1].value) : null;
    return { price, prevPrice, change: price && prevPrice ? price - prevPrice : null };
  } catch {
    // Fallback: Yahoo Finance
    try {
      const res2 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=2d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(WTI_TIMEOUT),
      });
      const d2   = await res2.json();
      const meta = d2?.chart?.result?.[0]?.meta;
      return { price: meta?.regularMarketPrice || null, prevPrice: meta?.previousClose || null, change: null };
    } catch {
      return { price: null, prevPrice: null, change: null };
    }
  }
}

export function generateCommentary(total, wti) {
  const oil = wti?.price ? `$${wti.price.toFixed(0)} WTI` : 'unknown oil prices';
  if (total === 0) return `Zero Raptors on lots at ${oil}. Either Ford has a supply problem or every roughneck in West Texas just got a signing bonus.`;
  if (total < 8)   return `Only ${total} Raptors within 150 miles at ${oil}. Basin's cooking — dealers can't keep them on the lot.`;
  if (total < 20)  return `${total} Raptors in stock at ${oil}. Inventory's moving. Someone just got their completion bonus.`;
  if (total < 40)  return `${total} trucks sitting at ${oil}. Normal-ish. Watch the trend.`;
  if (total < 60)  return `${total} Raptors accumulating at ${oil}. Spending is slowing. Check the rig count.`;
  if (total < 80)  return `${total} trucks on the lots at ${oil}. Roughnecks tightening up. Repo man on standby.`;
  return           `${total} Raptors collecting dust at ${oil}. Full bust mode. Repo man working overtime on Andrews Highway.`;
}
