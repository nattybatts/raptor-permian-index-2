// GET /api/test-key — tests both API keys
export default async function handler(req, res) {
  const results = {};

  // Test OpenAI
  const oaiKey = process.env.OPENAI_API_KEY;
  if (oaiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${oaiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      results.openai = r.ok
        ? { status: 'SUCCESS', key_prefix: oaiKey.slice(0, 14) + '...' }
        : { status: 'FAILED', http: r.status, key_prefix: oaiKey.slice(0, 14) + '...' };
    } catch (e) {
      results.openai = { status: 'ERROR', message: e.message };
    }
  } else {
    results.openai = { status: 'NOT SET' };
  }

  // Test Anthropic
  const antKey = process.env.ANTHROPIC_API_KEY;
  if (antKey) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': antKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(8000),
      });
      const d = await r.json();
      results.anthropic = r.ok
        ? { status: 'SUCCESS', key_prefix: antKey.slice(0, 20) + '...' }
        : { status: 'FAILED', http: r.status, error: d?.error?.message, key_prefix: antKey.slice(0, 20) + '...' };
    } catch (e) {
      results.anthropic = { status: 'ERROR', message: e.message };
    }
  } else {
    results.anthropic = { status: 'NOT SET' };
  }

  res.status(200).json(results);
}
