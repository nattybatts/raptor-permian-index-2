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
      snap_date:  today,
      total:      inv.total,
      raptor:     inv.raptor,
      raptor_r:   inv.raptorR,
      wti_price:  wtiPrice,
      commentary,
      scraped_at: new Date().toISOString(),
    }, { onConflict: 'snap_date' });
  if (snapErr) console.error('[cron] snapshot error:', snapErr.message);

  // Wipe today's vehicles and reinsert clean
  await supabase.from('vehicles').delete().eq('last_seen', today);
  await supabase.from('vehicles').update({ active: false }).eq('active', true);

  if (inv.vehicles.length > 0) {
    const rows = inv.vehicles.map(v => ({
      vin:          v.vin,
      model_year:   v.model_year,
      model:        'F-150',
      trim:         v.trim,
      color:        v.color || null,
      msrp:         v.msrp || null,
      dealer_name:  v.dealer_name,
      dealer_city:  v.dealer_city,
      dealer_state: v.dealer_state || 'TX',
      dealer_url:   v.dealer_url   || null,
      vehicle_url:  v.vehicle_url  || null,
      first_seen:   today,
      last_seen:    today,
      active:       true,
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
  });
}
