import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stateHandler, clueHandler, randomHandler } from './handlers.js';

// Express wiring for local development and for hosts that run a long-lived
// Node process (Railway, Render, Fly, a VPS). On Vercel the same handlers are
// wired as serverless functions in /api instead — see vercel.json.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const app = express();
app.use(express.json({ limit: '4kb' }));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Något gick fel.' });
  });

app.get('/api/state', wrap(stateHandler));
app.get('/api/random', wrap(randomHandler));
app.post('/api/clue', wrap(clueHandler));

const distDir = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(distDir));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(404).send('Bygg frontend först: npm run build');
  });
});

app.listen(PORT, () => {
  console.log(`Ordknapp körs på http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.warn('VARNING: GEMINI_API_KEY är inte satt — ledtrådar kan inte bedömas.');
  }
});
