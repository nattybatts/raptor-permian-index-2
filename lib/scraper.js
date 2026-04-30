// Raptor Inventory Scraper
// Strategy: Use Anthropic API with web_search to check each specific dealership
// by name + city. This is more reliable than guessing URL patterns since
// dealer platforms vary and change frequently.
// Falls back to a broad area search if individual dealer searches fail.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const WTI_TIMEOUT   = 5000;

import { DEALERS } from './dealers.js';

// Build a targeted prompt that names every specific dealership
function buildPrompt() {
  const dealerList = DEALERS.map(d =>
    `- ${d.name} in ${d.city}, ${d.state} (${d.miles} miles from Midland) — website: ${d.url}`
  ).join('\n');

  return `Search the new vehicle inventory at each of these specific Ford dealerships for Ford F-150 Raptor and Ford F-150 Raptor R trucks currently in stock. These are all within 150 miles of Midland TX.

DEALERSHIPS TO CHECK:
${dealerList}

For each dealership, visit their website inventory page and look for:
1. New Ford F-150 Raptor (any year)
2. New Ford F-150 Raptor R (any year)
3. New Ford Ranger Raptor if applicable

Do NOT count used vehicles. New inventory only.
Do NOT count regular F-150s — trim must specifically say "Raptor" or "Raptor R".

For each Raptor truck found, provide:
- VIN (17 characters, shown on the listing)
- Trim (Raptor or Raptor R)
- Model year
- Price/MSRP (exact number if shown, null if not listed)
- Dealer name
- Dealer city
- Direct URL to that specific vehicle listing

Also find the current WTI crude oil spot price.

Respond ONLY with valid JSON, no markdown:
{
  "wtiPrice": <number>,
  "vehicles": [
    {
      "vin": "<17-char VIN or empty string if not visible>",
      "trim": "<Raptor or Raptor R>",
      "model_year": <year as number>,
      "model": "<F-150 or Ranger>",
      "dealer_name": "<exact dealer name from list above>",
      "dealer_city": "<city>",
      "dealer_state": "<TX or NM>",
      "msrp": <price as number, or null if not listed>,
      "vehicle_url": "<direct link to this specific truck listing, or null>",
      "dealer_url": "<dealer website homepage>"
    }
  ],
  "dealersSummary": [
    {
      "dealer_name": "<name>",
      "dealer_city": "<city>",
      "raptor_count": <number>,
      "raptor_r_count": <number>,
      "checked": true
    }
  ],
  "commentary": "<one sardonic sentence about what this inventory level means for Permian Basin OFS — remember: LOW inventory = GOOD (workers buying = boom), HIGH inventory = BAD (trucks sitting = bust)>"
}`;
}

export async function scrapeRaptors() {
  const prompt = buildPrompt();

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8000,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();

  // Extract text blocks
  let rawText = '';
  for (const block of (data.content || [])) {
    if (block.type === 'text') rawText += block.text;
  }

  rawText = rawText.replace(/```json|```/g, '').trim();
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON in response. Raw: ' + rawText.slice(0, 300));

  const result = JSON.parse(rawText.slice(start, end + 1));

  // Deduplicate by VIN
  const vinMap = new Map();
  for (const v of (result.vehicles || [])) {
    const vin = (v.vin || '').trim().toUpperCase();
    const key = (vin && vin.length === 17) ? vin : `${v.dealer_name}||${v.trim}||${v.msrp}||${v.model_year}`;
    if (!vinMap.has(key)) {
      vinMap.set(key, {
        vin:          (vin && vin.length === 17) ? vin : null,
        model_year:   v.model_year || new Date().getFullYear(),
        model:        v.model      || 'F-150',
        trim:         v.trim       || 'Raptor',
        color:        null,
        msrp:         v.msrp       || null,
        dealer_name:  v.dealer_name|| 'Unknown',
        dealer_city:  v.dealer_city|| '',
        dealer_state: v.dealer_state || 'TX',
        dealer_url:   v.dealer_url  || null,
        vehicle_url:  v.vehicle_url || null,
      });
    }
  }

  const vehicles = Array.from(vinMap.values());
  const raptors  = vehicles.filter(v => v.trim !== 'Raptor R');
  const raptorRs = vehicles.filter(v => v.trim === 'Raptor R');

  // Build dealer summary — merge search results with our known dealer list
  const dealerMap = new Map();

  // Seed with all known dealers showing 0
  for (const d of DEALERS) {
    dealerMap.set(d.name, {
      name:     d.name,
      city:     d.city,
      state:    d.state,
      url:      d.url,
      miles:    d.miles,
      raptor:   0,
      raptorR:  0,
      checked:  false,
    });
  }

  // Fill in from vehicles found
  for (const v of vehicles) {
    // Try to match to known dealer
    const key = [...dealerMap.keys()].find(k =>
      k.toLowerCase().includes(v.dealer_name.toLowerCase().split(' ')[0]) ||
      v.dealer_name.toLowerCase().includes(k.toLowerCase().split(' ')[0])
    ) || v.dealer_name;

    if (!dealerMap.has(key)) {
      dealerMap.set(key, { name: v.dealer_name, city: v.dealer_city, state: v.dealer_state, url: v.dealer_url, miles: null, raptor: 0, raptorR: 0, checked: true });
    }
    const d = dealerMap.get(key);
    d.checked = true;
    if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
  }

  // Mark checked dealers from summary
  for (const s of (result.dealersSummary || [])) {
    const key = [...dealerMap.keys()].find(k => k.toLowerCase().includes(s.dealer_name.toLowerCase().split(' ')[0]));
    if (key) dealerMap.get(key).checked = true;
  }

  const dealers = Array.from(dealerMap.values())
    .sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR));

  console.log(`Scrape complete: ${vehicles.length} vehicles across ${dealers.filter(d => d.checked).length} dealers checked`);

  return {
    total:      vehicles.length,
    raptor:     raptors.length,
    raptorR:    raptorRs.length,
    vehicles,
    dealers,
    commentary: result.commentary || null,
    hasData:    vehicles.length >= 0, // even 0 is valid data
  };
}

export async function fetchWTI() {
  if (process.env.EIA_API_KEY) {
    try {
      const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`;
      const res = await fetch(url, { signal: AbortSignal.timeout(WTI_TIMEOUT) });
      if (res.ok) {
        const json = await res.json();
        const rows = json?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price) return { price, prevPrice: prev, change: price && prev ? price - prev : null };
      }
    } catch (e) { console.error('EIA failed:', e.message); }
  }

  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(WTI_TIMEOUT) }
    );
    if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
    const data  = await res.json();
    const meta  = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || null;
    const prev  = meta?.chartPreviousClose || null;
    if (price) return { price, prevPrice: prev, change: price && prev ? price - prev : null };
  } catch (e) { console.error('Yahoo failed:', e.message); }

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
