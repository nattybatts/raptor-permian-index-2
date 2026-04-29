// GET /api/data
// Returns everything the frontend needs in one request
// Cached by Vercel edge for 1 hour

import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // Run all queries in parallel
    const [snapshotsRes, vehiclesRes, dealersRes, donationsRes] = await Promise.all([

      // Last 90 days of daily summaries
      supabase
        .from('snapshots')
        .select('snap_date, total, raptor, raptor_r, wti_price, commentary')
        .order('snap_date', { ascending: true })
        .limit(90),

      // Currently active vehicles (on lots right now), with VIN and link
      supabase
        .from('vehicles')
        .select('vin, model_year, model, trim, color, msrp, dealer_name, dealer_city, vehicle_url, first_seen, last_seen')
        .eq('active', true)
        .order('trim',        { ascending: false }) // Raptor R first
        .order('dealer_name', { ascending: true }),

      // Dealer summary from active vehicles
      supabase
        .from('vehicles')
        .select('dealer_name, dealer_city, dealer_url, trim')
        .eq('active', true),

      // Recent donations for display
      supabase
        .from('donations')
        .select('amount_cents, display_name, message, donated_at')
        .order('donated_at', { ascending: false })
        .limit(20),
    ]);

    // Build dealer summary from vehicle rows
    const dealerMap = new Map();
    for (const v of (dealersRes.data || [])) {
      if (!dealerMap.has(v.dealer_name)) {
        dealerMap.set(v.dealer_name, {
          name: v.dealer_name,
          city: v.dealer_city,
          url:  v.dealer_url,
          raptor: 0, raptorR: 0,
        });
      }
      const d = dealerMap.get(v.dealer_name);
      if (v.trim === 'Raptor R') d.raptorR++;
      else d.raptor++;
    }
    const dealers = Array.from(dealerMap.values())
      .sort((a,b) => (b.raptor+b.raptorR) - (a.raptor+a.raptorR));

    // Donation totals
    const allDonations = donationsRes.data || [];
    const totalDonatedCents = allDonations.reduce((s,d) => s + (d.amount_cents || 0), 0);

    return res.status(200).json({
      snapshots:         snapshotsRes.data  || [],
      vehicles:          vehiclesRes.data   || [],
      dealers,
      donations:         allDonations,
      totalDonatedCents,
      generatedAt:       new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
