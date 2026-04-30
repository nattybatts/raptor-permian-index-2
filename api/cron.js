import { scrapeRaptors, fetchWTI, generateCommentary } from '../lib/scraper.js';
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[cron] ${today} — starting Marketcheck scrape`);

  let inv, wti;
  try {
    [inv, wti] = await Promise.all([scrapeRaptors(), fetchWTI()]);
  } catch (err) {
    console.error('[cron] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const wtiPrice   = wti?.price || null;
  const commentary = generateCommentary(inv.total, wti);
  console.log(`[cron] ${inv.total} vehicles, WTI $${wtiPrice}`);

  // Save snapshot
  const { error: snapErr } = await supabase
    .from('snapshots')
    .upsert({
      snap_date:    today,
      total:        inv.total,
      raptor:       inv.raptor,
      raptor_r:     inv.raptorR,
      wti_price:    wtiPrice,
      commentary,
      scraped_at:   new Date().toISOString(),
      avg_days_lot: inv.vehicles.length
        ? Math.round(inv.vehicles.reduce((s, v) => s + (v.days_on_lot || 0), 0) / inv.vehicles.length)
        : null,
    }, { onConflict: 'snap_date' });
  if (snapErr) console.error('[cron] snapshot error:', snapErr.message);

  // Mark all currently active as inactive first
  await supabase.from('vehicles').update({ active: false }).eq('active', true);

  if (inv.vehicles.length > 0) {
    const currentVins = inv.vehicles.map(v => v.vin).filter(Boolean);

    // Get first_seen dates for VINs we've seen before (preserve history)
    const { data: existing } = await supabase
      .from('vehicles')
      .select('vin, first_seen')
      .in('vin', currentVins);

    const firstSeenMap = {};
    for (const e of (existing || [])) firstSeenMap[e.vin] = e.first_seen;

    const rows = inv.vehicles.map(v => ({
      vin:             v.vin,
      model_year:      v.model_year,
      model:           'F-150',
      trim:            v.trim,
      color:           v.color            || null,
      msrp:            v.msrp             || null,
      dealer_name:     v.dealer_name,
      dealer_city:     v.dealer_city,
      dealer_state:    v.dealer_state     || 'TX',
      dealer_url:      v.dealer_url       || null,
      vehicle_url:     v.vehicle_url      || null,
      dealer_lat:      v.dealer_lat       || null,
      dealer_lng:      v.dealer_lng       || null,
      days_on_lot:     v.days_on_lot      || 0,
      days_on_lot_180: v.days_on_lot_180  || v.days_on_lot || 0,
      first_listed:    v.first_listed     || null,
      // Preserve original first_seen if we've seen this VIN before
      first_seen:      firstSeenMap[v.vin] || today,
      last_seen:       today,
      active:          true,
    }));

    const { error: vErr } = await supabase
      .from('vehicles')
      .upsert(rows, { onConflict: 'vin', ignoreDuplicates: false });
    if (vErr) console.error('[cron] vehicle error:', vErr.message);
  }

  console.log('[cron] complete ✓');

  return res.status(200).json({
    success:  true,
    date:     today,
    total:    inv.total,
    raptor:   inv.raptor,
    raptorR:  inv.raptorR,
    wti:      wtiPrice,
    vehicles: inv.vehicles.length,
    avgDays:  inv.vehicles.length
      ? Math.round(inv.vehicles.reduce((s, v) => s + (v.days_on_lot || 0), 0) / inv.vehicles.length)
      : 0,
  });
}
