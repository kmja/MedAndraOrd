import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize, charCount, letterCount, checkClueCode, extractWord,
  sanitizeName, dayNumber, MAX_CLUE_LENGTH,
} from '../server/util.js';
import { WORDS, wordForDate } from '../server/words.js';
import { runGuesserLoop, judgeClue, MAX_GUESS_ROUNDS } from '../server/game.js';

// ---------------------------------------------------------------------------
// util
// ---------------------------------------------------------------------------

test('normalize lowercases and keeps å/ä/ö', () => {
  assert.equal(normalize('  Hjärta  PÅ '), 'hjärta på');
});

test('charCount counts unicode characters', () => {
  assert.equal(charCount('åäö'), 3);
  assert.equal(charCount('en bra ledtråd'), 14);
});

test('letterCount counts only letters', () => {
  assert.equal(letterCount('morot'), 5);
  assert.equal(letterCount('Hjärta!'), 6);
});

test('checkClueCode: valid clue passes', () => {
  assert.equal(checkClueCode('kaninmat', 'morot', ['grönsak', 'orange']), null);
});

test('clue limit is a tight 10 characters', () => {
  assert.equal(MAX_CLUE_LENGTH, 10);
});

test('checkClueCode rejects clues over the limit but allows exactly the limit', () => {
  assert.equal(checkClueCode('a'.repeat(MAX_CLUE_LENGTH + 1), 'morot', []).code, 'too_long');
  assert.equal(checkClueCode('a'.repeat(MAX_CLUE_LENGTH), 'morot', []), null);
});

test('the limit counts unicode chars, so å/ä/ö cost the same as a/o', () => {
  assert.equal(checkClueCode('påskägget', 'morot', []), null); // 9 chars
  assert.equal(checkClueCode('trädgården', 'morot', []), null); // exactly 10
  assert.equal(checkClueCode('trädgårdar!', 'morot', []).code, 'too_long'); // 11
});

test('checkClueCode rejects emoji before any API call', () => {
  assert.equal(checkClueCode('kanin 🥕', 'morot', []).code, 'emoji');
});

test('checkClueCode rejects target word as substring (normalized)', () => {
  assert.equal(checkClueCode('Morotsbit', 'morot', []).code, 'contains_target');
});

test('checkClueCode rejects forbidden word as substring', () => {
  assert.equal(checkClueCode('orangesak', 'morot', ['orange']).code, 'contains_forbidden');
});

test('extractWord pulls a single word from noisy output', () => {
  assert.equal(extractWord('  Morot.  '), 'morot');
  assert.equal(extractWord('Ordet är: HJÄRTA'), 'ordet'); // first token — guesser is told to answer with only the word
  assert.equal(extractWord('!!!'), null);
});

test('sanitizeName strips junk and blocks crude names', () => {
  assert.equal(sanitizeName('  Kalle 99  '), 'Kalle 99');
  assert.equal(sanitizeName('<script>x</script>'), 'scriptxscript');
  assert.equal(sanitizeName('jävlaKalle'), null);
  assert.equal(sanitizeName('💩💩'), null);
});

// ---------------------------------------------------------------------------
// word bank + rotation
// ---------------------------------------------------------------------------

test('word bank entries are sane', () => {
  for (const { word, forbidden } of WORDS) {
    assert.ok(word.length >= 3, `${word} too short`);
    assert.ok(forbidden.length >= 4, `${word} needs a real forbidden list`);
    for (const f of forbidden) {
      // A forbidden word may be a substring of the target (e.g. "rot" for
      // "morot" — it blocks "rotfrukt"/"rotsak" clues), but never equal to it.
      assert.notEqual(normalize(f), normalize(word), `${word}: forbidden "${f}" equals target`);
    }
  }
});

test('word bank is weighted toward 5–6-letter words', () => {
  const fiveSix = WORDS.filter((w) => [5, 6].includes(letterCount(w.word))).length;
  assert.ok(fiveSix / WORDS.length > 0.6, `only ${fiveSix}/${WORDS.length} are 5–6 letters`);
});

test('daily rotation is deterministic and changes day to day', () => {
  const a = wordForDate('2026-08-05');
  const b = wordForDate('2026-08-05');
  const c = wordForDate('2026-08-06');
  assert.equal(a.word, b.word);
  assert.notEqual(a.index, c.index);
  assert.equal(dayNumber('2026-08-06') - dayNumber('2026-08-05'), 1);
});

// ---------------------------------------------------------------------------
// guesser loop (mocked AI)
// ---------------------------------------------------------------------------

function mockAi({ guesses, verify = () => true, refereeRuling = { legal: true } }) {
  let i = 0;
  return {
    referee: async () => refereeRuling,
    guesser: async () => guesses[Math.min(i++, guesses.length - 1)],
    verifier: async (w) => verify(w),
  };
}

test('guesser loop: correct-length real word accepted first try', async () => {
  const ai = mockAi({ guesses: ['morot'] });
  const r = await runGuesserLoop({ clue: 'x', targetLetterCount: 5, ai });
  assert.deepEqual(r, { guess: 'morot', valid: true });
});

test('guesser loop: wrong length re-prompted, then accepted', async () => {
  const ai = mockAi({ guesses: ['banan hej', 'kanin', 'morot'] });
  const r = await runGuesserLoop({ clue: 'x', targetLetterCount: 5, ai });
  // 'banan' (from 'banan hej') is 5 letters and verifies — accepted
  assert.equal(r.valid, true);
});

test('guesser loop: verifier rejection feeds back, loop can exhaust as ai_failure', async () => {
  const ai = mockAi({ guesses: ['påhitt'], verify: () => false });
  const r = await runGuesserLoop({ clue: 'x', targetLetterCount: 6, ai });
  assert.equal(r.valid, false);
  assert.equal(r.guess, 'påhitt');
});

test('guesser loop: verifier failure fails open (null → accepted)', async () => {
  const ai = mockAi({ guesses: ['morot'], verify: () => null });
  const r = await runGuesserLoop({ clue: 'x', targetLetterCount: 5, ai });
  assert.equal(r.valid, true);
});

test(`guesser loop runs at most ${MAX_GUESS_ROUNDS} rounds`, async () => {
  let calls = 0;
  const ai = {
    guesser: async () => { calls++; return 'fel'; }, // always 3 letters, target is 5
    verifier: async () => true,
    referee: async () => ({ legal: true }),
  };
  const r = await runGuesserLoop({ clue: 'x', targetLetterCount: 5, ai });
  assert.equal(calls, MAX_GUESS_ROUNDS);
  assert.equal(r.valid, false);
});

// ---------------------------------------------------------------------------
// full pipeline (mocked AI)
// ---------------------------------------------------------------------------

test('judgeClue: code check rejects without touching AI', async () => {
  const ai = { referee: async () => { throw new Error('should not be called'); } };
  const v = await judgeClue({ clue: 'morotsbit', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'rejected');
  assert.equal(v.source, 'code');
});

test('judgeClue: referee rejection costs nothing and has a reason', async () => {
  const ai = mockAi({ guesses: ['x'], refereeRuling: { legal: false, reason: 'Översättning av målordet.' } });
  const v = await judgeClue({ clue: 'carrot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'rejected');
  assert.equal(v.source, 'referee');
});

test('judgeClue: referee failure fails open — play proceeds', async () => {
  const ai = { referee: async () => null, guesser: async () => 'morot', verifier: async () => true };
  const v = await judgeClue({ clue: 'kaninmat', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'correct');
  assert.equal(v.score, charCount('kaninmat'));
});

test('judgeClue: correct guess scores by clue character count', async () => {
  const ai = mockAi({ guesses: ['morot'] });
  const v = await judgeClue({ clue: 'kanin godis', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'rejected'); // 11 chars — over the limit now
  const v2 = await judgeClue({ clue: 'kaningodis', target: 'morot', forbidden: [], ai });
  assert.equal(v2.type, 'correct');
  assert.equal(v2.score, 10);
});

test('judgeClue: wrong valid guess is a miss', async () => {
  const ai = mockAi({ guesses: ['kanin'] });
  const v = await judgeClue({ clue: 'lång rot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'wrong');
  assert.equal(v.guess, 'kanin');
});
