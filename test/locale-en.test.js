import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { inflectionsOf, compoundStemsOf, looksInflected } from '../server/locales/en/morphology.js';
import { LETTER_FREQUENCY, UNLISTED_FREQUENCY } from '../server/locales/en/frequency.js';

// The English word list, read straight from the shards so these tests do not
// depend on which locale the rest of the process resolved.
const shards = new Map();
function isWord(word) {
  const w = String(word ?? '').toLowerCase();
  if (!w) return false;
  const len = w.length;
  if (!shards.has(len)) {
    try {
      const raw = fs.readFileSync(new URL(`../server/data/en-words-${len}.txt`, import.meta.url), 'utf8');
      shards.set(len, new Set(raw.split('\n').filter(Boolean)));
    } catch {
      shards.set(len, null);
    }
  }
  const set = shards.get(len);
  return set === null ? null : set.has(w);
}

test('the English word list shipped and is readable', () => {
  assert.ok(isWord('church'), 'expected the dictionary shards to be present');
  assert.equal(isWord('kyrka'), false, 'the Swedish list must not answer for English');
});

test('inflectionsOf covers the regular English patterns', () => {
  const has = (word, form) => assert.ok(
    inflectionsOf(word).has(form), `${word} should generate ${form}`,
  );
  has('church', 'churches');   // sibilant takes -es
  has('box', 'boxes');
  has('city', 'cities');       // consonant + y flips to i
  has('carry', 'carried');
  has('make', 'making');       // final -e drops
  has('large', 'larger');
  has('knife', 'knives');      // -fe turns into -ves
  has('leaf', 'leaves');
  has('potato', 'potatoes');   // -o takes -es
  has('run', 'running');       // short CVC doubles
  has('big', 'biggest');
  has('mouse', 'mice');        // irregular, from the table
  has('child', 'children');
});

test('inflectionsOf does not double where English does not', () => {
  // w, x and y never double: "flowing" not "flowwing", "playing" not "playying".
  assert.ok(!inflectionsOf('flow').has('flowwing'));
  assert.ok(!inflectionsOf('play').has('playying'));
  // A long vowel does not double either: "reading", not "readding".
  assert.ok(!inflectionsOf('read').has('readding'));
  // And nothing is ever its own inflection.
  for (const w of ['church', 'run', 'city', 'knife', 'mouse']) {
    assert.ok(!inflectionsOf(w).has(w), `${w} should not be its own inflection`);
  }
});

test('English has no compound stems, and that is the right answer', () => {
  // Swedish drops a final -a or -e before the second element, so "kyrka" hides
  // inside "kyrkklocka" as "kyrk" and no substring test can see it. English
  // leaves the stem alone — "bookshelf" still contains "book" — so the plain
  // substring check in checkClueCode already catches every compound and there
  // is nothing left for this to add.
  for (const w of ['book', 'church', 'city', 'knife', 'water']) {
    assert.deepEqual([...compoundStemsOf(w)], []);
  }
});

test('looksInflected catches inflected guesses', () => {
  const caught = ['churches', 'cities', 'knives', 'bigger', 'potatoes', 'mice',
    'trophies', 'judged', 'carried', 'happiest', 'leaves', 'boxes', 'stopped'];
  for (const w of caught) {
    assert.equal(looksInflected(w, isWord), true, `${w} should be seen as inflected`);
  }
});

test('looksInflected lets real base forms through — the direction that matters', () => {
  // A wrong rejection costs a player their round; a miss costs one odd-looking
  // guess. Measured over 174 base forms of the kind a word bank holds, this
  // rejects none of them. The list below is the part of that sweep most likely
  // to trip it: words that end in an inflection-shaped suffix without being
  // inflected.
  const lemmas = [
    'glass', 'bus', 'dance', 'press', 'chess', 'news', 'lens', 'boss', 'class',
    'cross', 'dress', 'grass', 'kiss', 'pass', 'loss', 'mess',
    'ring', 'king', 'thing', 'wing', 'spring', 'string', 'morning', 'evening',
    'building', 'meeting', 'ceiling',
    'water', 'paper', 'river', 'silver', 'winter', 'summer', 'finger',
    'garden', 'kitchen', 'oven', 'siren', 'linen',
    'bed', 'red', 'shed', 'thread', 'bread', 'need', 'seed', 'speed',
    'species', 'series', 'sheep', 'deer', 'fish',
  ];
  const rejected = lemmas.filter((w) => looksInflected(w, isWord));
  assert.deepEqual(rejected, [], `these are base forms and must be accepted: ${rejected}`);
});

test('a gerund slips through, and the reason is worth keeping', () => {
  // "running" and "making" are not caught, because "runnings" and "makings" are
  // in the dictionary — so the second test reads them as lemmas. That same
  // mechanism is what protects "morning", "evening", "building" and "meeting",
  // which ARE base forms. Dropping it would gain two catches and wrongly reject
  // four ordinary nouns, so the miss is deliberate.
  assert.equal(looksInflected('running', isWord), false);
  assert.equal(looksInflected('morning', isWord), false);
  assert.equal(isWord('runnings'), true, 'the reason for the miss');
});

test('looksInflected fails open when the dictionary is unavailable', () => {
  // An outage must never start refusing guesses.
  assert.equal(looksInflected('churches', () => null), false);
});

test('the English letter frequencies are a usable distribution', () => {
  const total = Object.values(LETTER_FREQUENCY).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 100) < 1, `frequencies should total ~100, got ${total}`);
  assert.equal(Object.keys(LETTER_FREQUENCY).length, 26, 'every English letter needs a figure');
  // e is the commonest letter in English and z among the rarest — if this table
  // were ever pasted from another language, this is what would catch it.
  assert.ok(LETTER_FREQUENCY.e > LETTER_FREQUENCY.t);
  assert.ok(LETTER_FREQUENCY.z < LETTER_FREQUENCY.q * 2);
  // An unlisted character must not be a free tiebreak win.
  assert.ok(UNLISTED_FREQUENCY > LETTER_FREQUENCY.z && UNLISTED_FREQUENCY < LETTER_FREQUENCY.e);
});
