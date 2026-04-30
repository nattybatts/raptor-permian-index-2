import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, alert_type, vin, threshold } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!['sold','days','price'].includes(alert_type)) {
    return res.status(400).json({ error: 'Invalid alert type' });
  }
  if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) {
    return res.status(400).json({ error: 'Invalid VIN format' });
  }

  // Simple token — no crypto module needed
  const unsubscribe_token = Math.random().toString(36).slice(2)
    + Math.random().toString(36).slice(2)
    + Date.now().toString(36);

  // Check for duplicate
  const { data: existing } = await supabase
    .from('alerts')
    .select('id')
    .eq('email', email.toLowerCase())
    .eq('alert_type', alert_type)
    .eq('active', true)
    .limit(1);

  if (existing?.length > 0) {
    return res.status(200).json({ ok: true, message: 'Already subscribed' });
  }

  const { error } = await supabase.from('alerts').insert({
    email:             email.toLowerCase().trim(),
    alert_type,
    vin:               vin?.toUpperCase() || null,
    threshold:         alert_type === 'days' ? (parseInt(threshold) || 30) : null,
    unsubscribe_token,
    active:            true,
  });

  if (error) {
    console.error('[subscribe] error:', error.message);
    return res.status(500).json({ error: 'Failed to save subscription' });
  }

  // Send confirmation email via Resend
  const typeLabel = {
    sold:  'when a Raptor sells',
    days:  `when a Raptor has been on the lot ${threshold||30}+ days`,
    price: 'when a Raptor price drops',
  }[alert_type];

  if (process.env.RESEND_API_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    'Permian Raptor Index <alerts@permianraptorindex.com>',
          to:      email,
          subject: '✅ Raptor Alert Confirmed',
          html: `
            <div style="font-family:monospace;background:#0a0a0a;color:#e8e0cc;padding:24px;max-width:480px">
              <h2 style="color:#f0a500;font-size:20px;margin:0 0 12px">PERMIAN RAPTOR INDEX</h2>
              <p style="color:#888;font-size:12px;margin:0 0 16px;letter-spacing:2px">ALERT CONFIRMED</p>
              <p>You'll be notified at <strong style="color:#f0a500">${email}</strong> ${typeLabel}${vin ? ` (VIN: ${vin})` : ' (any Raptor)'}.</p>
              <p style="margin-top:16px;color:#888;font-size:11px">Alerts are sent daily after the 8AM CT inventory update.</p>
              <hr style="border:none;border-top:1px solid #222;margin:20px 0">
              <p style="font-size:10px;color:#444">
                <a href="https://www.permianraptorindex.com" style="color:#555">permianraptorindex.com</a> ·
                <a href="https://www.permianraptorindex.com/api/unsubscribe?token=${unsubscribe_token}" style="color:#555">Unsubscribe</a>
              </p>
            </div>
          `,
        }),
      });
      const rd = await r.json();
      if (!r.ok) console.error('[subscribe] resend error:', JSON.stringify(rd));
      else console.log('[subscribe] confirmation sent to', email);
    } catch (e) {
      console.error('[subscribe] resend exception:', e.message);
    }
  } else {
    console.log('[subscribe] RESEND_API_KEY not set — skipping email');
  }

  return res.status(200).json({ ok: true, message: 'Subscribed successfully' });
}
