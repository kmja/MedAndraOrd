import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  textOf, parseRuling, guesserSystemPrompt, batchGuesserSystemPrompt,
  parseBatchGuesses, classifyApiError, retryDelayMs,
} from '../server/ai.js';
import { WORDS } from '../server/words.js';
import { normalize } from '../server/util.js';

// The provider-shaped glue. These two functions sit between the model and the
// game rules, and both must degrade to null rather than throw — every caller
// treats null as "check unavailable" and fails open. A throw here would turn a
// flaky API into a 500 instead of a playable round.

test('textOf reads the SDK convenience field', () => {
  assert.equal(textOf({ text: 'morot' }), 'morot');
});

test('textOf falls back to candidate parts', () => {
  const response = { candidates: [{ content: { parts: [{ text: 'mo' }, { text: 'rot' }] } }] };
  assert.equal(textOf(response), 'morot');
});

test('textOf returns null for empty or malformed responses', () => {
  for (const bad of [
    null,
    undefined,
    {},
    { text: '' },
    { text: '   ' },
    { candidates: [] },
    { candidates: [{}] },
    { candidates: [{ content: {} }] },
    { candidates: [{ content: { parts: [] } }] },
    { candidates: [{ content: { parts: [{}] } }] },
  ]) {
    assert.equal(textOf(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('textOf never throws on unexpected shapes', () => {
  for (const bad of [0, 'string', [], { candidates: 'nope' }, { candidates: [{ content: { parts: 'nope' } }] }]) {
    assert.doesNotThrow(() => textOf(bad));
  }
});

test('parseRuling accepts a clean legal verdict', () => {
  assert.deepEqual(parseRuling('{"legal": true}'), { legal: true, reason: null });
});

test('parseRuling accepts an illegal verdict with a reason', () => {
  assert.deepEqual(parseRuling('{"legal": false, "reason": "Översättning."}'), {
    legal: false,
    reason: 'Översättning.',
  });
});

test('parseRuling digs JSON out of surrounding chatter', () => {
  const messy = 'Här är min bedömning:\n```json\n{"legal": false, "reason": "Förkortning."}\n```';
  assert.deepEqual(parseRuling(messy), { legal: false, reason: 'Förkortning.' });
});

test('parseRuling returns null rather than guessing', () => {
  // null means "referee unavailable", which fails open. Anything ambiguous
  // must land here instead of being read as a rejection.
  for (const bad of [
    null,
    '',
    'ja det är okej',
    '{"legal": "true"}', // string, not boolean
    '{"reason": "saknar legal"}',
    '{ not json at all }',
  ]) {
    assert.equal(parseRuling(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('parseRuling never throws', () => {
  for (const bad of [undefined, 0, {}, []]) {
    assert.doesNotThrow(() => parseRuling(bad));
  }
});

// ---------------------------------------------------------------------------
// The guesser's prompt

test('the guesser prompt names no word from the bank', () => {
  // The guesser is blind — it never sees the target. But this prompt is in its
  // context on every call, so any bank word written here is a word the model
  // can reach for on a vague clue, making it quietly easier than the rest of
  // the bank for a reason that has nothing to do with the player's clue.
  //
  // This caught six: morot, vulkan, torn, månad, stövel and kaffe, all used as
  // examples of rules. Illustrations must come from outside the bank.
  //
  // A handful of bank words are also ordinary Swedish function words that the
  // prompt cannot be written without. Those are noise rather than anchors: the
  // risk is a word presented as an ANSWER, not a word appearing as grammar.
  // Keep this list short, and only add to it when the word genuinely cannot be
  // phrased around.
  const UNAVOIDABLE = new Set(['vad']);

  // Both prompts, since they share a rulebook and either one reaches a model.
  for (const [name, prompt] of [
    ['gissarprompten', guesserSystemPrompt(6)],
    ['batch-prompten', batchGuesserSystemPrompt()],
  ]) {
    const mentioned = new Set(prompt.toLowerCase().match(/\p{L}+/gu) ?? []);
    const leaked = WORDS.map((e) => e.word)
      .filter((w) => !UNAVOIDABLE.has(normalize(w)))
      .filter((w) => mentioned.has(normalize(w)));
    assert.deepEqual(
      leaked,
      [],
      `Ord ur banken förekommer i ${name}: ${leaked.join(', ')}. ` +
        'Byt exemplen mot ord som inte är målord.',
    );
  }
});

test('both guessers are given the same rulebook', () => {
  // Batching exists to measure the same game more cheaply. If the two prompts
  // drifted apart they would measure two different games, and the calibration
  // that compares them would be comparing the wrong thing.
  const single = guesserSystemPrompt(6);
  const batch = batchGuesserSystemPrompt();
  for (const rule of [
    'Inte är svenska',
    'Bokstaverar eller rimmar',
    'lucka att fylla i',
    'egennamn och kända exempel',
    'Var generös i övrigt',
  ]) {
    assert.ok(single.includes(rule), `single prompt missing: ${rule}`);
    assert.ok(batch.includes(rule), `batch prompt missing: ${rule}`);
  }
  // And the batch prompt must additionally push against cross-reading.
  assert.match(batch, /Behandla varje ledtråd helt för sig/);
});

test('parseBatchGuesses keeps clean answers and drops the rest', () => {
  // A dropped id is re-asked one at a time, so a malformed entry costs a call
  // and never a wrong verdict. Batching must not be able to turn a clue into
  // the wrong answer, only into a slower one.
  const got = parseBatchGuesses(`{"answers":[
    {"id":1,"legal":true,"guess":"stövel"},
    {"id":2,"legal":false,"reason":"Rim."},
    {"id":3,"legal":true},
    {"id":4,"legal":true,"guess":"  "},
    {"legal":true,"guess":"utan id"},
    {"id":"sex","legal":true,"guess":"fel id"}
  ]}`);
  assert.deepEqual([...got.keys()], [1, 2]);
  assert.deepEqual(got.get(1), { legal: true, guess: 'stövel' });
  assert.deepEqual(got.get(2), { legal: false, reason: 'Rim.' });
});

test('parseBatchGuesses returns null when the whole reply is unusable', () => {
  for (const bad of [null, '', 'ingen json', '{"answers":"nej"}', '{"nope":[]}']) {
    assert.equal(parseBatchGuesses(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('the guesser prompt states the letter count it was given', () => {
  // The count is the only fact besides the clue that the guesser gets. If the
  // interpolation broke, every guess would be the wrong length and every round
  // would burn its retries before failing.
  assert.match(guesserSystemPrompt(7), /exakt 7 bokstäver/);
  assert.match(guesserSystemPrompt(3), /exakt 3 bokstäver/);
});

test('the guesser prompt tells the model to expect oblique clues', () => {
  // Golf scoring pushes players toward cryptic-crossword phrasing rather than
  // definitions. A guesser reading those literally rejects or misses good
  // clues, so the framing is load-bearing, not decoration.
  const prompt = guesserSystemPrompt(6);
  assert.match(prompt, /kryptisk|omskrivning/i);
  assert.match(prompt, /inte bokstavligt|Läs ledtråden som den är tänkt/i);
});

// ---------------------------------------------------------------------------
// API failures
//
// The right response differs completely per kind: a quota error means wait, a
// key error means stop, and anything else means treat the check as unavailable
// and carry on. Getting the classification wrong means either hammering a
// dead key or writing off a word that only needed ten seconds.

test('classifyApiError spots quota errors however they are shaped', () => {
  // The SDK builds errors on more than one path — sometimes `status` is the
  // numeric code, sometimes the status text, sometimes only the message says.
  for (const err of [
    { status: 429 },
    { status: 'Too Many Requests', message: 'got status: 429' },
    { message: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' },
    { message: 'You exceeded your current quota' },
    { message: 'rate limit exceeded' },
  ]) {
    assert.equal(classifyApiError(err), 'rate_limit', JSON.stringify(err));
  }
});

test('classifyApiError separates key problems, which retrying cannot fix', () => {
  for (const err of [
    { status: 401 },
    { status: 403 },
    { message: 'API key not valid. Please pass a valid API key.' },
    { message: 'Could not load the default credentials' }, // the missing-key case
  ]) {
    assert.equal(classifyApiError(err), 'auth', JSON.stringify(err));
  }
});

test('classifyApiError does not mistake ordinary failures for quota', () => {
  assert.equal(classifyApiError(new Error('socket hang up')), 'other');
  assert.equal(classifyApiError(undefined), 'other');
  assert.equal(classifyApiError({ status: 503 }), 'transient');
});

test('retryDelayMs honours the wait the API asked for', () => {
  // A per-minute quota wants the rest of that minute, not an exponential ramp,
  // so the server's own suggestion beats any backoff we invent.
  assert.equal(retryDelayMs({ message: '"retryDelay":"27s"' }), 27_000);
  assert.equal(retryDelayMs({ message: 'retryDelay: "1.5s"' }), 1500);
  assert.equal(retryDelayMs({ message: 'no delay here' }), null);
  assert.equal(retryDelayMs(undefined), null);
  // Never wait absurdly long on a malformed or hostile value.
  assert.equal(retryDelayMs({ message: '"retryDelay":"99999s"' }), 60_000);
});
