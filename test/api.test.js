import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

// Point the store somewhere disposable before anything imports it — the store
// is a module-level singleton created on first use, so this must run first.
process.env.ORDKNAPP_DATA = path.join(os.tmpdir(), `ledtraden-test-${process.pid}.json`);

// Exercises the Vercel serverless entrypoints exactly as Vercel calls them:
// a default-exported (req, res) handler with an already-parsed body.
// These are the paths no local Express smoke test covers.

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(payload) { this.body = payload ? JSON.parse(payload) : null; },
  };
  return res;
}

const mockReq = (over = {}) => ({ method: 'GET', headers: {}, body: undefined, ...over });

test('api/state returns today\'s puzzle and issues a player cookie', async () => {
  const { default: handler } = await import('../api/state.js');
  const res = mockRes();
  await handler(mockReq(), res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body.word, 'expected a word');
  // Same reasoning as the limit below: the list is per word, and pinning a
  // count here means the day a word earns a sixth forbidden entry, an
  // unrelated test goes red. The contract is that a real list is always sent.
  assert.ok(res.body.forbidden.length >= 4, 'expected a real forbidden list');
  // The limit is per word, so the value is whatever today's word carries —
  // assert the contract (a usable number is always sent), not a constant.
  assert.equal(typeof res.body.maxClueLength, 'number');
  assert.ok(res.body.maxClueLength >= 8 && res.body.maxClueLength <= 24);
  assert.equal(res.body.attemptsLeft, 5);

  const cookie = res.headers['set-cookie'];
  assert.match(cookie, /^ordknapp_pid=[a-f0-9]{32};/);
  assert.match(cookie, /HttpOnly/, 'the player id must not be readable from JS');
  assert.match(cookie, /SameSite=Lax/);
});

test('api/state never leaks the answer through a scoring field', async () => {
  const { default: handler } = await import('../api/state.js');
  const res = mockRes();
  await handler(mockReq(), res);
  // The player is shown the word — it's the guesser that is blind — but the
  // response must not carry anything that lets a client fake a score.
  assert.equal(res.body.best, null);
  assert.ok(!('score' in res.body));
});

test('api/random serves a practice word that is never today\'s', async () => {
  const [{ default: randomHandler }, { default: stateHandler }] = await Promise.all([
    import('../api/random.js'),
    import('../api/state.js'),
  ]);
  const stateRes = mockRes();
  await stateHandler(mockReq(), stateRes);

  for (let i = 0; i < 25; i++) {
    const res = mockRes();
    await randomHandler(mockReq(), res);
    assert.notEqual(res.body.word, stateRes.body.word, 'practice must not serve the live word');
    assert.equal(typeof res.body.wordIndex, 'number');
  }
});

test('api/clue rejects an empty telegram without calling the model', async () => {
  const { default: handler } = await import('../api/clue.js');
  const res = mockRes();
  await handler(mockReq({ method: 'POST', body: { clue: '   ' } }), res);
  assert.equal(res.statusCode, 400);
});

test('api/clue refuses practice on today\'s word — the daily limit loophole', async () => {
  const [{ default: clueHandler }, { wordForDate }, { todayInStockholm }] = await Promise.all([
    import('../api/clue.js'),
    import('../server/words.js'),
    import('../server/util.js'),
  ]);
  const todayIndex = wordForDate(todayInStockholm()).index;
  const res = mockRes();
  await clueHandler(
    mockReq({ method: 'POST', body: { clue: 'test', practice: true, wordIndex: todayIndex } }),
    res,
  );
  assert.equal(res.statusCode, 403);
});

test('api/clue validates wordIndex against the bank', async () => {
  const { default: handler } = await import('../api/clue.js');
  for (const wordIndex of [-1, 99999, 'abc']) {
    const res = mockRes();
    await handler(mockReq({ method: 'POST', body: { clue: 'test', practice: true, wordIndex } }), res);
    assert.equal(res.statusCode, 400, `wordIndex ${wordIndex} should be rejected`);
  }
});

test('api/clue accepts a stringified body (Vercel does not always parse)', async () => {
  const { default: handler } = await import('../api/clue.js');
  const res = mockRes();
  await handler(mockReq({ method: 'POST', body: JSON.stringify({ clue: '' }) }), res);
  assert.equal(res.statusCode, 400, 'a string body must parse, not crash');
});

test('a rejected clue never consumes an attempt, however many times it is sent', async () => {
  // Exercises the costsAttempt wiring through the real handler and store.
  const [{ default: clueHandler }, { default: stateHandler }] = await Promise.all([
    import('../api/clue.js'),
    import('../api/state.js'),
  ]);
  const first = mockRes();
  await stateHandler(mockReq(), first);
  const cookie = first.headers['set-cookie'].split(';')[0];
  const headers = { cookie };

  for (let i = 0; i < 3; i++) {
    const res = mockRes();
    // Emoji: rejected in code, so this needs no API key.
    await clueHandler(mockReq({ method: 'POST', headers, body: { clue: 'test 🥕' } }), res);
    assert.equal(res.body.result.type, 'rejected');
    assert.equal(res.body.attemptsLeft, 5, `attempt consumed on submission ${i + 1}`);
  }
});

test('practice mode does not cache an AI failure', async () => {
  // The daily path already refused to cache these. Practice cached everything,
  // so a clue that hit a transient failure stayed failed: resubmitting it
  // returned the stale verdict instantly instead of letting the model try
  // again.
  const { isCacheableVerdict } = await import('../server/game.js');
  assert.equal(isCacheableVerdict({ type: 'ai_failure', guess: 'eldstad' }), false);
  const src = await readFile(new URL('../server/handlers.js', import.meta.url), 'utf8');
  assert.match(
    src,
    /if \(isCacheableVerdict\(verdict\)\) cachePractice\(key, verdict\)/,
    'practice caching must be gated on isCacheableVerdict',
  );
});
