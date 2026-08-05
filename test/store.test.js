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
  const lb = await s.leaderboard('d', 'b');
  assert.deepEqual(lb, [
    { rank: 1, name: 'Bo', score: 4, you: true },
    { rank: 2, name: 'Anonym', score: 7, you: false },
    { rank: 3, name: 'Anna', score: 9, you: false },
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
  assert.deepEqual(await store.leaderboard('d', 'pidA'), [
    { rank: 1, name: 'Bo', score: 4, you: false },
    { rank: 2, name: 'Anonym', score: 9, you: true },
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

// ---------------------------------------------------------------------------
// standing + leaderboard identity
// ---------------------------------------------------------------------------

test('standing uses competition ranking, so ties share a place', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4);
  await s.recordBest('d', 'b', 6);
  await s.recordBest('d', 'c', 6);
  await s.recordBest('d', 'e', 9);
  assert.deepEqual(await s.standing('d', 'a'), { rank: 1, total: 4 });
  assert.deepEqual(await s.standing('d', 'b'), { rank: 2, total: 4 });
  assert.deepEqual(await s.standing('d', 'c'), { rank: 2, total: 4 }, 'tied players share a rank');
  assert.deepEqual(await s.standing('d', 'e'), { rank: 4, total: 4 }, 'the tie consumes the next place');
});

test('standing is null for a player who has not solved it', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4);
  assert.equal(await s.standing('d', 'nobody'), null);
  assert.equal(await s.standing('otherday', 'a'), null);
});

test('leaderboard ranks agree with standing, and mark the viewer', async () => {
  // These two disagreeing is how a player ends up labelled as someone else.
  const s = new MemoryStore();
  await s.setName('a', 'Astrid');
  await s.setName('b', 'Bo');
  await s.setName('c', 'Cilla');
  await s.recordBest('d', 'a', 4);
  await s.recordBest('d', 'b', 6);
  await s.recordBest('d', 'c', 6);

  const board = await s.leaderboard('d', 'c');
  assert.deepEqual(board.map((r) => r.rank), [1, 2, 2]);

  const mine = board.find((r) => r.you);
  assert.equal(mine.name, 'Cilla', 'the viewer flag must land on the viewer');
  assert.equal(board.filter((r) => r.you).length, 1);

  const standing = await s.standing('d', 'c');
  assert.equal(mine.rank, standing.rank, 'stated placing must match the row shown');
});

test('leaderboard marks nobody when the viewer has not played', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4);
  const board = await s.leaderboard('d', 'stranger');
  assert.equal(board.filter((r) => r.you).length, 0);
});

test('KvStore.standing counts strictly better scores', async () => {
  const { store, calls } = stubKv((c) => {
    if (c[0] === 'ZSCORE') return '6';
    if (c[0] === 'ZCOUNT') return 2;
    if (c[0] === 'ZCARD') return 14;
    return null;
  });
  assert.deepEqual(await store.standing('d', 'pid'), { rank: 3, total: 14 });
  const zcount = calls.find((c) => c.command[0] === 'ZCOUNT');
  assert.equal(zcount.command[3], '(6', 'must exclude equal scores, or ties would outrank each other');
});
