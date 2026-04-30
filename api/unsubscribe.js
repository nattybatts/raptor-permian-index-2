// GET /api/unsubscribe?token=xxx
import { supabase } from '../lib/supabase.js';

export default async function handler(req, res) {
  const { token } = req.query;
  if (!token) return res.status(400).send('Invalid link');

  const { error } = await supabase
    .from('alerts')
    .update({ active: false })
    .eq('unsubscribe_token', token);

  if (error) return res.status(500).send('Error unsubscribing');

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(`
    <html><body style="font-family:monospace;background:#0a0a0a;color:#e8e0cc;padding:40px;text-align:center">
      <h2 style="color:#f0a500">PERMIAN RAPTOR INDEX</h2>
      <p>You've been unsubscribed.</p>
      <a href="https://www.permianraptorindex.com" style="color:#f0a500">← Back to the index</a>
    </body></html>
  `);
}
