// GET /api/test-key
// Makes a minimal Anthropic API call to verify the key works
// Remove after confirming

export default async function handler(req, res) {
  const key = process.env.ANTHROPIC_API_KEY;
  
  if (!key) {
    return res.status(200).json({ status: 'ERROR', message: 'ANTHROPIC_API_KEY not set' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: 'Say OK' }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    const data = await res.json ? await response.json() : {};
    
    if (response.ok) {
      return res.status(200).json({
        status: 'SUCCESS',
        message: 'API key works!',
        http_status: response.status,
        key_prefix: key.slice(0, 20) + '...',
        response_preview: JSON.stringify(data).slice(0, 100),
      });
    } else {
      return res.status(200).json({
        status: 'FAILED',
        http_status: response.status,
        key_prefix: key.slice(0, 20) + '...',
        error: JSON.stringify(data).slice(0, 200),
      });
    }
  } catch (err) {
    return res.status(200).json({
      status: 'ERROR',
      message: err.message,
      key_prefix: key.slice(0, 20) + '...',
    });
  }
}
