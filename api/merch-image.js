import { readFileSync } from 'fs';
import { join } from 'path';

const ALLOWED = [
  'black-hat.jpg','white-hat.jpg',
  'black-trucker-gold.jpg','white-trucker-black.jpg',
  'diesel-surcharge.jpg'
];

export default function handler(req, res) {
  const { file } = req.query;
  if (!ALLOWED.includes(file)) return res.status(404).send('Not found');
  try {
    const img = readFileSync(join(process.cwd(), 'public', 'merch', file));
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(img);
  } catch {
    return res.status(404).send('Not found');
  }
}
