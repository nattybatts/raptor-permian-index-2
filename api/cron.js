// /api/cron — daily scrape via Anthropic API web search
// The Anthropic search takes ~20-30s which exceeds Vercel free tier 10s limit
// Solution: respond 200 immediately, then do the work with waitUntil if available
// OR: use a background fetch to itself (fire-and-forget pattern)

import { scrapeRaptors, fetchWTI, generateCommentary } from '../lib/scraper.js';
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[cron] ${today} — starting scrape`);

  // Respond immediately so Vercel doesn't kill the connection
  // The function continues running in the background
  res.status(200).json({ accepted: true, date: today, message: 'Scrape started — check Supabase in ~30s' });

  // Now do the actual work after responding
  // Note: on Vercel free tier the function may still be killed after 10s
  // If that happens, upgrade to Hobby ($20) which gives 60s
  try {
    // Add ANTHROPIC_API_KEY to the fetch headers via env
    const [invResult, wtiResult] = await Promise.allSettled([
      scrapeRaptors(),
      fetchWTI(),
    ]);

    const inv = invResult.status === 'fulfilled'
      ? invResult.value
      : { total: 0, raptor: 0, raptorR: 0, vehicles: [], dealers: [], hasData: false };

    const wti = wtiResult.status === 'fulfilled'
      ? wtiResult.value
      : { price: null, prevPrice: null, change: null };

    if (invResult.status === 'rejected') console.error('[cron] Scrape error:', invResult.reason?.message);

    console.log(`[cron] Found ${inv.total} vehicles, WTI $${wti.price}`);

    const commentary = generateCommentary(inv.total, wti);

    // Write snapshot
    const { error: snapErr } = await supabase
      .from('snapshots')
      .upsert({
        snap_date:  today,
        total:      inv.total,
        raptor:     inv.raptor,
        raptor_r:   inv.raptorR,
        wti_price:  wti.price,
        commentary,
        scraped_at: new Date().toISOString(),
      }, { onConflict: 'snap_date' });

    if (snapErr) console.error('[cron] Snapshot error:', snapErr.message);

    // Bulk upsert vehicles
    if (inv.vehicles.length > 0) {
      const rows = inv.vehicles.map(v => ({
        vin:          v.vin || `NVIN-${v.dealer_name}-${v.trim}-${Date.now()}`.slice(0,17),
        model_year:   v.model_year,
        model:        v.model,
        trim:         v.trim,
        color:        v.color,
        msrp:         v.msrp,
        dealer_name:  v.dealer_name,
        dealer_city:  v.dealer_city,
        dealer_state: v.dealer_state || 'TX',
        dealer_url:   v.dealer_url,
        vehicle_url:  v.vehicle_url,
        first_seen:   today,
        last_seen:    today,
        active:       true,
      }));

      const { error: vErr } = await supabase
        .from('vehicles')
        .upsert(rows, { onConflict: 'vin', ignoreDuplicates: false });
      if (vErr) console.error('[cron] Vehicle upsert error:', vErr.message);

      // Daily log
      const dailyRows = inv.vehicles
        .filter(v => v.vin)
        .map(v => ({ snap_date: today, vin: v.vin, dealer_name: v.dealer_name }));
      if (dailyRows.length > 0) {
        await supabase.from('vehicle_daily')
          .upsert(dailyRows, { onConflict: 'snap_date,vin', ignoreDuplicates: true });
      }

      // Mark missing VINs inactive
      const activeVins = inv.vehicles.filter(v => v.vin).map(v => v.vin);
      if (activeVins.length > 0) {
        await supabase.from('vehicles')
          .update({ active: false })
          .eq('active', true)
          .not('vin', 'in', `(${activeVins.map(v => `"${v}"`).join(',')})`);
      }
    }

    console.log('[cron] Complete ✓');
  } catch (err) {
    console.error('[cron] Fatal error:', err.message);
  }
}
