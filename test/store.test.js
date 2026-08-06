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

test('leaderboard sorts ascending and marks the viewer', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 9, 'niotecken');
  await s.recordBest('d', 'b', 4, 'fyra');
  await s.recordBest('d', 'c', 7, 'sjuteck');
  const lb = await s.leaderboard('d', 'b', true);
  assert.deepEqual(lb.map((r) => [r.rank, r.clue, r.score, r.you, r.count]), [
    [1, 'fyra', 4, true, 1],
    [2, 'sjuteck', 7, false, 1],
    [3, 'niotecken', 9, false, 1],
  ]);
});

test('a row carries nothing about a player beyond a chosen name', async () => {
  // Names are opt-in and are the ONLY thing about a player that may appear.
  // The player id in particular must never leave the server: it is the cookie
  // that counts attempts, and publishing it would let anyone impersonate a row.
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4, 'fyra');

  const [anon] = await s.leaderboard('d', 'a', true);
  assert.deepEqual(Object.keys(anon).sort(), ['clue', 'count', 'rank', 'score', 'you'],
    'a player who set no name adds no field');

  await s.setName('a', 'Karl');
  const [named] = await s.leaderboard('d', 'a', true);
  assert.deepEqual(Object.keys(named).sort(), ['clue', 'count', 'names', 'rank', 'score', 'you']);
  assert.deepEqual(named.names, ['Karl']);
  assert.ok(!('pid' in named) && !('pids' in named), 'player ids must not reach a client');
});

test('names survive the day they were set on', async () => {
  // Everything else is scoped to a puzzle and expires with it. A name is not:
  // it belongs to the player, and expiring it would quietly anonymise someone
  // who came back tomorrow and did nothing wrong.
  const s = new MemoryStore();
  await s.setName('a', 'Karl');
  await s.recordBest('2026-08-06:255', 'a', 4, 'fyra');
  await s.recordBest('2026-08-07:100', 'a', 6, 'sextec');
  for (const puzzle of ['2026-08-06:255', '2026-08-07:100']) {
    const [row] = await s.leaderboard(puzzle, 'a', true);
    assert.deepEqual(row.names, ['Karl'], `name missing on ${puzzle}`);
  }
});

test('a shared row lists its named players and still counts the anonymous ones', async () => {
  // Identical clues share a row, and the best clue of the day is the likeliest
  // to be shared — so this is exactly the row where names are worth reading.
  // A player with no name is on the row but not in the list, and a count that
  // disagreed with the names would look like a bug.
  const s = new MemoryStore();
  for (const pid of ['a', 'b', 'c']) await s.recordBest('d', pid, 4, 'guld');
  await s.setName('a', 'Karl');
  await s.setName('b', 'Anna');
  const [row] = await s.leaderboard('d', 'a', true);
  assert.equal(row.count, 3);
  assert.deepEqual(row.names, ['Karl', 'Anna']);
});

test('names are shown even while the clues are still hidden', async () => {
  // The clues are the answer key and stay hidden until you are done for the
  // day. Who is on the board gives nothing away, and hiding it would leave the
  // board unreadable in the state most people see it in.
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4, 'fyra');
  await s.setName('a', 'Karl');
  const [row] = await s.leaderboard('d', 'someone-else', false);
  assert.ok(!('clue' in row), 'the clue must still be withheld');
  assert.deepEqual(row.names, ['Karl']);
});

test('clearing a name takes it off the board', async () => {
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 4, 'fyra');
  await s.setName('a', 'Karl');
  await s.setName('a', null);
  const [row] = await s.leaderboard('d', 'a', true);
  assert.ok(!('names' in row));
  assert.equal(await s.getName('a'), null);
});

test('clue verdict cache is per puzzle, not per day', async () => {
  // Per day was not enough. Growing the word bank changes which word a date
  // maps to, so a verdict judged against one word could be handed to a clue
  // written for another on the very same date.
  const s = new MemoryStore();
  await s.cacheVerdict('2026-08-05:158', 'kanin', { type: 'wrong' });
  assert.deepEqual(await s.getCachedVerdict('2026-08-05:158', 'kanin'), { type: 'wrong' });
  assert.equal(await s.getCachedVerdict('2026-08-06:158', 'kanin'), null, 'different day');
  assert.equal(await s.getCachedVerdict('2026-08-05:370', 'kanin'), null, 'same day, different word');
});

test('a cached verdict can be given a lifetime, and expires when it is up', async () => {
  const s = new MemoryStore();
  await s.cacheVerdict('p', 'blött plask', { type: 'rejected' }, 600);
  assert.deepEqual(await s.getCachedVerdict('p', 'blött plask'), { type: 'rejected' });

  // Expiry is read at lookup time, so moving the clock forward is enough.
  const realNow = Date.now;
  Date.now = () => realNow() + 601_000;
  try {
    assert.equal(await s.getCachedVerdict('p', 'blött plask'), null, 'should have expired');
  } finally {
    Date.now = realNow;
  }
});

test('a verdict cached with no lifetime keeps the old never-expires behaviour', async () => {
  const s = new MemoryStore();
  await s.cacheVerdict('p', 'kanin', { type: 'correct', score: 5 });
  const realNow = Date.now;
  Date.now = () => realNow() + 40 * 24 * 3600 * 1000;
  try {
    assert.deepEqual(await s.getCachedVerdict('p', 'kanin'), { type: 'correct', score: 5 });
  } finally {
    Date.now = realNow;
  }
});

test('a bare verdict left by an older build still reads back', async () => {
  // FileStore reloads what earlier versions wrote, and those entries are the
  // verdict itself rather than a { verdict, expiresAt } wrapper.
  const s = new MemoryStore();
  s.clues.set('p:kanin', { type: 'wrong', guess: 'hare' });
  assert.deepEqual(await s.getCachedVerdict('p', 'kanin'), { type: 'wrong', guess: 'hare' });
});

test('scores are per puzzle, so a bank change starts a clean board', async () => {
  const s = new MemoryStore();
  await s.recordBest('2026-08-05:158', 'a', 6, 'vinterplagg');
  assert.equal(await s.getBest('2026-08-05:158', 'a'), 6);
  // Same date, word moved: the old board must not follow the new word.
  assert.equal(await s.getBest('2026-08-05:370', 'a'), null);
  assert.deepEqual(await s.leaderboard('2026-08-05:370', 'a', true), []);
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
  const { store, calls } = stubKv(() => 0);
  await store.getAttempts('d', 'pid');
  assert.equal(calls[0].url, 'https://kv.example.com');
  assert.equal(calls[0].auth, 'Bearer tok');
});

test('KvStore uses INCR for attempts, so concurrent writes cannot clobber', async () => {
  const { store, calls } = stubKv(() => 3);
  assert.equal(await store.incrAttempts('2026-08-05', 'pid'), 3);
  assert.equal(calls[0].command[0], 'INCR');
  assert.equal(calls[0].command[1], 'att:2026-08-05:pid');
});

test('KvStore expires a refusal on its own short clock, not the 40-day one', async () => {
  // SET clears any existing TTL, so the EXPIRE that follows is what decides
  // how long this ruling lives — including when an old long-lived entry is
  // overwritten.
  const { store, calls } = stubKv(() => 'OK');
  await store.cacheVerdict('p', 'blött plask', { type: 'rejected' }, 600);
  assert.deepEqual(calls.map((c) => c.command[0]), ['SET', 'EXPIRE']);
  assert.equal(calls[1].command[1], 'clue:p:blött plask');
  assert.equal(Number(calls[1].command[2]), 600);
});

test('KvStore keeps the 40-day life for rulings with no lifetime of their own', async () => {
  const { store, calls } = stubKv(() => 'OK');
  await store.cacheVerdict('p', 'kanin', { type: 'correct' });
  assert.equal(Number(calls[1].command[2]), 60 * 60 * 24 * 40);
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
  await store.cacheVerdict('d:12', 'ledtråd', { type: 'correct', score: 8 });
  assert.deepEqual(await store.getCachedVerdict('d:12', 'ledtråd'), { type: 'correct', score: 8 });
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
  await s.recordBest('d', 'a', 4, 'fyra');
  await s.recordBest('d', 'b', 6, 'sextecken');
  await s.recordBest('d', 'c', 6, 'sexctecke');

  const board = await s.leaderboard('d', 'c', true);
  const mine = board.find((r) => r.you);
  assert.equal(mine.clue, 'sexctecke', 'the viewer flag must land on the viewer');
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
  await s.recordBest('d', 'a', 11, 'lång ledtråd');
  await s.recordBest('d', 'a', 4, 'kort');
  assert.equal((await s.leaderboard('d', 'a', true))[0].clue, 'kort');

  // A worse later attempt must not overwrite the record or its clue.
  await s.recordBest('d', 'a', 5, 'sämre');
  const row = (await s.leaderboard('d', 'a', true))[0];
  assert.equal(row.score, 4);
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
  assert.equal(board[1].count, 1);
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

test('a row\'s score always matches the clue it shows', async () => {
  // The order comes from the clue, so the number must too — otherwise a board
  // can appear misordered even though the sort was correct.
  const s = new MemoryStore();
  await s.recordBest('d', 'a', 999, 'kaninmat'); // deliberately inconsistent
  const [row] = await s.leaderboard('d', 'a', true);
  assert.equal(row.score, 8, 'score is derived from the clue');
});
