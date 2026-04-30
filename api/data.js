// GET /api/data — returns all data the frontend needs
import { supabase } from '../lib/supabase.js';
import { DEALERS }  from '../lib/dealers.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const [snapshotsRes, vehiclesRes, donationsRes] = await Promise.all([
      supabase.from('snapshots')
        .select('snap_date, total, raptor, raptor_r, wti_price, commentary')
        .order('snap_date', { ascending: true })
        .limit(90),

      supabase.from('vehicles')
        .select('vin, model_year, model, trim, color, msrp, dealer_name, dealer_city, dealer_state, vehicle_url, dealer_url, first_seen, last_seen')
        .eq('active', true)
        .order('trim', { ascending: false })
        .order('dealer_name', { ascending: true }),

      supabase.from('donations')
        .select('amount_cents, display_name, message, donated_at')
        .order('donated_at', { ascending: false })
        .limit(20),
    ]);

    // Build dealer summary from active vehicles + seed with all known dealers at 0
    const dealerMap = new Map();
    for (const d of DEALERS) {
      dealerMap.set(d.name, { name: d.name, city: d.city, state: d.state, url: d.url, miles: d.miles, raptor: 0, raptorR: 0 });
    }
    for (const v of (vehiclesRes.data || [])) {
      const key = [...dealerMap.keys()].find(k =>
        k.toLowerCase().includes((v.dealer_name||'').toLowerCase().split(' ')[0]) ||
        (v.dealer_name||'').toLowerCase().includes(k.toLowerCase().split(' ')[0])
      ) || v.dealer_name;
      if (!dealerMap.has(key)) {
        dealerMap.set(key, { name: v.dealer_name, city: v.dealer_city, state: v.dealer_state, url: v.dealer_url, miles: null, raptor: 0, raptorR: 0 });
      }
      const d = dealerMap.get(key);
      if (v.trim === 'Raptor R') d.raptorR++; else d.raptor++;
    }

    const dealers = Array.from(dealerMap.values())
      .sort((a, b) => (b.raptor + b.raptorR) - (a.raptor + a.raptorR));

    const allDonations     = donationsRes.data || [];
    const totalDonatedCents = allDonations.reduce((s, d) => s + (d.amount_cents || 0), 0);

    return res.status(200).json({
      snapshots:          snapshotsRes.data  || [],
      vehicles:           vehiclesRes.data   || [],
      dealers,
      knownDealers:       DEALERS,
      donations:          allDonations,
      totalDonatedCents,
      generatedAt:        new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
