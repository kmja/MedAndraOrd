import fs from 'node:fs';
import path from 'node:path';

import { normalize, compareClues, clueLength } from './util.js';

// Storage has three backends behind one interface, chosen by environment:
//
//   KvStore     — Redis over the Upstash REST protocol (Vercel KV, Upstash).
//                 The only backend that survives serverless; uses atomic
//                 primitives so concurrent players can't clobber each other.
//   FileStore   — JSON file with atomic writes. For a long-lived Node process.
//   MemoryStore — last resort. Works, but every restart wipes the leaderboard.
//
// All methods are async so callers don't care which backend they got.

const LEADERBOARD_LIMIT = 20;

/**
 * The board is a list of clues, not of people: everyone who submitted the same
 * clue shares one row. Grouping happens on the normalized clue, so casing and
 * spacing differences don't split a row that players would read as identical.
 *
 * Ranks are competition ranks over the full tiebreak chain (see compareClues),
 * so two genuinely equal clues share a place and the next one skips.
 */
function groupAndRank(entries, { reveal, viewerPid }) {
  const groups = new Map();
  for (const { pid, score, clue } of entries) {
    // A player with no recorded clue can't be grouped with anyone; give them
    // their own bucket rather than merging unrelated players under "unknown".
    const key = clue ? normalize(clue) : `\u0000${pid}`;
    let g = groups.get(key);
    if (!g) {
      g = { clue: clue ?? null, score, count: 0, you: false };
      groups.set(key, g);
    }
    g.count += 1;
    if (pid === viewerPid) g.you = true;
  }

  const rows = [...groups.values()].sort((a, b) => {
    if (a.clue && b.clue) return compareClues(a.clue, b.clue);
    return a.score - b.score; // fall back when a clue is missing
  });

  let rank = 0;
  let prev = null;
  return rows.slice(0, LEADERBOARD_LIMIT).map((row, i) => {
    // Tie on the full chain when both clues are known; otherwise fall back to
    // the score, matching standing()'s fallback so the two never disagree.
    const same = Boolean(prev) && (
      row.clue && prev.clue
        ? compareClues(row.clue, prev.clue) === 0
        : row.score === prev.score
    );
    if (!same) { rank = i + 1; prev = row; }
    return {
      rank,
      // Derived from the clue when we have one, so the number shown can never
      // disagree with the clue shown or with the order they were sorted in.
      score: row.clue ? clueLength(row.clue) : row.score,
      count: row.count,
      you: row.you,
      ...(reveal ? { clue: row.clue } : {}),
    };
  });
}

// ---------------------------------------------------------------------------

class MemoryStore {
  constructor() {
    this.attempts = new Map(); // `${date}:${pid}` -> count
    this.bests = new Map(); // `${date}` -> Map(pid -> { score, clue })
    this.clues = new Map(); // `${date}:${clue}` -> verdict
    this.durable = false;
  }

  async getCachedVerdict(date, _wordIndex, normClue) {
    return this.clues.get(`${date}:${normClue}`) ?? null;
  }

  async cacheVerdict(date, _wordIndex, normClue, verdict) {
    this.clues.set(`${date}:${normClue}`, verdict);
  }

  async getAttempts(date, pid) {
    return this.attempts.get(`${date}:${pid}`) ?? 0;
  }

  async incrAttempts(date, pid) {
    const n = (this.attempts.get(`${date}:${pid}`) ?? 0) + 1;
    this.attempts.set(`${date}:${pid}`, n);
    return n;
  }

  async getBest(date, pid) {
    return this.bests.get(date)?.get(pid)?.score ?? null;
  }

  async recordBest(date, pid, score, clue) {
    if (!this.bests.has(date)) this.bests.set(date, new Map());
    const day = this.bests.get(date);
    const prev = day.get(pid);
    if (prev == null || score < prev.score) day.set(pid, { score, clue });
    return day.get(pid).score;
  }

  /**
   * `reveal` gates the winning clues. They are the answer key: anyone who
   * hasn't finished could simply copy the best one, so the server omits them
   * rather than trusting the client to hide them.
   */
  async leaderboard(date, viewerPid, reveal = false) {
    const day = this.bests.get(date);
    if (!day) return [];
    return groupAndRank(
      [...day.entries()].map(([pid, best]) => ({ pid, score: best.score, clue: best.clue })),
      { reveal, viewerPid },
    );
  }

  /**
   * Where this player stands among everyone who solved today.
   * Competition ranking: everyone on the same score shares a rank, so ties
   * never invent an ordering the scores don't support.
   * Returns { rank, total } or null if they haven't solved it.
   */
  async standing(date, pid) {
    const day = this.bests.get(date);
    const mine = day?.get(pid);
    if (mine == null) return null;
    // Ranked on the same chain the board uses, so a player's stated placing
    // never contradicts the row they are standing on.
    let better = 0;
    for (const best of day.values()) {
      const ahead = mine.clue && best.clue
        ? compareClues(best.clue, mine.clue) < 0
        : best.score < mine.score;
      if (ahead) better++;
    }
    return { rank: better + 1, total: day.size };
  }

  /** Aggregates for the day, used to mark the average on the length meter. */
  async dayStats(date) {
    const day = this.bests.get(date);
    if (!day || day.size === 0) return { solvers: 0, average: null };
    let sum = 0;
    for (const best of day.values()) sum += best.score;
    return { solvers: day.size, average: sum / day.size };
  }
}

// ---------------------------------------------------------------------------

class FileStore extends MemoryStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.durable = true;
    this._timer = null;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.attempts = new Map(raw.attempts ?? []);
      this.clues = new Map(raw.clues ?? []);
      this.bests = new Map((raw.bests ?? []).map(([d, entries]) => [d, new Map(entries)]));
    } catch {
      // fresh store
    }
  }

  _save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(
          tmp,
          JSON.stringify({
            attempts: [...this.attempts],
            clues: [...this.clues],
            bests: [...this.bests].map(([d, m]) => [d, [...m]]),
          }),
        );
        fs.renameSync(tmp, this.filePath);
      } catch (err) {
        console.error('store save failed:', err.message);
      }
    }, 250);
  }

  async cacheVerdict(...args) { await super.cacheVerdict(...args); this._save(); }
  async incrAttempts(...args) { const n = await super.incrAttempts(...args); this._save(); return n; }
  async recordBest(...args) { const b = await super.recordBest(...args); this._save(); return b; }
}

// ---------------------------------------------------------------------------

/**
 * Redis over the Upstash REST protocol — what Vercel KV and Upstash both
 * speak. Uses INCR and ZADD/GT so two players finishing at once can't
 * overwrite each other's writes, which a read-modify-write JSON blob would.
 */
class KvStore {
  constructor(url, token) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.durable = true;
  }

  async _cmd(...command) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`KV ${command[0]} failed: ${res.status}`);
    const body = await res.json();
    return body.result;
  }

  // Day keys expire after 40 days: the leaderboard is per-day, so old days are
  // dead weight and this keeps a free KV tier from filling up silently.
  async _expire(key) {
    try { await this._cmd('EXPIRE', key, 60 * 60 * 24 * 40); } catch { /* best effort */ }
  }

  async getCachedVerdict(date, _wordIndex, normClue) {
    const raw = await this._cmd('GET', `clue:${date}:${normClue}`);
    return raw ? JSON.parse(raw) : null;
  }

  async cacheVerdict(date, _wordIndex, normClue, verdict) {
    const key = `clue:${date}:${normClue}`;
    await this._cmd('SET', key, JSON.stringify(verdict));
    await this._expire(key);
  }

  async getAttempts(date, pid) {
    const n = await this._cmd('GET', `att:${date}:${pid}`);
    return n ? Number(n) : 0;
  }

  async incrAttempts(date, pid) {
    const key = `att:${date}:${pid}`;
    const n = await this._cmd('INCR', key);
    if (Number(n) === 1) await this._expire(key);
    return Number(n);
  }

  async getBest(date, pid) {
    const s = await this._cmd('ZSCORE', `best:${date}`, pid);
    return s == null ? null : Number(s);
  }

  async recordBest(date, pid, score, clue) {
    const key = `best:${date}`;
    // LT: only overwrite when the new score is lower. Golf — lower is better.
    await this._cmd('ZADD', key, 'LT', String(score), pid);
    await this._expire(key);
    const now = await this.getBest(date, pid);
    // Keep the clue in step with the score it belongs to: only write it when
    // this submission is the one that now holds the record.
    if (now === score && clue != null) {
      const clueKey = `bestclue:${date}`;
      await this._cmd('HSET', clueKey, pid, clue);
      await this._expire(clueKey);
    }
    return now;
  }

  /** See MemoryStore.leaderboard for why `reveal` exists. */
  /**
   * Reads the whole day, because grouping and the tiebreak chain need every
   * clue — the top 20 rows can't be known from scores alone. Same O(solvers)
   * cost as dayStats; fine at this scale, and the place to add a cache first.
   */
  async leaderboard(date, viewerPid, reveal = false) {
    const flat = await this._cmd('ZRANGE', `best:${date}`, '0', '-1', 'WITHSCORES');
    if (!Array.isArray(flat) || flat.length === 0) return [];
    const entries = [];
    for (let i = 0; i < flat.length; i += 2) entries.push({ pid: flat[i], score: Number(flat[i + 1]) });

    const clues = await this._cmd('HMGET', `bestclue:${date}`, ...entries.map((e) => e.pid));
    entries.forEach((e, i) => { e.clue = clues?.[i] ?? null; });

    return groupAndRank(entries, { reveal, viewerPid });
  }

  /** Averages over every solver, so this reads the whole day's set. */
  async dayStats(date) {
    const flat = await this._cmd('ZRANGE', `best:${date}`, '0', '-1', 'WITHSCORES');
    if (!Array.isArray(flat) || flat.length === 0) return { solvers: 0, average: null };
    let sum = 0;
    let n = 0;
    for (let i = 1; i < flat.length; i += 2) { sum += Number(flat[i]); n++; }
    return { solvers: n, average: n ? sum / n : null };
  }

  /**
   * Competition ranking via ZCOUNT of strictly better scores — Redis does the
   * counting, so this stays one round trip per figure regardless of how many
   * players there are. ZRANK would break ties arbitrarily by insertion order.
   */
  async standing(date, pid) {
    const mine = await this.getBest(date, pid);
    if (mine == null) return null;
    const [myClue, flat] = await Promise.all([
      this._cmd('HGET', `bestclue:${date}`, pid),
      this._cmd('ZRANGE', `best:${date}`, '0', '-1', 'WITHSCORES'),
    ]);
    const entries = [];
    for (let i = 0; i < flat.length; i += 2) entries.push({ pid: flat[i], score: Number(flat[i + 1]) });
    if (!myClue) {
      // No clue on record: fall back to the score alone.
      return { rank: entries.filter((e) => e.score < mine).length + 1, total: entries.length };
    }
    const clues = await this._cmd('HMGET', `bestclue:${date}`, ...entries.map((e) => e.pid));
    let better = 0;
    entries.forEach((e, i) => {
      const theirs = clues?.[i];
      const ahead = theirs ? compareClues(theirs, myClue) < 0 : e.score < mine;
      if (ahead) better++;
    });
    return { rank: better + 1, total: entries.length };
  }
}

// ---------------------------------------------------------------------------

let _store = null;

/**
 * Picks a backend from the environment. Vercel KV and Upstash both inject
 * KV_REST_API_URL / KV_REST_API_TOKEN; UPSTASH_REDIS_REST_* is the same thing
 * under Upstash's own naming.
 */
export function getStore() {
  if (_store) return _store;

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    _store = new KvStore(url, token);
  } else if (process.env.VERCEL) {
    // Serverless filesystem is read-only and per-instance; a file store would
    // silently lose every write. Be loud rather than pretend to persist.
    console.warn(
      'VARNING: ingen KV konfigurerad. Topplista och försöksgräns lagras i minnet ' +
        'och nollställs vid varje kallstart. Lägg till en KV/Upstash-integration.',
    );
    _store = new MemoryStore();
  } else {
    _store = new FileStore(
      process.env.ORDKNAPP_DATA || path.join(process.cwd(), 'data', 'store.json'),
    );
  }
  return _store;
}

export { MemoryStore, FileStore, KvStore };
