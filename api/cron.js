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
      in_transit:      v.in_transit       || false,
      vehicle_status:  v.vehicle_status   || null,
      engine_size:     v.engine_size      || null,
      interior_color:  v.interior_color   || null,
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

  // Get previous VINs for sold detection
  const { data: prevActive } = await supabase
    .from('vehicles')
    .select('vin')
    .eq('active', true)
    .not('vin', 'is', null);
  const prevVins = (prevActive || []).map(v => v.vin);

  // Process alerts
  await processAlerts(inv, today, prevVins).catch(e => console.error('[alerts] fatal:', e.message));

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

// ── ALERT PROCESSING ─────────────────────────────────────
async function processAlerts(inv, today, prevVins) {
  if (!process.env.RESEND_API_KEY) return;

  const { data: alerts } = await supabase
    .from('alerts')
    .select('*')
    .eq('active', true);

  if (!alerts?.length) return;
  console.log(`[alerts] processing ${alerts.length} subscriptions`);

  // Track what sold today (was active yesterday, not active today)
  const currentVins = new Set(inv.vehicles.map(v => v.vin).filter(Boolean));
  const soldToday = prevVins.filter(v => !currentVins.has(v));

  // Price history — get yesterday's prices
  const { data: prevPrices } = await supabase
    .from('price_history')
    .select('vin, price')
    .in('vin', inv.vehicles.map(v => v.vin).filter(Boolean));

  const prevPriceMap = {};
  for (const p of (prevPrices || [])) prevPriceMap[p.vin] = p.price;

  // Save today's prices
  const priceRows = inv.vehicles
    .filter(v => v.vin && v.msrp)
    .map(v => ({ vin: v.vin, price: v.msrp, snap_date: today }));
  if (priceRows.length) {
    await supabase.from('price_history')
      .upsert(priceRows, { onConflict: 'vin,snap_date' });
  }

  // Find price drops
  const priceDrops = inv.vehicles.filter(v =>
    v.vin && v.msrp && prevPriceMap[v.vin] && v.msrp < prevPriceMap[v.vin]
  ).map(v => ({ ...v, oldPrice: prevPriceMap[v.vin], drop: prevPriceMap[v.vin] - v.msrp }));

  // Find long-sitting trucks
  const longSitting = inv.vehicles.filter(v => {
    const days = v.first_listed
      ? Math.floor((Date.now() - new Date(v.first_listed)) / 864e5)
      : (v.days_on_lot || 0);
    return days > 0 && (days % 1 === 0); // check daily
  });

  for (const alert of alerts) {
    try {
      let subject, html;
      const lastNotified = alert.last_notified_at ? new Date(alert.last_notified_at) : null;
      const daysSinceNotified = lastNotified
        ? Math.floor((Date.now() - lastNotified) / 864e5)
        : 999;

      if (alert.alert_type === 'sold' && soldToday.length > 0) {
        // Filter to specific VIN if set
        const relevant = alert.vin
          ? soldToday.filter(v => v === alert.vin)
          : soldToday;
        if (!relevant.length) continue;

        subject = `🔴 ${relevant.length} Raptor${relevant.length>1?'s':''} sold in the Permian`;
        html = buildEmail('RAPTOR SOLD', `${relevant.length} truck${relevant.length>1?'s have':' has'} left inventory today.`,
          relevant.map(vin => `<p style="margin:4px 0;color:#888">VIN: ${vin}</p>`).join(''),
          alert.unsubscribe_token);

      } else if (alert.alert_type === 'price' && priceDrops.length > 0) {
        const relevant = alert.vin
          ? priceDrops.filter(v => v.vin === alert.vin)
          : priceDrops;
        if (!relevant.length) continue;
        if (daysSinceNotified < 1) continue;

        subject = `💰 Raptor price drop — save up to $${Math.max(...relevant.map(v=>v.drop)).toLocaleString()}`;
        html = buildEmail('PRICE DROP', 'One or more Raptors dropped in price today.',
          relevant.map(v =>
            `<p style="margin:8px 0"><strong style="color:#f0a500">${v.dealer_name}</strong> · ${v.dealer_city}<br>
            <span style="color:#888">${v.vin}</span><br>
            <span style="color:#e05555;text-decoration:line-through">$${v.oldPrice.toLocaleString()}</span>
            → <span style="color:#4caf50;font-size:18px">$${v.msrp.toLocaleString()}</span>
            <span style="color:#4caf50"> (-$${v.drop.toLocaleString()})</span></p>`
          ).join(''),
          alert.unsubscribe_token);

      } else if (alert.alert_type === 'days') {
        const thresh = alert.threshold || 30;
        const relevant = longSitting.filter(v => {
          const days = v.first_listed
            ? Math.floor((Date.now() - new Date(v.first_listed)) / 864e5)
            : (v.days_on_lot || 0);
          const matchVin = !alert.vin || v.vin === alert.vin;
          return matchVin && days === thresh; // only notify on exact day
        });
        if (!relevant.length) continue;

        subject = `⏱ Raptor sitting ${thresh} days — negotiation opportunity`;
        html = buildEmail(`${thresh} DAYS ON LOT`,
          `${relevant.length} truck${relevant.length>1?'s have':' has'} been on the lot for ${thresh} days. Time to negotiate.`,
          relevant.map(v =>
            `<p style="margin:8px 0"><strong style="color:#f0a500">${v.dealer_name}</strong> · ${v.dealer_city}<br>
            <span style="color:#888">${v.vin}</span> · $${v.msrp?.toLocaleString()||'N/A'}<br>
            ${v.vehicle_url ? `<a href="${v.vehicle_url}" style="color:#f0a500">View listing →</a>` : ''}</p>`
          ).join(''),
          alert.unsubscribe_token);
      } else {
        continue;
      }

      // Send email
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Permian Raptor Index <alerts@permianraptorindex.com>',
          to:   alert.email,
          subject,
          html,
        }),
      });

      // Update last_notified_at
      await supabase.from('alerts')
        .update({ last_notified_at: new Date().toISOString() })
        .eq('id', alert.id);

      console.log(`[alerts] sent ${alert.alert_type} to ${alert.email}`);

    } catch (e) {
      console.error(`[alerts] error for ${alert.email}:`, e.message);
    }
  }
}

function buildEmail(title, intro, body, token) {
  return `
    <div style="font-family:monospace;background:#0a0a0a;color:#e8e0cc;padding:24px;max-width:520px">
      <h2 style="color:#f0a500;font-size:20px;margin:0 0 4px">PERMIAN RAPTOR INDEX</h2>
      <p style="color:#888;font-size:11px;letter-spacing:2px;margin:0 0 20px">${title}</p>
      <p style="margin:0 0 16px">${intro}</p>
      ${body}
      <hr style="border:none;border-top:1px solid #222;margin:24px 0">
      <p style="font-size:10px;color:#444">
        <a href="https://www.permianraptorindex.com" style="color:#555">permianraptorindex.com</a> ·
        <a href="https://www.permianraptorindex.com/api/unsubscribe?token=${token}" style="color:#555">Unsubscribe</a>
      </p>
    </div>`;
}
