export default function handler(req, res) {
  res.status(200).json({
    ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY    ? `set (starts ${process.env.ANTHROPIC_API_KEY.slice(0,12)}...)` : 'NOT SET',
    OPENAI_API_KEY:       process.env.OPENAI_API_KEY       ? `set (starts ${process.env.OPENAI_API_KEY.slice(0,12)}...)` : 'NOT SET',
    OIL_PRICE_API_KEY:    process.env.OIL_PRICE_API_KEY    ? `set (starts ${process.env.OIL_PRICE_API_KEY.slice(0,8)}...)` : 'NOT SET ← THIS IS WHY OIL PRICE IS WRONG',
    EIA_API_KEY:          process.env.EIA_API_KEY          ? `set` : 'NOT SET',
    ALPHA_VANTAGE_KEY:    process.env.ALPHA_VANTAGE_KEY    ? `set` : 'NOT SET',
    SUPABASE_URL:         process.env.SUPABASE_URL         ? `set` : 'NOT SET',
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ? `set` : 'NOT SET',
    CRON_SECRET:          process.env.CRON_SECRET          ? `set` : 'NOT SET',
    STRIPE_SECRET_KEY:    process.env.STRIPE_SECRET_KEY    ? `set` : 'NOT SET',
  });
}
