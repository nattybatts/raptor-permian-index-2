import { readFileSync } from 'fs';
import { join } from 'path';

export default function handler(req, res) {
  try {
    const img = readFileSync(join(process.cwd(), 'public', 'logo.png'));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(img);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
}
