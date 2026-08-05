import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStore, KvStore } from '../server/store.js';

// ---------------------------------------------------------------------------
// MemoryStore — the reference semantics every backend must match.
// ---------------------------------------------------------------------------

test('attempts increment per player per day', async () => {
  const s = new MemoryStore();
  assert.equal(await s.getAttempts('2026-08-05', 'a'), 0);
  assert.equal(await s.incrAttempts('2026-08-05', 'a'), 1);
  assert.equal(await s.incrAttempts('2026-08-05', 'a'), 2);
  assert.equal(await s.getAttempts('2026-08-05', 'b'), 0, 'players must not share a counter');
  assert.equal(await s.getAttempts('2026-08-06', 'a'), 0, 'days must not share a counter');
});

test('best score keeps the lowest — golf, lower is better', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 12);
  assert.equal(await s.getBest('d', 'a'), 12);
  await s.recordBest('d', 'a', 8);
  assert.equal(await s.getBest('d', 'a'), 8);
  await s.recordBest('d', 'a', 10);
  assert.equal(await s.getBest('d', 'a'), 8, 'a worse later score must not overwrite the best');
});

test('leaderboard sorts ascending and resolves names', async () => {
  const s = new MemoryStore();
  await s.setName('a', 'Anna');
  await s.setName('b', 'Bo');
  await s.recordBest('d', 'a', 9);
  await s.recordBest('d', 'b', 4);
  await s.recordBest('d', 'c', 7); // no name set
  const lb = await s.leaderboard('d');
  assert.deepEqual(lb, [
    { rank: 1, name: 'Bo', score: 4 },
    { rank: 2, name: 'Anonym', score: 7 },
    { rank: 3, name: 'Anna', score: 9 },
  ]);
});

test('clue verdict cache is per day', async () => {
  const s = new MemoryStore();
  await s.cacheVerdict('2026-08-05', 0, 'kanin', { type: 'wrong' });
  assert.deepEqual(await s.getCachedVerdict('2026-08-05', 0, 'kanin'), { type: 'wrong' });
  assert.equal(await s.getCachedVerdict('2026-08-06', 0, 'kanin'), null);
});

test('MemoryStore reports itself as non-durable', () => {
  assert.equal(new MemoryStore().durable, false);
});

// ---------------------------------------------------------------------------
// KvStore — verified against a stubbed Upstash REST endpoint, since the real
// one needs a provisioned database.
// ---------------------------------------------------------------------------

function stubKv(responder) {
  const calls = [];
  const store = new KvStore('https://kv.example.com/', 'tok');
  global.fetch = async (url, opts) => {
    const command = JSON.parse(opts.body);
    calls.push({ url, command, auth: opts.headers.Authorization });
    return { ok: true, json: async () => ({ result: responder(command) }) };
  };
  return { store, calls };
}

test('KvStore authenticates and strips the trailing slash from the URL', async () => {
  const { store, calls } = stubKv(() => null);
  await store.getName('pid');
  assert.equal(calls[0].url, 'https://kv.example.com');
  assert.equal(calls[0].auth, 'Bearer tok');
});

test('KvStore uses INCR for attempts, so concurrent writes cannot clobber', async () => {
  const { store, calls } = stubKv(() => 3);
  assert.equal(await store.incrAttempts('2026-08-05', 'pid'), 3);
  assert.equal(calls[0].command[0], 'INCR');
  assert.equal(calls[0].command[1], 'att:2026-08-05:pid');
});

test('KvStore records bests with ZADD LT so only improvements land', async () => {
  const { store, calls } = stubKv((c) => (c[0] === 'ZSCORE' ? '7' : 1));
  assert.equal(await store.recordBest('d', 'pid', 7), 7);
  const zadd = calls.find((c) => c.command[0] === 'ZADD');
  assert.ok(zadd, 'expected a ZADD');
  assert.equal(zadd.command[2], 'LT', 'without LT a worse score would overwrite the best');
});

test('KvStore parses the flat ZRANGE WITHSCORES reply into ranked rows', async () => {
  const { store } = stubKv((c) => {
    if (c[0] === 'ZRANGE') return ['pidB', '4', 'pidA', '9'];
    if (c[0] === 'MGET') return ['Bo', null];
    return null;
  });
  assert.deepEqual(await store.leaderboard('d'), [
    { rank: 1, name: 'Bo', score: 4 },
    { rank: 2, name: 'Anonym', score: 9 },
  ]);
});

test('KvStore returns an empty leaderboard when the day has no scores', async () => {
  const { store } = stubKv(() => []);
  assert.deepEqual(await store.leaderboard('d'), []);
});

test('KvStore round-trips verdicts as JSON', async () => {
  const saved = {};
  const { store } = stubKv((c) => {
    if (c[0] === 'SET') { saved[c[1]] = c[2]; return 'OK'; }
    if (c[0] === 'GET') return saved[c[1]] ?? null;
    return null;
  });
  await store.cacheVerdict('d', 0, 'ledtråd', { type: 'correct', score: 8 });
  assert.deepEqual(await store.getCachedVerdict('d', 0, 'ledtråd'), { type: 'correct', score: 8 });
});

test('KvStore reports itself as durable', () => {
  assert.equal(new KvStore('https://x', 't').durable, true);
});
