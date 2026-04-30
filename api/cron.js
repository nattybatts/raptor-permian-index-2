// /api/cron — runs synchronously, waits for full result before responding
// Vercel cron jobs get 60s even on free tier (unlike regular functions which get 10s)

import { scrapeRaptors, fetchWTI, generateCommentary } from '../lib/scraper.js';
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[cron] ${today} — starting`);

  // Run scrape and WTI fetch in parallel, wait for both
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

  if (invResult.status === 'rejected') {
    console.error('[cron] scrape error:', invResult.reason?.message);
  }

  console.log(`[cron] found ${inv.total} vehicles, WTI $${wti.price}`);

  const commentary = inv.commentary || generateCommentary(inv.total, wti);

  // Save snapshot
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

  if (snapErr) console.error('[cron] snapshot error:', snapErr.message);

  // Save vehicles
  if (inv.vehicles.length > 0) {
    const rows = inv.vehicles.map((v, i) => ({
      vin:          v.vin || `SRCH-${today}-${i}`.padEnd(17, '0').slice(0, 17),
      model_year:   v.model_year,
      model:        v.model,
      trim:         v.trim,
      color:        v.color || null,
      msrp:         v.msrp || null,
      dealer_name:  v.dealer_name,
      dealer_city:  v.dealer_city,
      dealer_state: v.dealer_state || 'TX',
      dealer_url:   v.dealer_url || null,
      vehicle_url:  v.vehicle_url || null,
      first_seen:   today,
      last_seen:    today,
      active:       true,
    }));

    const { error: vErr } = await supabase
      .from('vehicles')
      .upsert(rows, { onConflict: 'vin', ignoreDuplicates: false });
    if (vErr) console.error('[cron] vehicle error:', vErr.message);

    // Mark old VINs inactive
    const vins = rows.map(r => r.vin).filter(v => !v.startsWith('SRCH'));
    if (vins.length > 0) {
      await supabase.from('vehicles')
        .update({ active: false })
        .eq('active', true)
        .not('vin', 'in', `(${vins.map(v => `"${v}"`).join(',')})`);
    }
  }

  console.log('[cron] complete');

  return res.status(200).json({
    success:  true,
    date:     today,
    total:    inv.total,
    raptor:   inv.raptor,
    raptorR:  inv.raptorR,
    wti:      wti.price,
    vehicles: inv.vehicles.length,
  });
}
