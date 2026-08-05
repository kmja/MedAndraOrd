import crypto from 'node:crypto';

import { getStore } from './store.js';
import { wordForDate, wordByIndex, randomWord, WORDS } from './words.js';
import { judgeClue, costsAttempt, isCacheableVerdict, AiUnavailableError, MAX_ATTEMPTS } from './game.js';
import { normalize, todayInStockholm, clueLimitFor } from './util.js';

// Framework-agnostic handlers: they take Node-style (req, res), which is what
// both Express and Vercel functions provide. Keeping them here means there is
// exactly one implementation of the rules, wired twice.

const COOKIE = 'ordknapp_pid';

/**
 * What a day's stored data belongs to.
 *
 * The date alone is not enough. Which word a date maps to depends on the size
 * of the bank — `(dayNumber * STRIDE) % WORDS.length` — so adding words moves
 * every date to a different word. When that happened mid-day, the day's
 * leaderboard still held clues for the old word while players were being shown
 * the new one, and the clue cache would hand a verdict judged against one word
 * to a clue written for another.
 *
 * Scoping by (date, word) makes a bank change do the harmless thing instead:
 * the new word simply starts with a clean board.
 */
const puzzleKey = (date, index) => `${date}:${index}`;

// Practice mode ("Slumpa ord") is a testing aid: a random word run through the
// same pipeline but recorded nowhere. Set ORDKNAPP_PRACTICE=0 to remove it.
const PRACTICE_ENABLED = process.env.ORDKNAPP_PRACTICE !== '0';

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
      `${COOKIE}=${pid}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${3600 * 24 * 365}`,
    );
  }
  return pid;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

// Rate limiting is per-instance. On serverless that means per warm lambda —
// weaker than a single server, but it still bounds the cost of a hot instance.
const rateBuckets = new Map();
const RATE_LIMIT = { windowMs: 60_000, max: 12 };

function rateLimited(pid) {
  const now = Date.now();
  let bucket = rateBuckets.get(pid);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT.windowMs };
    rateBuckets.set(pid, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 10_000) rateBuckets.clear();
  return bucket.count > RATE_LIMIT.max;
}

// Practice verdicts live in memory only — practice has no fairness requirement.
const practiceCache = new Map();
const PRACTICE_CACHE_MAX = 2000;

function cachePractice(key, verdict) {
  if (practiceCache.size >= PRACTICE_CACHE_MAX) {
    practiceCache.delete(practiceCache.keys().next().value);
  }
  practiceCache.set(key, verdict);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

// ---------------------------------------------------------------------------

export async function stateHandler(req, res) {
  const store = getStore();
  const pid = getPlayerId(req, res);
  const date = todayInStockholm();
  const today = wordForDate(date);
  const { word, forbidden, letterCount } = today;

  const puzzle = puzzleKey(date, today.index);
  const [attempts, best, standing, dayStats] = await Promise.all([
    store.getAttempts(puzzle, pid),
    store.getBest(puzzle, pid),
    store.standing(puzzle, pid),
    store.dayStats(puzzle),
  ]);
  // The winning clues are the answer key. Only players who are done for the
  // day — solved it, or out of attempts — get to see them.
  const reveal = best != null || attempts >= MAX_ATTEMPTS;
  const leaderboard = await store.leaderboard(puzzle, pid, reveal);

  send(res, 200, {
    date,
    word,
    forbidden,
    letterCount,
    wordClass: today.class ?? null,
    maxClueLength: clueLimitFor(today),
    maxAttempts: MAX_ATTEMPTS,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts),
    best,
    leaderboard,
    standing,
    dayAverage: dayStats.average,
    solvers: dayStats.solvers,
    practiceEnabled: PRACTICE_ENABLED,
    bankSize: WORDS.length,
    durable: store.durable,
  });
}

export async function randomHandler(req, res) {
  if (!PRACTICE_ENABLED) return send(res, 404, { error: 'Övningsläget är avstängt.' });
  const { index: todayIndex } = wordForDate(todayInStockholm());
  const entry = randomWord(todayIndex);
  send(res, 200, {
    wordIndex: entry.index,
    word: entry.word,
    forbidden: entry.forbidden,
    letterCount: entry.letterCount,
    wordClass: entry.class ?? null,
    maxClueLength: clueLimitFor(entry),
  });
}

export async function clueHandler(req, res) {
  const store = getStore();
  const pid = getPlayerId(req, res);
  if (rateLimited(pid)) {
    return send(res, 429, { error: 'För många försök på kort tid. Vänta en stund.' });
  }

  const body = parseBody(req);
  const clue = typeof body.clue === 'string' ? body.clue.trim() : '';
  if (!clue) return send(res, 400, { error: 'Ingen ledtråd angiven.' });
  if (clue.length > 200) return send(res, 400, { error: 'Ledtråden är för lång.' });

  const date = todayInStockholm();
  const today = wordForDate(date);

  // ---- Practice mode: judged identically, recorded nowhere. ----
  if (body.practice) {
    if (!PRACTICE_ENABLED) return send(res, 404, { error: 'Övningsläget är avstängt.' });
    const entry = wordByIndex(Number(body.wordIndex));
    if (!entry) return send(res, 400, { error: 'Okänt övningsord.' });
    // Practising on the live word would be a free way around the daily limit.
    if (entry.index === today.index) {
      return send(res, 403, { error: 'Dagens ord kan inte övas på. Slumpa ett annat ord.' });
    }
    const key = `${entry.index}:${normalize(clue)}`;
    let verdict = practiceCache.get(key);
    if (!verdict) {
      try {
        verdict = await judgeClue({
          clue, target: entry.word, forbidden: entry.forbidden,
          maxLength: clueLimitFor(entry), wordClass: entry.class,
        });
      } catch (err) {
        if (err instanceof AiUnavailableError) {
          return send(res, 503, { error: 'AI:n svarar inte just nu. Försök igen om en stund.' });
        }
        console.error('judgeClue (practice) failed:', err);
        return send(res, 500, { error: 'Något gick fel.' });
      }
      // Same rule as the daily path: an AI failure is not a ruling about the
      // clue, it is transient misbehaviour. Caching it froze the clue as
      // permanently failed, so resubmitting returned the old failure instantly
      // instead of giving the model another go — which is exactly what it
      // looked like from the outside.
      if (isCacheableVerdict(verdict)) cachePractice(key, verdict);
    }
    return send(res, 200, { result: verdict, practice: true });
  }

  const { index, word, forbidden } = today;
  const puzzle = puzzleKey(date, index);
  const attempts = await store.getAttempts(puzzle, pid);
  if (attempts >= MAX_ATTEMPTS) {
    return send(res, 403, { error: 'Du har inga försök kvar idag. Nytt ord imorgon.' });
  }

  const normClue = normalize(clue);

  // With a leaderboard, identical clues must resolve identically: the first
  // submission fixes the ruling for everyone that day.
  let verdict = await store.getCachedVerdict(puzzle, normClue);
  let cached = true;
  if (!verdict) {
    cached = false;
    try {
      verdict = await judgeClue({
        clue, target: word, forbidden, maxLength: clueLimitFor(today), wordClass: today.class,
      });
    } catch (err) {
      if (err instanceof AiUnavailableError) {
        return send(res, 503, { error: 'AI:n svarar inte just nu. Försök igen om en stund — inget försök förbrukades.' });
      }
      console.error('judgeClue failed:', err);
      return send(res, 500, { error: 'Något gick fel. Inget försök förbrukades.' });
    }
    if (isCacheableVerdict(verdict)) {
      await store.cacheVerdict(puzzle, normClue, verdict);
    }
  }

  // Only outcomes the player is responsible for cost an attempt.
  let newAttempts = attempts;
  let best = await store.getBest(puzzle, pid);
  if (costsAttempt(verdict)) {
    newAttempts = await store.incrAttempts(puzzle, pid);
    if (verdict.type === 'correct') {
      best = await store.recordBest(puzzle, pid, verdict.score, clue);
    }
  }

  const reveal = best != null || newAttempts >= MAX_ATTEMPTS;
  const [leaderboard, standing, dayStats] = await Promise.all([
    store.leaderboard(puzzle, pid, reveal),
    store.standing(puzzle, pid),
    store.dayStats(puzzle),
  ]);

  send(res, 200, {
    result: verdict,
    cached,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - newAttempts),
    best,
    leaderboard,
    standing,
    dayAverage: dayStats.average,
    solvers: dayStats.solvers,
  });
}
