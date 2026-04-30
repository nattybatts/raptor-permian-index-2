import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const [snapshotsRes, vehiclesRes, allVehiclesRes, donationsRes, soldRes] = await Promise.all([
      // Active snapshots for chart
      supabase.from('snapshots')
        .select('snap_date, total, raptor, raptor_r, wti_price, commentary, avg_days_lot')
        .order('snap_date', { ascending: true })
        .limit(90),

      // Active vehicles for current display
      supabase.from('vehicles')
        .select('vin, model_year, model, trim, color, interior_color, msrp, dealer_name, dealer_city, dealer_state, vehicle_url, dealer_url, dealer_lat, dealer_lng, days_on_lot, days_on_lot_180, first_listed, first_seen, last_seen, in_transit, vehicle_status, engine_size')
        .eq('active', true)
        .order('days_on_lot', { ascending: false }),

      // ALL vehicles ever seen (active + inactive) for rolling average
      supabase.from('vehicles')
        .select('vin, days_on_lot, days_on_lot_180, active, last_seen')
        .order('last_seen', { ascending: false })
        .limit(500),

      // Donations
      supabase.from('donations')
        .select('amount_cents, display_name, message, donated_at')
        .order('donated_at', { ascending: false })
        .limit(20),

      // Recently sold/delisted — inactive vehicles from last 60 days
      supabase.from('vehicles')
        .select('vin, model_year, trim, color, msrp, dealer_name, dealer_city, engine_size, first_seen, last_seen, first_listed, days_on_lot, vehicle_url, dealer_url')
        .eq('active', false)
        .gte('last_seen', new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0])
        .order('last_seen', { ascending: false })
        .limit(50),
    ]);

    // Build dealer summary from active vehicles
    const dealerMap = new Map();
    for (const v of (vehiclesRes.data || [])) {
      const key = v.dealer_name;
      if (!dealerMap.has(key)) {
        dealerMap.set(key, { name: v.dealer_name, city: v.dealer_city, state: v.dealer_state || 'TX', url: v.dealer_url, raptor: 0, raptorR: 0 });
      }
      const d = dealerMap.get(key);
      if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
    }
    const dealers = Array.from(dealerMap.values())
      .sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR));

    // Compute days on lot metrics
    const activeVehs = vehiclesRes.data || [];
    const allVehs    = allVehiclesRes.data || [];

    // Current active average
    const activeDays = activeVehs.filter(v => v.days_on_lot > 0).map(v => v.days_on_lot);
    const avgDaysActive = activeDays.length
      ? Math.round(activeDays.reduce((s, d) => s + d, 0) / activeDays.length)
      : null;

    // Rolling average including sold/delisted (all vehicles ever seen)
    const allDays = allVehs.filter(v => v.days_on_lot > 0).map(v => v.days_on_lot);
    const avgDaysAll = allDays.length
      ? Math.round(allDays.reduce((s, d) => s + d, 0) / allDays.length)
      : null;

    // Median days on lot (active)
    const sortedDays = [...activeDays].sort((a, b) => a - b);
    const medianDays = sortedDays.length
      ? sortedDays[Math.floor(sortedDays.length / 2)]
      : null;

    // Longest sitting truck
    const maxDays = activeDays.length ? Math.max(...activeDays) : null;

    const allDonations      = donationsRes.data || [];
    const totalDonatedCents = allDonations.reduce((s, d) => s + (d.amount_cents || 0), 0);

    return res.status(200).json({
      snapshots:    snapshotsRes.data || [],
      vehicles:     activeVehs,
      dealers,
      donations:    allDonations,
      totalDonatedCents,
      daysMetrics: {
        avgActive:  avgDaysActive,  // average days on lot for trucks currently in stock
        avgAll:     avgDaysAll,     // rolling average including sold/delisted
        median:     medianDays,     // median days on lot (active)
        max:        maxDays,        // longest sitting truck currently
        sampleSize: allDays.length, // total vehicles used for rolling avg
      },
      recentlySold:  soldRes?.data || [],
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
