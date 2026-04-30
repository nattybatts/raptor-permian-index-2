import { scrapeRaptors, fetchWTI, generateCommentary } from '../lib/scraper.js';
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[cron] ${today} — starting full scrape`);

  const [invResult, wtiResult] = await Promise.allSettled([
    scrapeRaptors(),
    fetchWTI(),
  ]);

  const inv = invResult.status === 'fulfilled'
    ? invResult.value
    : { total: 0, raptor: 0, raptorR: 0, vehicles: [], dealers: [], hasData: false };

  if (invResult.status === 'rejected') {
    console.error('[cron] scrape error:', invResult.reason?.message);
  }

  // Prefer Alpha Vantage/EIA from fetchWTI over anything else
  const wti = wtiResult.status === 'fulfilled' ? wtiResult.value : { price: null };
  const wtiPrice = wti.price || inv.wtiPrice || null;
  console.log(`[cron] ${inv.total} vehicles, WTI source price: $${wti.price}, final: $${wtiPrice}`);

  const commentary = inv.commentary || generateCommentary(inv.total, { price: wtiPrice });

  // Save snapshot
  const { error: snapErr } = await supabase
    .from('snapshots')
    .upsert({
      snap_date:  today,
      total:      inv.total,
      raptor:     inv.raptor,
      raptor_r:   inv.raptorR,
      wti_price:  wtiPrice,
      commentary,
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'snap_date' });

  if (snapErr) console.error('[cron] snapshot error:', snapErr.message);

  // WIPE today's vehicles completely, then reinsert fresh
  // This prevents accumulation across multiple runs on same day
  const { error: deleteErr } = await supabase
    .from('vehicles')
    .delete()
    .eq('last_seen', today);

  if (deleteErr) console.error('[cron] delete error:', deleteErr.message);

  // Also mark everything active=false, then reactivate only today's finds
  await supabase.from('vehicles').update({ active: false }).eq('active', true);

  if (inv.vehicles.length > 0) {
    const rows = inv.vehicles.map((v, i) => ({
      vin:          v.vin || `SRCH-${today}-${i}`.slice(0, 17),
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

    const { error: insertErr } = await supabase
      .from('vehicles')
      .upsert(rows, { onConflict: 'vin', ignoreDuplicates: false });

    if (insertErr) console.error('[cron] insert error:', insertErr.message);
  }

  console.log('[cron] complete');

  return res.status(200).json({
    success:  true,
    date:     today,
    total:    inv.total,
    raptor:   inv.raptor,
    raptorR:  inv.raptorR,
    wti:      wtiPrice,
    vehicles: inv.vehicles.length,
  });
}
