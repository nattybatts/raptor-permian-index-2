// Ford Dealer Inventory API
// Queries Ford's own shop.ford.com inventory system
// Filtered to Raptor and Raptor R trims within 150 miles of Midland TX (79701)
// Tracks individual vehicles by VIN

const MIDLAND_ZIP  = '79701';
const RADIUS_MILES = 150;
const CURRENT_YEAR = new Date().getFullYear();

// Ford's inventory search endpoint (public, no auth required)
const FORD_INVENTORY_URL = 'https://shop.ford.com/aemservices/cache/inventory/dealer/search';

// Ford uses these trim names in their system
const RAPTOR_TRIMS = [
  { model: 'F-150',  trim: 'Raptor',   isR: false },
  { model: 'F-150',  trim: 'Raptor R', isR: true  },
  { model: 'Ranger', trim: 'Raptor',   isR: false },
];

async function queryFordAPI(model, trim) {
  const url = new URL(FORD_INVENTORY_URL);
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

  const response = await fetch(url.toString(), {
    headers: {
      'Accept':     'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; RaptorCount/1.0)',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    console.error(`Ford API ${model} ${trim}: HTTP ${response.status}`);
    return [];
  }

  const data = await response.json();

  // Ford API response shape varies slightly — handle both known shapes
  const vehicles =
    data?.Result?.Vehicles ||
    data?.result?.vehicles ||
    data?.vehicles         ||
    data?.inventory        ||
    [];

  return Array.isArray(vehicles) ? vehicles : [];
}

function buildVehicleUrl(vehicle) {
  // Ford's VDP (vehicle detail page) pattern
  const vin    = vehicle.VIN || vehicle.vin || '';
  const dealer = vehicle.DealerCode || vehicle.dealerCode || '';
  if (vin && dealer) {
    return `https://shop.ford.com/inventory/FordVehicleDetailPage?dealerCode=${dealer}&vin=${vin}`;
  }
  return vehicle.VehicleDetailUrl || vehicle.vehicleDetailUrl || null;
}

function normalizeVehicle(raw, model, isR) {
  const vin = (raw.VIN || raw.vin || raw.Vin || '').trim().toUpperCase();
  if (!vin || vin.length !== 17) return null; // skip invalid VINs

  return {
    vin,
    model_year:   parseInt(raw.ModelYear  || raw.modelYear  || CURRENT_YEAR),
    model:        raw.Model               || raw.model               || model,
    trim:         raw.Trim                || raw.trim                || (isR ? 'Raptor R' : 'Raptor'),
    color:        raw.ExtColor            || raw.extColor            || raw.ExteriorColor || null,
    msrp:         parseFloat(raw.MSRP     || raw.msrp               || raw.Price || 0) || null,
    dealer_name:  raw.DealerName          || raw.dealerName          || raw.dealer?.name || 'Unknown Dealer',
    dealer_city:  raw.DealerCity          || raw.dealerCity          || raw.dealer?.city || '',
    dealer_state: raw.DealerState         || raw.dealerState         || 'TX',
    dealer_url:   raw.DealerWebsite       || raw.dealerUrl           || null,
    vehicle_url:  buildVehicleUrl(raw),
  };
}

export async function scrapeRaptors() {
  const vinMap   = new Map(); // vin -> vehicle data (deduped)
  const errors   = [];

  for (const { model, trim, isR } of RAPTOR_TRIMS) {
    try {
      const raw = await queryFordAPI(model, trim);
      console.log(`  ${model} ${trim}: ${raw.length} results from Ford API`);

      for (const r of raw) {
        const v = normalizeVehicle(r, model, isR);
        if (!v) continue;
        if (!vinMap.has(v.vin)) {
          vinMap.set(v.vin, v);
        }
      }
    } catch (err) {
      console.error(`  Ford API error (${model} ${trim}):`, err.message);
      errors.push(`${model} ${trim}: ${err.message}`);
    }
  }

  const vehicles  = Array.from(vinMap.values());
  const raptors   = vehicles.filter(v => v.trim !== 'Raptor R');
  const raptorRs  = vehicles.filter(v => v.trim === 'Raptor R');

  // Group by dealer for summary
  const dealerMap = new Map();
  for (const v of vehicles) {
    const key = v.dealer_name;
    if (!dealerMap.has(key)) {
      dealerMap.set(key, {
        name:    v.dealer_name,
        city:    v.dealer_city,
        state:   v.dealer_state,
        url:     v.dealer_url,
        raptor:  0,
        raptorR: 0,
        vins:    [],
      });
    }
    const d = dealerMap.get(key);
    if (v.trim === 'Raptor R') d.raptorR++;
    else d.raptor++;
    d.vins.push(v.vin);
  }

  return {
    total:      vehicles.length,
    raptor:     raptors.length,
    raptorR:    raptorRs.length,
    vehicles,
    dealers:    Array.from(dealerMap.values()).sort((a,b) => (b.raptor+b.raptorR) - (a.raptor+a.raptorR)),
    errors,
    hasData:    vehicles.length > 0,
  };
}

export async function fetchWTI() {
  // EIA open data API — free, requires free API key
  try {
    const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('EIA HTTP ' + res.status);
    const json = await res.json();
    const rows = json?.response?.data || [];
    const today = rows[0]?.value ? parseFloat(rows[0].value) : null;
    const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
    return { price: today, prevPrice: prev, change: today && prev ? today - prev : null };
  } catch (err) {
    console.error('WTI fetch failed:', err.message);
    // Fallback to Yahoo Finance
    try {
      const res2 = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=2d', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal:  AbortSignal.timeout(8000),
      });
      const d2   = await res2.json();
      const meta = d2?.chart?.result?.[0]?.meta;
      return { price: meta?.regularMarketPrice || null, prevPrice: meta?.previousClose || null, change: null };
    } catch {
      return { price: null, prevPrice: null, change: null };
    }
  }
}

// Generate sardonic commentary based on inventory level
// HIGH stock = BAD (sitting on lots, no buyers = industry slowing)
// LOW stock  = GOOD (selling fast = workers flush with cash)
export function generateCommentary(total, wti) {
  const oil = wti?.price ? `$${wti.price.toFixed(0)} WTI` : 'unknown oil prices';

  if (total === 0)   return `Zero Raptors on lots at ${oil}. Either Ford has a supply problem or every roughneck in West Texas just got a signing bonus.`;
  if (total < 8)     return `Only ${total} Raptors left within 150 miles at ${oil}. Basin's cooking — dealers can't keep them on the lot.`;
  if (total < 20)    return `${total} Raptors in stock at ${oil}. Inventory's moving. Someone just got their completion bonus.`;
  if (total < 40)    return `${total} trucks sitting at ${oil}. Normal-ish. Watch the trend.`;
  if (total < 60)    return `${total} Raptors accumulating at ${oil}. Spending is slowing. Check the rig count.`;
  if (total < 80)    return `${total} trucks on the lots at ${oil}. Roughnecks are tightening up. Repo man on standby.`;
  return             `${total} Raptors collecting dust at ${oil}. Full bust mode. The repo man is working overtime on Andrews Highway.`;
}
