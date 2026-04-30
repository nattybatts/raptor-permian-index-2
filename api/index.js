// GET / — serves index.html with secrets injected as JS variables
// This way ANTHROPIC_API_KEY and CRON_SECRET never appear in the static HTML
// but are available to the frontend JS at runtime

import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  try {
    const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');

    // Inject secrets as JS globals before the closing </body>
    const injected = html.replace(
      '</body>',
      `<script>
window.__ANTHROPIC_KEY__ = ${JSON.stringify(process.env.ANTHROPIC_API_KEY || '')};
window.__CRON_SECRET__   = ${JSON.stringify(process.env.CRON_SECRET || '')};
</script>
</body>`
    );

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store'); // Never cache — always get fresh secrets
    res.status(200).send(injected);
  } catch (err) {
    res.status(500).send('Error loading page: ' + err.message);
  }
}
