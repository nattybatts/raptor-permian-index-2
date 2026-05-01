import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  try {
    const html = readFileSync(join(process.cwd(), 'public', 'merch.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).send(html);
  } catch (err) {
    return res.status(500).send('Error loading page');
  }
}
