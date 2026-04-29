// /api/cron
// Vercel Cron Job — fires daily at 8AM CT (13:00 UTC)
// Configured in vercel.json
// Protected by CRON_SECRET header

import { scrapeRaptors, fetchWTI, generateCommentary } from '../lib/scraper.js';
import { supabase } from '../lib/supabase.js';

export const config = { maxDuration: 60 }; // Vercel Pro allows up to 300s; free tier 10s (scrape may need Pro)

export default async function handler(req, res) {
  // Security: only Vercel's cron runner (or you manually) can call this
  const secret = req.headers['authorization'];
  if (secret !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  console.log(`[cron] Starting daily scrape for ${today}`);

  try {
    // 1. Scrape Ford inventory
    const [inventory, wti] = await Promise.allSettled([
      scrapeRaptors(),
      fetchWTI(),
    ]);

    const inv    = inventory.status === 'fulfilled' ? inventory.value : { total:0, raptor:0, raptorR:0, vehicles:[], dealers:[], hasData:false };
    const oilData = wti.status === 'fulfilled' ? wti.value : { price:null, prevPrice:null };

    console.log(`[cron] Found ${inv.total} vehicles (${inv.raptor} Raptor, ${inv.raptorR} Raptor R)`);

    const commentary = generateCommentary(inv.total, oilData);

    // 2. Upsert daily snapshot
    const { error: snapErr } = await supabase
      .from('snapshots')
      .upsert({
        snap_date:  today,
        total:      inv.total,
        raptor:     inv.raptor,
        raptor_r:   inv.raptorR,
        wti_price:  oilData.price,
        commentary,
        scraped_at: new Date().toISOString(),
      }, { onConflict: 'snap_date' });

    if (snapErr) throw new Error('Snapshot upsert: ' + snapErr.message);

    // 3. Upsert each vehicle by VIN
    if (inv.vehicles.length > 0) {
      for (const v of inv.vehicles) {
        // Try to find existing record for this VIN
        const { data: existing } = await supabase
          .from('vehicles')
          .select('id, first_seen')
          .eq('vin', v.vin)
          .maybeSingle();

        if (existing) {
          // Update last_seen and current details
          await supabase
            .from('vehicles')
            .update({
              last_seen:    today,
              active:       true,
              msrp:         v.msrp,
              dealer_name:  v.dealer_name,
              dealer_city:  v.dealer_city,
              dealer_url:   v.dealer_url,
              vehicle_url:  v.vehicle_url,
              color:        v.color,
            })
            .eq('vin', v.vin);
        } else {
          // New VIN — insert fresh
          await supabase
            .from('vehicles')
            .insert({
              ...v,
              first_seen: today,
              last_seen:  today,
              active:     true,
            });
        }

        // Log daily presence
        await supabase
          .from('vehicle_daily')
          .upsert({ snap_date: today, vin: v.vin, dealer_name: v.dealer_name }, { onConflict: 'snap_date,vin' });
      }

      // Mark VINs NOT seen today as inactive (they've been sold or moved)
      const activeVins = inv.vehicles.map(v => v.vin);
      await supabase
        .from('vehicles')
        .update({ active: false })
        .eq('active', true)
        .not('vin', 'in', `(${activeVins.map(v => `'${v}'`).join(',')})`);
    }

    console.log(`[cron] Done. Snapshot saved for ${today}.`);

    return res.status(200).json({
      success:     true,
      date:        today,
      total:       inv.total,
      raptor:      inv.raptor,
      raptorR:     inv.raptorR,
      wtiPrice:    oilData.price,
      vinCount:    inv.vehicles.length,
    });

  } catch (err) {
    console.error('[cron] Fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
