import { test } from 'node:test';
import assert from 'node:assert/strict';

import { textOf, parseRuling, guesserSystemPrompt } from '../server/ai.js';
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

  const prompt = guesserSystemPrompt(6).toLowerCase();
  const words = prompt.match(/\p{L}+/gu) ?? [];
  const mentioned = new Set(words);

  const leaked = WORDS.map((e) => e.word)
    .filter((w) => !UNAVOIDABLE.has(normalize(w)))
    .filter((w) => mentioned.has(normalize(w)));
  assert.deepEqual(
    leaked,
    [],
    `Ord ur banken förekommer i gissarprompten: ${leaked.join(', ')}. ` +
      'Byt exemplen mot ord som inte är målord.',
  );
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
