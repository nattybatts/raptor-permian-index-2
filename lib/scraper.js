// Ford Raptor Inventory Scraper + WTI Price
// All fetches run in parallel with hard timeouts for Vercel free tier

const MIDLAND_ZIP  = '79701';
const MIDLAND_LAT  = 31.9973;
const MIDLAND_LON  = -102.0779;
const RADIUS_MILES = 150;
const CURRENT_YEAR = new Date().getFullYear();
const FORD_TIMEOUT = 7000;
const WTI_TIMEOUT  = 5000;

// ── FORD SHOP API ─────────────────────────────────────────
// Primary source — Ford's own inventory search
const FORD_URL = 'https://shop.ford.com/aemservices/cache/inventory/dealer/search';

const RAPTOR_TRIMS = [
  { model: 'F-150',  trim: 'Raptor',   isR: false },
  { model: 'F-150',  trim: 'Raptor R', isR: true  },
  { model: 'Ranger', trim: 'Raptor',   isR: false },
];

async function queryFordAPI(model, trim) {
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
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(FORD_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Ford HTTP ${res.status}`);
  const data = await res.json();
  return data?.Result?.Vehicles || data?.result?.vehicles || data?.vehicles || data?.inventory || [];
}

// ── CARS.COM FALLBACK ─────────────────────────────────────
// Scrapes Cars.com search results for Raptor inventory near Midland
// Used when Ford's own API returns 0 results
async function queryCarscom(isRaptorR) {
  const keyword = isRaptorR ? 'Ford F-150 Raptor R' : 'Ford F-150 Raptor';
  const url = `https://www.cars.com/shopping/results/?dealer_id=&keyword=${encodeURIComponent(keyword)}&list_price_max=&list_price_min=&makes[]=ford&maximum_distance=${RADIUS_MILES}&mileage_max=&models[]=${isRaptorR ? 'ford-f_150-raptor_r' : 'ford-f_150-raptor'}&page_size=100&sort=best_match_desc&stock_type=new&zip=${MIDLAND_ZIP}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' },
    signal: AbortSignal.timeout(FORD_TIMEOUT),
  });
  if (!res.ok) throw new Error(`Cars.com HTTP ${res.status}`);
  const html = await res.text();

  // Parse vehicle cards from Cars.com HTML
  const vehicles = [];
  // Match VIN patterns in the HTML
  const vinRegex = /[A-HJ-NPR-Z0-9]{17}/g;
  const vins = new Set(html.match(vinRegex) || []);

  // Extract dealer name + city from listing cards
  const cardRegex = /data-listing-id[^>]*>([\s\S]*?)<\/article/g;
  const dealerRegex = /dealer-name[^>]*>([^<]+)</;
  const cityRegex = /([A-Z][a-z]+(?:\s[A-Z][a-z]+)*),\s*TX/;
  const priceRegex = /\$([0-9,]+)/;
  const vinCardRegex = /vin[=":\s]+([A-HJ-NPR-Z0-9]{17})/i;
  const urlRegex = /href="(\/vehicle\/[^"]+)"/;

  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const card       = match[1];
    const vinM       = vinCardRegex.exec(card);
    const dealerM    = dealerRegex.exec(card);
    const cityM      = cityRegex.exec(card);
    const priceM     = priceRegex.exec(card);
    const urlM       = urlRegex.exec(card);

    if (vinM) {
      vehicles.push({
        vin:         vinM[1].toUpperCase(),
        trim:        isRaptorR ? 'Raptor R' : 'Raptor',
        model:       'F-150',
        dealer_name: dealerM ? dealerM[1].trim() : 'Unknown Dealer',
        dealer_city: cityM   ? cityM[1]           : '',
        dealer_state:'TX',
        dealer_url:  null,
        vehicle_url: urlM ? `https://www.cars.com${urlM[1]}` : null,
        msrp:        priceM ? parseFloat(priceM[1].replace(/,/g,'')) : null,
        color:       null,
        model_year:  CURRENT_YEAR,
      });
    }
  }

  return vehicles;
}

// ── AUTOTRADER FALLBACK ───────────────────────────────────
async function queryAutoTrader(isRaptorR) {
  const trim = isRaptorR ? 'RAPTOR_R' : 'RAPTOR';
  const url  = `https://www.autotrader.com/cars-for-sale/new-cars/ford/f-150/${MIDLAND_ZIP}?trim=${trim}&searchRadius=${RADIUS_MILES}&numRecords=100&newSearch=true`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0', 'Accept': 'text/html' },
    signal: AbortSignal.timeout(FORD_TIMEOUT),
  });
  if (!res.ok) throw new Error(`AutoTrader HTTP ${res.status}`);
  const html = await res.text();

  const vehicles = [];
  const vinRegex = /[A-HJ-NPR-Z0-9]{17}/g;
  const listings = html.match(/"vin":"([A-HJ-NPR-Z0-9]{17})"/g) || [];

  const seen = new Set();
  for (const l of listings) {
    const vinM = /"vin":"([A-HJ-NPR-Z0-9]{17})"/.exec(l);
    if (vinM && !seen.has(vinM[1])) {
      seen.add(vinM[1]);
      vehicles.push({
        vin:         vinM[1],
        trim:        isRaptorR ? 'Raptor R' : 'Raptor',
        model:       'F-150',
        dealer_name: 'See AutoTrader',
        dealer_city: '',
        dealer_state:'TX',
        dealer_url:  null,
        vehicle_url: `https://www.autotrader.com/cars-for-sale/new-cars/ford/f-150/${MIDLAND_ZIP}?trim=${trim}`,
        msrp:        null,
        color:       null,
        model_year:  CURRENT_YEAR,
      });
    }
  }
  return vehicles;
}

function buildFordUrl(v) {
  const vin    = v.VIN || v.vin || '';
  const dealer = v.DealerCode || v.dealerCode || '';
  if (vin && dealer) return `https://shop.ford.com/inventory/FordVehicleDetailPage?dealerCode=${dealer}&vin=${vin}`;
  return v.VehicleDetailUrl || v.vehicleDetailUrl || null;
}

function normalizeFord(raw, model, isR) {
  const vin = (raw.VIN || raw.vin || raw.Vin || '').trim().toUpperCase();
  if (!vin || vin.length !== 17) return null;
  return {
    vin,
    model_year:   parseInt(raw.ModelYear   || raw.modelYear   || CURRENT_YEAR),
    model:        raw.Model                || raw.model                || model,
    trim:         raw.Trim                 || raw.trim                 || (isR ? 'Raptor R' : 'Raptor'),
    color:        raw.ExtColor             || raw.extColor             || null,
    msrp:         parseFloat(raw.MSRP      || raw.msrp                || 0) || null,
    dealer_name:  raw.DealerName           || raw.dealerName           || 'Unknown Dealer',
    dealer_city:  raw.DealerCity           || raw.dealerCity           || '',
    dealer_state: raw.DealerState          || raw.dealerState          || 'TX',
    dealer_url:   raw.DealerWebsite        || raw.dealerUrl            || null,
    vehicle_url:  buildFordUrl(raw),
  };
}

export async function scrapeRaptors() {
  const vinMap = new Map();

  // ── Try Ford's own API first (parallel) ──────────────────
  console.log('Querying Ford API in parallel...');
  const fordResults = await Promise.allSettled(
    RAPTOR_TRIMS.map(({ model, trim, isR }) =>
      queryFordAPI(model, trim).then(rows => ({ rows, model, isR }))
    )
  );

  let fordCount = 0;
  for (const r of fordResults) {
    if (r.status === 'rejected') { console.error('Ford API error:', r.reason?.message); continue; }
    const { rows, model, isR } = r.value;
    console.log(`Ford ${model} ${isR?'Raptor R':'Raptor'}: ${rows.length} results`);
    for (const raw of rows) {
      const v = normalizeFord(raw, model, isR);
      if (v && !vinMap.has(v.vin)) { vinMap.set(v.vin, v); fordCount++; }
    }
  }

  // ── If Ford API returned nothing, try Cars.com + AutoTrader ──
  if (fordCount === 0) {
    console.log('Ford API returned 0 results — trying Cars.com fallback...');
    const fallbackResults = await Promise.allSettled([
      queryCarscom(false),
      queryCarscom(true),
    ]);

    for (const r of fallbackResults) {
      if (r.status === 'rejected') { console.error('Cars.com error:', r.reason?.message); continue; }
      for (const v of r.value) {
        if (v.vin && v.vin.length === 17 && !vinMap.has(v.vin)) vinMap.set(v.vin, v);
      }
    }

    if (vinMap.size === 0) {
      console.log('Cars.com returned 0 — trying AutoTrader...');
      const atResults = await Promise.allSettled([
        queryAutoTrader(false),
        queryAutoTrader(true),
      ]);
      for (const r of atResults) {
        if (r.status === 'rejected') { console.error('AutoTrader error:', r.reason?.message); continue; }
        for (const v of r.value) {
          if (v.vin && !vinMap.has(v.vin)) vinMap.set(v.vin, v);
        }
      }
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

  console.log(`Total found: ${vehicles.length} (${raptors.length} Raptor, ${raptorRs.length} Raptor R)`);

  return {
    total:   vehicles.length,
    raptor:  raptors.length,
    raptorR: raptorRs.length,
    vehicles,
    dealers: Array.from(dealerMap.values()).sort((a,b) => (b.raptor+b.raptorR)-(a.raptor+a.raptorR)),
    hasData: vehicles.length > 0,
  };
}

// ── WTI CRUDE PRICE ───────────────────────────────────────
// Tries EIA first (most accurate, official US gov data)
// Falls back to Yahoo Finance front-month futures
export async function fetchWTI() {
  // Try EIA first
  if (process.env.EIA_API_KEY) {
    try {
      const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(WTI_TIMEOUT) });
      if (res.ok) {
        const json  = await res.json();
        const rows  = json?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price) {
          console.log(`WTI from EIA: $${price}`);
          return { price, prevPrice: prev, change: price && prev ? price - prev : null };
        }
      }
    } catch (e) { console.error('EIA failed:', e.message); }
  }

  // Yahoo Finance — use front-month continuous contract
  // CL=F is the front-month WTI futures contract
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1d&range=5d',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(WTI_TIMEOUT),
      }
    );
    if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
    const data  = await res.json();
    const meta  = data?.chart?.result?.[0]?.meta;
    // Use regularMarketPrice — this is the current session price
    const price = meta?.regularMarketPrice || null;
    const prev  = meta?.chartPreviousClose || meta?.previousClose || null;
    if (price) {
      console.log(`WTI from Yahoo: $${price}`);
      return { price, prevPrice: prev, change: price && prev ? price - prev : null };
    }
  } catch (e) { console.error('Yahoo Finance failed:', e.message); }

  // Last resort — Commodities API (no key needed for basic)
  try {
    const res = await fetch('https://commodities-api.com/api/latest?access_key=demo&base=USD&symbols=CRUDEOIL', {
      signal: AbortSignal.timeout(WTI_TIMEOUT),
    });
    if (res.ok) {
      const data  = await res.json();
      const raw   = data?.data?.rates?.CRUDEOIL;
      if (raw) {
        const price = 1 / raw; // API returns USD per unit, invert for price per barrel
        return { price, prevPrice: null, change: null };
      }
    }
  } catch (e) { console.error('Commodities API failed:', e.message); }

  return { price: null, prevPrice: null, change: null };
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
