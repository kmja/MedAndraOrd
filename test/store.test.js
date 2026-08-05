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
  assert.deepEqual(lb.map((r) => [r.rank, r.name, r.score, r.you, r.count]), [
    [1, 'Bo', 4, true, 1],
    [2, 'Anonym', 7, false, 1],
    [3, 'Anna', 9, false, 1],
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
    if (c[0] === 'HMGET') return ['kort', 'längre ord'];
    if (c[0] === 'MGET') return ['Bo', 'Anna'];
    return null;
  });
  const board = await store.leaderboard('d', 'pidA', true);
  assert.deepEqual(board.map((r) => [r.rank, r.clue, r.score, r.you, r.count]), [
    [1, 'kort', 4, false, 1],
    [2, 'längre ord', 9, true, 1],
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

test('KvStore.standing ranks on the same tiebreak chain as the board', async () => {
  const { store } = stubKv((c) => {
    if (c[0] === 'ZSCORE') return '4';
    if (c[0] === 'HGET') return 'ades';                     // the viewer's clue
    if (c[0] === 'ZRANGE') return ['x', '4', 'me', '4'];
    if (c[0] === 'HMGET') return ['xkvj', 'ades'];          // rarer letters first
    return null;
  });
  // Same length, but the other clue wins on letter rarity.
  assert.deepEqual(await store.standing('d', 'me'), { rank: 2, total: 2 });
});

test('KvStore.standing falls back to score when no clue is on record', async () => {
  const { store } = stubKv((c) => {
    if (c[0] === 'ZSCORE') return '7';
    if (c[0] === 'HGET') return null;
    if (c[0] === 'ZRANGE') return ['x', '4', 'me', '7'];
    return null;
  });
  assert.deepEqual(await store.standing('d', 'me'), { rank: 2, total: 2 });
});


// ---------------------------------------------------------------------------
// the winning clues are the answer key
// ---------------------------------------------------------------------------

test('leaderboard withholds clues unless the viewer is allowed to see them', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4, 'kaninmat');

  const locked = await s.leaderboard('d', 'someone');
  assert.ok(!('clue' in locked[0]), 'a clue must not be sent to a player still guessing');

  const open = await s.leaderboard('d', 'someone', true);
  assert.equal(open[0].clue, 'kaninmat');
});

test('the stored clue follows the score it earned', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 8, 'lång ledtråd');
  await s.recordBest('d', 'a', 5, 'kort');
  assert.equal((await s.leaderboard('d', 'a', true))[0].clue, 'kort');

  // A worse later attempt must not overwrite the record or its clue.
  await s.recordBest('d', 'a', 9, 'sämre');
  const row = (await s.leaderboard('d', 'a', true))[0];
  assert.equal(row.score, 5);
  assert.equal(row.clue, 'kort');
});

test('dayStats averages the field', async () => {
  const s = new MemoryStore();
  assert.deepEqual(await s.dayStats('d'), { solvers: 0, average: null });
  await s.recordBest('d', 'a', 4, 'x');
  await s.recordBest('d', 'b', 6, 'y');
  assert.deepEqual(await s.dayStats('d'), { solvers: 2, average: 5 });
});

test('KvStore only writes the clue when the score actually improved', async () => {
  // Otherwise a worse later attempt would replace the clue on the record.
  const { store, calls } = stubKv((c) => {
    if (c[0] === 'ZSCORE') return '5';
    return 1;
  });
  await store.recordBest('d', 'pid', 9, 'sämre');
  assert.equal(calls.some((c) => c.command[0] === 'HSET'), false);

  const second = stubKv((c) => (c[0] === 'ZSCORE' ? '5' : 1));
  await second.store.recordBest('d', 'pid', 5, 'kort');
  const hset = second.calls.find((c) => c.command[0] === 'HSET');
  assert.ok(hset, 'expected the clue to be stored');
  assert.equal(hset.command[3], 'kort');
});

// ---------------------------------------------------------------------------
// ties and tiebreakers
// ---------------------------------------------------------------------------

test('same length: fewer spaces wins', async () => {
  const s = new MemoryStore();
  // Same characters, same rarity — only the spacing differs.
  await s.recordBest('d', 'a', 8, 'kanin mat');
  await s.recordBest('d', 'b', 8, 'kaninmat');
  const board = await s.leaderboard('d', 'x', true);
  assert.equal(board[0].clue, 'kaninmat', 'the unspaced clue ranks first');
  assert.equal(board[1].clue, 'kanin mat');
});

test('same length and spacing: rarer letters win', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4, 'ades');  // the four commonest-ish letters
  await s.recordBest('d', 'b', 4, 'xkvj');  // rare letters
  const board = await s.leaderboard('d', 'x', true);
  assert.equal(board[0].clue, 'xkvj');
  assert.equal(board[1].clue, 'ades');
});

test('identical clues collapse into one row with a count', async () => {
  const s = new MemoryStore();
  for (const pid of ['a', 'b', 'c']) await s.recordBest('d', pid, 8, 'kaninmat');
  await s.recordBest('d', 'z', 9, 'annatord');

  const board = await s.leaderboard('d', 'b', true);
  assert.equal(board.length, 2, 'the three identical clues are one row');
  assert.equal(board[0].count, 3);
  assert.equal(board[0].you, true, 'the viewer is in that group');
  assert.equal(board[0].name, null, 'a shared row has no single author');
  assert.equal(board[1].count, 1);
  assert.equal(board[1].name, 'Anonym');
});

test('grouping ignores case and spacing differences', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 8, 'Kaninmat');
  await s.recordBest('d', 'b', 8, 'kaninmat');
  const board = await s.leaderboard('d', 'a', true);
  assert.equal(board.length, 1);
  assert.equal(board[0].count, 2);
});

test('standing uses the same tiebreak chain as the board', async () => {
  // If these diverge, a player is told a placing that contradicts their row.
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4, 'xkvj'); // rare letters, ranks first
  await s.recordBest('d', 'b', 4, 'ades'); // same length, common letters
  const board = await s.leaderboard('d', 'b', true);
  const mine = board.find((r) => r.you);
  const standing = await s.standing('d', 'b');
  assert.equal(mine.rank, standing.rank);
  assert.equal(standing.rank, 2);
});

test('grouped rows still withhold clues before the reveal', async () => {
  const s = new MemoryStore();
  for (const pid of ['a', 'b']) await s.recordBest('d', pid, 8, 'kaninmat');
  const locked = await s.leaderboard('d', 'x');
  assert.equal(locked[0].count, 2, 'the count is safe to show');
  assert.ok(!('clue' in locked[0]), 'the clue itself is not');
});
