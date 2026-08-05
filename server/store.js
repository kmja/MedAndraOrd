import fs from 'node:fs';
import path from 'node:path';

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
 * Competition ranking over an already-sorted list: equal scores share a rank
 * (1, 2, 2, 4). Must match standing(), or a player's stated placing would
 * disagree with the row they are standing on.
 */
function withRanks(rows) {
  let rank = 0;
  let prev = null;
  return rows.map((row, i) => {
    if (row.score !== prev) { rank = i + 1; prev = row.score; }
    return { rank, ...row };
  });
}

// ---------------------------------------------------------------------------

class MemoryStore {
  constructor() {
    this.names = new Map();
    this.attempts = new Map(); // `${date}:${pid}` -> count
    this.bests = new Map(); // `${date}` -> Map(pid -> score)
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
    return this.bests.get(date)?.get(pid) ?? null;
  }

  async recordBest(date, pid, score) {
    if (!this.bests.has(date)) this.bests.set(date, new Map());
    const day = this.bests.get(date);
    const prev = day.get(pid);
    if (prev == null || score < prev) day.set(pid, score);
    return day.get(pid);
  }

  async getName(pid) {
    return this.names.get(pid) ?? null;
  }

  async setName(pid, name) {
    this.names.set(pid, name);
  }

  async leaderboard(date, viewerPid) {
    const day = this.bests.get(date);
    if (!day) return [];
    const rows = [...day.entries()].sort((a, b) => a[1] - b[1]).slice(0, LEADERBOARD_LIMIT);
    return withRanks(
      rows.map(([pid, score]) => ({ score, name: this.names.get(pid) || 'Anonym', you: pid === viewerPid })),
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
    let better = 0;
    for (const score of day.values()) if (score < mine) better++;
    return { rank: better + 1, total: day.size };
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
      this.names = new Map(raw.names ?? []);
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
            names: [...this.names],
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
  async setName(...args) { await super.setName(...args); this._save(); }
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

  async recordBest(date, pid, score) {
    const key = `best:${date}`;
    // LT: only overwrite when the new score is lower. Golf — lower is better.
    await this._cmd('ZADD', key, 'LT', String(score), pid);
    await this._expire(key);
    return this.getBest(date, pid);
  }

  async getName(pid) {
    return (await this._cmd('GET', `name:${pid}`)) ?? null;
  }

  async setName(pid, name) {
    await this._cmd('SET', `name:${pid}`, name);
  }

  async leaderboard(date, viewerPid) {
    const flat = await this._cmd('ZRANGE', `best:${date}`, '0', String(LEADERBOARD_LIMIT - 1), 'WITHSCORES');
    if (!Array.isArray(flat) || flat.length === 0) return [];
    const rows = [];
    for (let i = 0; i < flat.length; i += 2) rows.push({ pid: flat[i], score: Number(flat[i + 1]) });
    const names = await this._cmd('MGET', ...rows.map((r) => `name:${r.pid}`));
    return withRanks(
      rows.map((r, i) => ({ score: r.score, name: names[i] || 'Anonym', you: r.pid === viewerPid })),
    );
  }

  /**
   * Competition ranking via ZCOUNT of strictly better scores — Redis does the
   * counting, so this stays one round trip per figure regardless of how many
   * players there are. ZRANK would break ties arbitrarily by insertion order.
   */
  async standing(date, pid) {
    const key = `best:${date}`;
    const mine = await this.getBest(date, pid);
    if (mine == null) return null;
    const [better, total] = await Promise.all([
      this._cmd('ZCOUNT', key, '-inf', `(${mine}`),
      this._cmd('ZCARD', key),
    ]);
    return { rank: Number(better) + 1, total: Number(total) };
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
