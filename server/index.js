import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './store.js';
import { wordForDate } from './words.js';
import { judgeClue, AiUnavailableError, MAX_ATTEMPTS } from './game.js';
import { normalize, sanitizeName, todayInStockholm, MAX_CLUE_LENGTH } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.LEDTRADEN_DATA || path.join(__dirname, '..', 'data', 'store.json');

const store = new Store(DATA_FILE);
const app = express();
app.use(express.json({ limit: '4kb' }));

// ---------------------------------------------------------------------------
// Player identity: anonymous httpOnly cookie. The server is authoritative for
// attempts and scores — nothing score-related is ever trusted from the client.
// ---------------------------------------------------------------------------
const COOKIE = 'ledtraden_pid';

function getPlayerId(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((kv) => kv.length === 2),
  );
  let pid = cookies[COOKIE];
  if (!pid || !/^[a-f0-9]{32}$/.test(pid)) {
    pid = crypto.randomBytes(16).toString('hex');
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${pid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${3600 * 24 * 365}`,
    );
  }
  return pid;
}

// ---------------------------------------------------------------------------
// Rate limiting for the AI-backed endpoint (per player, in-memory).
// ---------------------------------------------------------------------------
const RATE_LIMIT = { windowMs: 60_000, max: 12 };
const rateBuckets = new Map();

function rateLimited(pid) {
  const now = Date.now();
  let bucket = rateBuckets.get(pid);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT.windowMs };
    rateBuckets.set(pid, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 10_000) rateBuckets.clear(); // crude memory bound
  return bucket.count > RATE_LIMIT.max;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Today's game state for this player. The player SEES the secret word —
 *  it's the guesser AI that is blind, and that must stay advertised. */
app.get('/api/state', (req, res) => {
  const pid = getPlayerId(req, res);
  const date = todayInStockholm();
  const { index, word, forbidden, letterCount } = wordForDate(date);
  const player = store.player(date, index, pid);

  res.json({
    date,
    word,
    forbidden,
    letterCount,
    maxClueLength: MAX_CLUE_LENGTH,
    maxAttempts: MAX_ATTEMPTS,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - player.attempts),
    best: player.best,
    name: store.getName(pid),
    leaderboard: store.leaderboard(date, index),
  });
});

/** Submit a clue. The server computes everything; the client reports nothing
 *  but the clue text. */
app.post('/api/clue', async (req, res) => {
  const pid = getPlayerId(req, res);
  if (rateLimited(pid)) {
    return res.status(429).json({ error: 'Lugn — Mullvaden hinner inte med. Vänta en liten stund.' });
  }

  const clue = typeof req.body?.clue === 'string' ? req.body.clue.trim() : '';
  if (!clue) return res.status(400).json({ error: 'Ingen ledtråd angiven.' });
  if (clue.length > 200) return res.status(400).json({ error: 'Ledtråden är för lång.' });

  const date = todayInStockholm();
  const { index, word, forbidden } = wordForDate(date);
  const player = store.player(date, index, pid);

  if (player.attempts >= MAX_ATTEMPTS) {
    return res.status(403).json({ error: 'Mullvaden har grävt ner sig för idag. Välkommen tillbaka imorgon!' });
  }

  const normClue = normalize(clue);

  // With a leaderboard, identical clues must resolve identically: the first
  // submission fixes the ruling for everyone that day.
  let verdict = store.getCachedVerdict(date, index, normClue);
  let cached = true;
  if (!verdict) {
    cached = false;
    try {
      verdict = await judgeClue({ clue, target: word, forbidden });
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        return res.status(503).json({ error: 'Mullvaden svarar inte nere i hålan just nu. Försök igen om en stund — inget försök förbrukades.' });
      }
      console.error('judgeClue failed:', err);
      return res.status(500).json({ error: 'Något gick fel. Inget försök förbrukades.' });
    }
    store.cacheVerdict(date, index, normClue, verdict);
  }

  // Rejections (code or referee) cost no attempt. Everything that reached the
  // guesser costs one — including AI failures, which count as a miss.
  if (verdict.type !== 'rejected') {
    player.attempts += 1;
    if (verdict.type === 'correct') {
      if (player.best == null || verdict.score < player.best) {
        player.best = verdict.score;
      }
    }
    store.save();
  }

  res.json({
    result: verdict,
    cached,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - player.attempts),
    best: player.best,
    leaderboard: store.leaderboard(date, index),
  });
});

/** Set leaderboard display name (moderated in code). */
app.post('/api/name', (req, res) => {
  const pid = getPlayerId(req, res);
  const name = sanitizeName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Ogiltigt namn.' });
  store.setName(pid, name);
  const date = todayInStockholm();
  const { index } = wordForDate(date);
  res.json({ name, leaderboard: store.leaderboard(date, index) });
});

// ---------------------------------------------------------------------------
// Static frontend (vite build output)
// ---------------------------------------------------------------------------
const distDir = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(distDir));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(404).send('Bygg frontend först: npm run build');
  });
});

app.listen(PORT, () => {
  console.log(`Ledtråden körs på http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('VARNING: ANTHROPIC_API_KEY är inte satt — ledtrådar kommer inte att kunna bedömas.');
  }
});
