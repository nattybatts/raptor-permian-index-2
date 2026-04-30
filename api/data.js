// GET /api/data — returns all data the frontend needs
// Dealer list is built dynamically from active vehicles — no static list needed
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const [snapshotsRes, vehiclesRes, donationsRes] = await Promise.all([
      supabase.from('snapshots')
        .select('snap_date, total, raptor, raptor_r, wti_price, commentary')
        .order('snap_date', { ascending: true })
        .limit(90),

      supabase.from('vehicles')
        .select('vin, model_year, model, trim, color, msrp, dealer_name, dealer_city, dealer_state, vehicle_url, dealer_url, dealer_lat, dealer_lng, first_seen, last_seen')
        .eq('active', true)
        .order('dealer_name', { ascending: true }),

      supabase.from('donations')
        .select('amount_cents, display_name, message, donated_at')
        .order('donated_at', { ascending: false })
        .limit(20),
    ]);

    // Build dealer summary from active vehicles — no static list
    // Marketcheck data tells us exactly which dealers have stock
    const dealerMap = new Map();
    for (const v of (vehiclesRes.data || [])) {
      const key = v.dealer_name;
      if (!dealerMap.has(key)) {
        dealerMap.set(key, {
          name:    v.dealer_name,
          city:    v.dealer_city,
          state:   v.dealer_state || 'TX',
          url:     v.dealer_url   || null,
          raptor:  0,
          raptorR: 0,
        });
      }
      const d = dealerMap.get(key);
      if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
    }

    const dealers = Array.from(dealerMap.values())
      .sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR));

    const allDonations      = donationsRes.data || [];
    const totalDonatedCents = allDonations.reduce((s, d) => s + (d.amount_cents || 0), 0);

    return res.status(200).json({
      snapshots:         snapshotsRes.data || [],
      vehicles:          vehiclesRes.data  || [],
      dealers,
      donations:         allDonations,
      totalDonatedCents,
      generatedAt:       new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
