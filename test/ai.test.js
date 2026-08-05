import { test } from 'node:test';
import assert from 'node:assert/strict';

import { textOf, parseRuling } from '../server/ai.js';

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
