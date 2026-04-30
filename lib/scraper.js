// Raptor Inventory Scraper
// Uses Anthropic API with web_search to find Google-indexed individual listing pages
// Searches "site:dealerurl.com new raptor 2025 OR 2026" for each dealer
// Individual VDP (vehicle detail pages) ARE indexed by Google and contain full data

import { DEALERS } from './dealers.js';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const WTI_TIMEOUT   = 5000;

function buildPrompt() {
  // Build targeted search strings for each dealer
  const searches = DEALERS.map(d => {
    const domain = d.url.replace('https://www.','').replace('https://','').replace(/\/.*$/,'');
    return `site:${domain} new "f-150" "raptor" 2025 OR 2026`;
  });

  return `I need you to search for new Ford F-150 Raptor and Raptor R trucks currently listed for sale at specific dealerships near Midland TX.

Please run these searches and collect every individual vehicle listing page you find. Each listing page will show a specific truck with its VIN, price, trim, and dealer info.

Search queries to run (run each one):
${searches.map((s,i) => `${i+1}. "${s}"`).join('\n')}

Also search:
- "new ford raptor" site:rogersford.com
- "new ford raptor" site:sewellford.com  
- "new ford f-150 raptor" midland texas OR odessa texas 2026 new in stock
- "new ford raptor" site:starfordbigspring.com
- "new ford raptor" site:baileytoliverford.com
- "new ford raptor" site:arrowford.net

For EACH individual vehicle listing page you find (not the inventory index page, but the actual single-vehicle detail page), extract:
- VIN (17 characters — always shown on listing pages)
- Trim (must say "Raptor" or "Raptor R" — skip regular F-150s)
- Year
- Price/MSRP (the number shown, or null if not listed)
- Dealer name
- Dealer city and state
- The direct URL to that specific vehicle's page

Only include NEW vehicles, not used/pre-owned.

Return ONLY valid JSON, no markdown:
{
  "wtiPrice": <current WTI crude oil price as decimal, search for it>,
  "vehicles": [
    {
      "vin": "<17-char VIN>",
      "trim": "<Raptor or Raptor R>",
      "model_year": <year as number>,
      "model": "<F-150 or Ranger>",
      "dealer_name": "<dealer name>",
      "dealer_city": "<city>",
      "dealer_state": "<TX or NM>",
      "msrp": <price as integer cents, e.g. 8500000 for $85000, or null>,
      "vehicle_url": "<direct URL to this truck's listing page>",
      "dealer_url": "<dealer homepage URL>"
    }
  ],
  "commentary": "<sardonic one-liner: low truck inventory = boom times in Permian Basin, high inventory = bust>"
}`;
}

export async function scrapeRaptors() {
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
      messages:   [{ role: 'user', content: buildPrompt() }],
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    throw new Error(`Anthropic API ${res.status}: ${txt.slice(0,200)}`);
  }
  const data = await res.json();

  // Extract text
  let rawText = '';
  for (const block of (data.content || [])) {
    if (block.type === 'text') rawText += block.text;
  }

  // Log the raw response for debugging (shows in Vercel logs)
  console.log('[scraper] Raw response length:', rawText.length);
  console.log('[scraper] Raw response preview:', rawText.slice(0,500));

  // Parse JSON
  rawText = rawText.replace(/```json|```/g, '').trim();
  const start = rawText.indexOf('{');
  const end   = rawText.lastIndexOf('}');
  if (start < 0 || end < 0) {
    console.error('[scraper] No JSON found. Full response:', rawText.slice(0,1000));
    throw new Error('No JSON in Anthropic response');
  }

  const result = JSON.parse(rawText.slice(start, end + 1));
  console.log('[scraper] Parsed result:', JSON.stringify(result).slice(0,500));

  // Deduplicate by VIN
  const vinMap = new Map();
  for (const v of (result.vehicles || [])) {
    const vin = (v.vin || '').trim().toUpperCase();
    const key = (vin && vin.length === 17) ? vin : `${v.dealer_name}||${v.trim}||${v.model_year}||${v.msrp}`;
    if (!vinMap.has(key)) {
      // Convert msrp: if it looks like cents (>100000) convert to dollars, otherwise keep as is
      let msrp = v.msrp ? parseFloat(v.msrp) : null;
      if (msrp && msrp > 500000) msrp = msrp / 100; // was in cents
      if (msrp && msrp < 1000) msrp = msrp * 1000;  // was in thousands

      vinMap.set(key, {
        vin:          (vin && vin.length === 17) ? vin : null,
        model_year:   v.model_year || new Date().getFullYear(),
        model:        v.model      || 'F-150',
        trim:         v.trim       || 'Raptor',
        color:        null,
        msrp,
        dealer_name:  v.dealer_name  || 'Unknown',
        dealer_city:  v.dealer_city  || '',
        dealer_state: v.dealer_state || 'TX',
        dealer_url:   v.dealer_url   || null,
        vehicle_url:  v.vehicle_url  || null,
      });
    }
  }

  const vehicles = Array.from(vinMap.values());
  const raptors  = vehicles.filter(v => v.trim !== 'Raptor R');
  const raptorRs = vehicles.filter(v => v.trim === 'Raptor R');

  // Seed all known dealers at 0, then fill in from results
  const dealerMap = new Map();
  for (const d of DEALERS) {
    dealerMap.set(d.name, { name: d.name, city: d.city, state: d.state, url: d.url, miles: d.miles, raptor: 0, raptorR: 0 });
  }
  for (const v of vehicles) {
    const key = [...dealerMap.keys()].find(k =>
      k.toLowerCase().includes((v.dealer_name||'').toLowerCase().split(' ')[0]) ||
      (v.dealer_name||'').toLowerCase().includes(k.toLowerCase().split(' ')[0])
    ) || v.dealer_name;
    if (!dealerMap.has(key)) {
      dealerMap.set(key, { name: v.dealer_name, city: v.dealer_city, state: v.dealer_state, url: v.dealer_url, miles: null, raptor: 0, raptorR: 0 });
    }
    const d = dealerMap.get(key);
    if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
  }

  console.log(`[scraper] Final: ${vehicles.length} vehicles, ${raptors.length} Raptor, ${raptorRs.length} Raptor R`);

  return {
    total:      vehicles.length,
    raptor:     raptors.length,
    raptorR:    raptorRs.length,
    vehicles,
    dealers:    Array.from(dealerMap.values()).sort((a,b)=>(b.raptor+b.raptorR)-(a.raptor+a.raptorR)),
    commentary: result.commentary || null,
    hasData:    true,
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
    } catch (e) { console.error('[wti] EIA failed:', e.message); }
  }
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF?interval=1d&range=5d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(WTI_TIMEOUT) }
    );
    if (res.ok) {
      const data  = await res.json();
      const meta  = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || null;
      const prev  = meta?.chartPreviousClose || null;
      if (price) return { price, prevPrice: prev, change: price && prev ? price - prev : null };
    }
  } catch (e) { console.error('[wti] Yahoo failed:', e.message); }
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
