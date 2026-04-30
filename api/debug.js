// GET /api/debug — shows what env vars are set (values masked)
// Remove this file after confirming things work
export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY    ? `set (${process.env.ANTHROPIC_API_KEY.length} chars, starts with ${process.env.ANTHROPIC_API_KEY.slice(0,7)}...)` : 'NOT SET',
    SUPABASE_URL:         process.env.SUPABASE_URL         ? `set` : 'NOT SET',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? `set` : 'NOT SET',
    CRON_SECRET:          process.env.CRON_SECRET          ? `set` : 'NOT SET',
    EIA_API_KEY:          process.env.EIA_API_KEY          ? `set` : 'NOT SET',
    STRIPE_SECRET_KEY:    process.env.STRIPE_SECRET_KEY    ? `set` : 'NOT SET',
    NODE_ENV:             process.env.NODE_ENV,
  });
}
