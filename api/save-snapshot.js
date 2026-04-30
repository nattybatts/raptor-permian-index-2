// POST /api/save-snapshot
// Called by the frontend after it runs the Anthropic search client-side
// Saves the result to Supabase
// Protected by CRON_SECRET so random people can't write garbage data

import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'No body' });

  const today = new Date().toISOString().split('T')[0];

  try {
    // Save snapshot
    const { error: snapErr } = await supabase
      .from('snapshots')
      .upsert({
        snap_date:  today,
        total:      body.total      || 0,
        raptor:     body.raptor     || 0,
        raptor_r:   body.raptorR    || 0,
        wti_price:  body.wtiPrice   || null,
        commentary: body.commentary || null,
        scraped_at: new Date().toISOString(),
      }, { onConflict: 'snap_date' });

    if (snapErr) throw new Error('Snapshot: ' + snapErr.message);

    // Save vehicles
    if (body.vehicles && body.vehicles.length > 0) {
      const rows = body.vehicles.map((v, i) => ({
        vin:          v.vin || `SRCH-${today}-${i}`.padEnd(17, '0').slice(0, 17),
        model_year:   v.model_year || new Date().getFullYear(),
        model:        v.model      || 'F-150',
        trim:         v.trim       || 'Raptor',
        color:        v.color      || null,
        msrp:         v.msrp       || null,
        dealer_name:  v.dealer_name|| 'Unknown',
        dealer_city:  v.dealer_city|| '',
        dealer_state: 'TX',
        dealer_url:   v.dealer_url || null,
        vehicle_url:  v.vehicle_url|| null,
        first_seen:   today,
        last_seen:    today,
        active:       true,
      }));

      const { error: vErr } = await supabase
        .from('vehicles')
        .upsert(rows, { onConflict: 'vin', ignoreDuplicates: false });
      if (vErr) console.error('Vehicle upsert:', vErr.message);

      // Mark old VINs inactive
      const vins = rows.map(r => r.vin).filter(v => !v.startsWith('SRCH-'));
      if (vins.length > 0) {
        await supabase.from('vehicles')
          .update({ active: false })
          .eq('active', true)
          .not('vin', 'in', `(${vins.map(v => `"${v}"`).join(',')})`);
      }
    }

    return res.status(200).json({ success: true, date: today, total: body.total });
  } catch (err) {
    console.error('save-snapshot error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
