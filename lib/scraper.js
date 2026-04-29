// Raptor Inventory Scraper
// Uses Anthropic API with web_search tool to find current Raptor inventory
// near Midland TX — most reliable approach since Ford's direct API is flaky
// WTI price via Yahoo Finance / EIA

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const WTI_TIMEOUT   = 5000;

export async function scrapeRaptors() {
  const prompt = `Search for current new Ford F-150 Raptor and Ford F-150 Raptor R truck inventory at Ford dealerships within 150 miles of Midland, TX (zip code 79701).

Search these sources:
- Ford dealer websites in Midland TX, Odessa TX, Lubbock TX, Abilene TX, San Angelo TX
- Cars.com new inventory near 79701
- AutoTrader new Ford Raptor near Midland TX
- Any Ford dealer inventory pages you can find

I need ONLY Ford F-150 Raptor and Raptor R trucks. Not regular F-150s, not other trims. The trim must specifically say "Raptor" or "Raptor R".

For each truck found return the VIN if visible, dealer name, dealer city, trim (Raptor or Raptor R), MSRP if shown, and a URL link to that specific vehicle if available.

Respond ONLY with a valid JSON object, no markdown, no explanation:
{
  "raptorCount": <number of F-150 Raptors and Ranger Raptors found>,
  "raptorRCount": <number of Raptor R trucks found>,
  "vehicles": [
    {
      "vin": "<17-char VIN or empty string if not found>",
      "trim": "<Raptor or Raptor R>",
      "model": "<F-150 or Ranger>",
      "dealer_name": "<dealer name>",
      "dealer_city": "<city, TX>",
      "msrp": <number or null>,
      "vehicle_url": "<direct link to this truck or null>",
      "dealer_url": "<dealer website or null>"
    }
  ],
  "source": "<which source had the most results>"
}`;

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(55000), // Vercel Pro would need this; on free we rely on cron not timing out
  });

  if (!res.ok) throw new Error(`Anthropic API HTTP ${res.status}`);
  const data = await res.json();

  // Extract text from response
  let rawText = '';
  for (const block of (data.content || [])) {
    if (block.type === 'text') rawText += block.text;
  }

  // Parse JSON from response
  rawText = rawText.replace(/```json|```/g, '').trim();
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('No JSON in Anthropic response');

  const result = JSON.parse(rawText.slice(start, end + 1));

  // Normalize vehicles
  const vinMap = new Map();
  for (const v of (result.vehicles || [])) {
    const vin = (v.vin || '').trim().toUpperCase();
    // Use VIN as key if valid, otherwise use dealer+trim combo as dedup key
    const key = (vin && vin.length === 17) ? vin : `${v.dealer_name}-${v.trim}-${v.msrp}`;
    if (!vinMap.has(key)) {
      vinMap.set(key, {
        vin:          (vin && vin.length === 17) ? vin : null,
        model_year:   new Date().getFullYear(),
        model:        v.model || 'F-150',
        trim:         v.trim  || 'Raptor',
        color:        null,
        msrp:         v.msrp  || null,
        dealer_name:  v.dealer_name  || 'Unknown Dealer',
        dealer_city:  v.dealer_city  || '',
        dealer_state: 'TX',
        dealer_url:   v.dealer_url   || null,
        vehicle_url:  v.vehicle_url  || null,
      });
    }
  }

  const vehicles = Array.from(vinMap.values());
  const raptors  = vehicles.filter(v => v.trim !== 'Raptor R');
  const raptorRs = vehicles.filter(v => v.trim === 'Raptor R');

  const dealerMap = new Map();
  for (const v of vehicles) {
    if (!dealerMap.has(v.dealer_name)) {
      dealerMap.set(v.dealer_name, {
        name: v.dealer_name, city: v.dealer_city,
        url: v.dealer_url, raptor: 0, raptorR: 0,
      });
    }
    const d = dealerMap.get(v.dealer_name);
    if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
  }

  console.log(`Anthropic search found: ${vehicles.length} vehicles (source: ${result.source || 'unknown'})`);

  return {
    total:   vehicles.length,
    raptor:  raptors.length,
    raptorR: raptorRs.length,
    vehicles,
    dealers: Array.from(dealerMap.values()).sort((a,b) => (b.raptor+b.raptorR)-(a.raptor+a.raptorR)),
    hasData: vehicles.length > 0,
  };
}

export async function fetchWTI() {
  // EIA first (official, most accurate)
  if (process.env.EIA_API_KEY) {
    try {
      const url = `https://api.eia.gov/v2/petroleum/pri/spt/data/?api_key=${process.env.EIA_API_KEY}&frequency=daily&data[0]=value&facets[series][]=RWTC&sort[0][column]=period&sort[0][direction]=desc&length=2`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(WTI_TIMEOUT) });
      if (res.ok) {
        const json  = await res.json();
        const rows  = json?.response?.data || [];
        const price = rows[0]?.value ? parseFloat(rows[0].value) : null;
        const prev  = rows[1]?.value ? parseFloat(rows[1].value) : null;
        if (price) return { price, prevPrice: prev, change: price && prev ? price - prev : null };
      }
    } catch (e) { console.error('EIA failed:', e.message); }
  }

  // Yahoo Finance fallback — front-month WTI futures
  try {
    const res = await fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1d&range=5d',
      {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(WTI_TIMEOUT),
      }
    );
    if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
    const data  = await res.json();
    const meta  = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice || null;
    const prev  = meta?.chartPreviousClose || meta?.previousClose || null;
    if (price) return { price, prevPrice: prev, change: price && prev ? price - prev : null };
  } catch (e) { console.error('Yahoo Finance failed:', e.message); }

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
