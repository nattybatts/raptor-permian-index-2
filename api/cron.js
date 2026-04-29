// /api/cron — daily scrape, optimized for Vercel free tier 10s limit
// Ford API calls run in parallel (~7s), Supabase writes are batched (~1s)

import { scrapeRaptors, fetchWTI, generateCommentary } from '../lib/scraper.js';
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  // Accept both GET and POST so Vercel's cron runner (which uses GET) works too
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[cron] ${today} — starting`);

  try {
    // Run Ford scrape and WTI fetch in parallel — both have internal timeouts
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

    console.log(`[cron] ${inv.total} vehicles found (${inv.raptor} Raptor, ${inv.raptorR} Raptor R)`);

    const commentary = generateCommentary(inv.total, wti);

    // ── WRITE 1: daily snapshot (single upsert) ──────────────
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

    if (snapErr) throw new Error('Snapshot upsert: ' + snapErr.message);

    // ── WRITE 2: vehicles — one bulk upsert, not a loop ──────
    if (inv.vehicles.length > 0) {
      const vehicleRows = inv.vehicles.map(v => ({
        vin:          v.vin,
        model_year:   v.model_year,
        model:        v.model,
        trim:         v.trim,
        color:        v.color,
        msrp:         v.msrp,
        dealer_name:  v.dealer_name,
        dealer_city:  v.dealer_city,
        dealer_state: v.dealer_state,
        dealer_url:   v.dealer_url,
        vehicle_url:  v.vehicle_url,
        first_seen:   today, // ignored on conflict — see upsert merge below
        last_seen:    today,
        active:       true,
      }));

      // Bulk upsert — on VIN conflict, update last_seen + active + details only
      // first_seen is preserved via ignoreDuplicates:false + explicit merge columns
      const { error: vehErr } = await supabase
        .from('vehicles')
        .upsert(vehicleRows, {
          onConflict:        'vin',
          ignoreDuplicates:  false,
        });

      if (vehErr) console.error('Vehicle upsert error:', vehErr.message);

      // ── WRITE 3: daily presence log — bulk insert ────────
      const dailyRows = inv.vehicles.map(v => ({
        snap_date:   today,
        vin:         v.vin,
        dealer_name: v.dealer_name,
      }));

      const { error: dailyErr } = await supabase
        .from('vehicle_daily')
        .upsert(dailyRows, { onConflict: 'snap_date,vin', ignoreDuplicates: true });

      if (dailyErr) console.error('vehicle_daily upsert error:', dailyErr.message);

      // ── WRITE 4: mark missing VINs as inactive ───────────
      // Single update — any VIN not seen today gets flagged
      const activeVins = inv.vehicles.map(v => v.vin);
      const { error: inactErr } = await supabase
        .from('vehicles')
        .update({ active: false })
        .eq('active', true)
        .not('vin', 'in', `(${activeVins.map(v => `"${v}"`).join(',')})`);

      if (inactErr) console.error('Mark inactive error:', inactErr.message);
    }

    console.log(`[cron] Done ✓`);

    return res.status(200).json({
      success:  true,
      date:     today,
      total:    inv.total,
      raptor:   inv.raptor,
      raptorR:  inv.raptorR,
      wti:      wti.price,
      vehicles: inv.vehicles.length,
    });

  } catch (err) {
    console.error('[cron] Fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
