import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSwedishWord, dictionarySize } from '../server/dictionary.js';
import { WORDS } from '../server/words.js';

// The dictionary replaces what used to be a second model call. It only ever
// judges the AI's guess — never the player's clue, where a dictionary
// requirement would ban the invented compounds the game is for.

test('the word list is loaded and large', () => {
  assert.ok(dictionarySize() > 100_000, `only ${dictionarySize()} words loaded`);
});

test('every target in the bank is a real word', () => {
  // If a target were missing, a correct-but-not-listed guess could be reported
  // as a confabulation. (Correct guesses skip the check, but a *different*
  // player's near-miss on the same word should still read as a legitimate miss.)
  const missing = WORDS.map((w) => w.word).filter((w) => isSwedishWord(w) !== true);
  assert.deepEqual(missing, [], `bank words missing from the dictionary: ${missing.join(', ')}`);
});

test('accepts ordinary Swedish words including å/ä/ö', () => {
  for (const w of ['morot', 'stövel', 'hjärta', 'ekorre', 'bibliotek', 'kaffe']) {
    assert.equal(isSwedishWord(w), true, `${w} should be found`);
  }
});

test('rejects confabulations of the kind the guesser produces', () => {
  for (const w of ['morotsnäsa', 'zxcvb', 'flurmig', 'blorpsel']) {
    assert.equal(isSwedishWord(w), false, `${w} should not be found`);
  }
});

test('lookup is case- and whitespace-insensitive', () => {
  assert.equal(isSwedishWord('  MOROT  '), true);
});

test('empty input is not a word', () => {
  assert.equal(isSwedishWord(''), false);
  assert.equal(isSwedishWord(null), false);
});

test('no bank entry contains a look-alike character from another alphabet', () => {
  // A Cyrillic "а" in "sagа" made that word unguessable: the AI answers with
  // the Latin spelling, the comparison fails, and a correct guess scores as
  // wrong. Invisible in review, so it needs a test.
  const suspects = [];
  for (const { word, forbidden } of WORDS) {
    for (const s of [word, ...forbidden]) {
      if ([...s].some((c) => c.charCodeAt(0) > 0x24f)) suspects.push(s);
    }
  }
  assert.deepEqual(suspects, [], `non-Latin characters found: ${suspects.join(', ')}`);
});
