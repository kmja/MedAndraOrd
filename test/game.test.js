import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize, charCount, clueLength, letterCount, checkClueCode, extractWord,
  sanitizeName, dayNumber, MAX_CLUE_LENGTH,
} from '../server/util.js';
import { WORDS, wordForDate, wordByIndex, randomWord } from '../server/words.js';
import {
  runGuesserLoop, judgeClue, costsAttempt, isCacheableVerdict, MAX_GUESS_ROUNDS,
} from '../server/game.js';

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

test('clueLength ignores whitespace — spacing is free', () => {
  assert.equal(clueLength('kaninmat'), 8);
  assert.equal(clueLength('kanin mat'), 8, 'a space must not cost a point');
  assert.equal(clueLength('  kanin   mat  '), 8);
  assert.equal(clueLength('kanin\tmat'), 8, 'tabs count as whitespace too');
  assert.equal(clueLength('åäö'), 3);
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

test('rotation visits every word before repeating any', () => {
  // Requires the stride to be coprime with the bank size; if it isn't, the
  // rotation silently cycles through a fraction of the bank forever.
  const seen = new Set();
  const start = dayNumber('2026-01-01');
  for (let i = 0; i < WORDS.length; i++) {
    const d = new Date(Date.UTC(1970, 0, 1) + (start + i) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    seen.add(wordForDate(d).index);
  }
  assert.equal(seen.size, WORDS.length, 'rotation does not cover the whole bank');
});

test('consecutive days are far apart in the bank (themes do not clump)', () => {
  const a = wordForDate('2026-08-05').index;
  const b = wordForDate('2026-08-06').index;
  assert.ok(Math.abs(a - b) > 5, `neighbouring days landed at ${a} and ${b}`);
});

test('randomWord never returns the excluded (live) word', () => {
  const todayIndex = wordForDate('2026-08-05').index;
  for (let i = 0; i < 300; i++) {
    assert.notEqual(randomWord(todayIndex).index, todayIndex);
  }
});

test('wordByIndex rejects out-of-range indexes from the client', () => {
  assert.equal(wordByIndex(-1), null);
  assert.equal(wordByIndex(WORDS.length), null);
  assert.equal(wordByIndex(NaN), null);
  assert.ok(wordByIndex(0).word);
});

// ---------------------------------------------------------------------------
// guesser loop (mocked AI)
// ---------------------------------------------------------------------------

function mockAi({ guesses, refereeRuling = { legal: true } }) {
  let i = 0;
  const calls = { guarded: 0 };
  return {
    calls,
    guardedGuesser: async () => {
      calls.guarded++;
      if (refereeRuling.legal === false) {
        return { legal: false, reason: refereeRuling.reason };
      }
      return { legal: true, guess: guesses[Math.min(i++, guesses.length - 1)] };
    },
  };
}

test('guesser loop: correct-length real word accepted first try', async () => {
  const ai = mockAi({ guesses: ['morot'] });
  const r = await runGuesserLoop({ clue: 'x', target: 'morot', targetLetterCount: 5, ai });
  assert.deepEqual(r, { type: 'correct', guess: 'morot' });
});

test('a successful submission costs exactly one model call', async () => {
  // The whole point of folding the clue-only rules into the guesser's prompt.
  // A correct guess needs no verification either — the target is a real word
  // by construction.
  const ai = mockAi({ guesses: ['morot'] });
  const v = await judgeClue({ clue: 'kaninmat', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'correct');
  assert.equal(ai.calls.guarded, 1);
});

test('a wrong guess also costs exactly one call', async () => {
  // The dictionary settles "is this a real word" in code, so a legitimate
  // miss needs no second request.
  const ai = mockAi({ guesses: ['kanin'] });
  const v = await judgeClue({ clue: 'lång rot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'wrong');
  assert.equal(ai.calls.guarded, 1);
});

test('a confabulated guess is re-prompted until the AI complies', async () => {
  // The player wrote a legal clue; the AI broke its own rules. Re-prompt.
  const ai = mockAi({ guesses: ['zxcvb', 'qwrtp', 'kanin'] });
  const v = await judgeClue({ clue: 'lång rot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'wrong', 'should land on the first real word it produces');
  assert.equal(v.guess, 'kanin');
  assert.equal(ai.calls.guarded, 3);
});

test('an AI that never complies ends as ai_failure, not as a miss', async () => {
  const ai = mockAi({ guesses: ['zxcvb'] });
  const v = await judgeClue({ clue: 'lång rot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'ai_failure');
  assert.equal(ai.calls.guarded, MAX_GUESS_ROUNDS);
});

// ---------------------------------------------------------------------------
// fairness: the player is never charged for the AI misbehaving
// ---------------------------------------------------------------------------

test('only outcomes the player is responsible for cost an attempt', () => {
  assert.equal(costsAttempt({ type: 'correct' }), true);
  assert.equal(costsAttempt({ type: 'wrong' }), true);
  assert.equal(costsAttempt({ type: 'rejected' }), false, 'never reached the guesser');
  assert.equal(costsAttempt({ type: 'ai_failure' }), false, 'the AI failed, not the player');
  assert.equal(costsAttempt(null), false);
});

test('AI failures are not cached as the day\'s ruling', () => {
  // Caching one would freeze the clue as permanently failed, so resubmitting
  // could never get a fresh attempt at a real guess.
  assert.equal(isCacheableVerdict({ type: 'ai_failure' }), false);
  assert.equal(isCacheableVerdict({ type: 'rejected' }), true);
  assert.equal(isCacheableVerdict({ type: 'correct' }), true);
  assert.equal(isCacheableVerdict({ type: 'wrong' }), true);
});

test('an illegal clue costs one call and no more', async () => {
  const ai = mockAi({ guesses: ['morot'], refereeRuling: { legal: false, reason: 'Engelska.' } });
  const v = await judgeClue({ clue: 'carrot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'rejected');
  assert.equal(v.source, 'referee');
  assert.equal(ai.calls.guarded, 1);
});

test('the guess prompt never receives the target or forbidden words', async () => {
  // Blindness is the game's integrity guarantee: folding the rule check into
  // the guessing call must not smuggle the answer into its context.
  let seen = null;
  const ai = {
    guardedGuesser: async (args) => { seen = args; return { legal: true, guess: 'morot' }; },
  };
  await judgeClue({ clue: 'kaninmat', target: 'morot', forbidden: ['grönsak', 'orange'], ai });
  assert.deepEqual(Object.keys(seen).sort(), ['clue', 'feedback', 'letterCount']);
  const serialised = JSON.stringify(seen);
  assert.ok(!serialised.includes('morot'), 'target leaked into the guesser call');
  assert.ok(!serialised.includes('grönsak'), 'forbidden word leaked into the guesser call');
  assert.equal(seen.letterCount, 5);
});

test('guesser loop: wrong length re-prompted, then accepted', async () => {
  const ai = mockAi({ guesses: ['banan hej', 'kanin', 'morot'] });
  const r = await runGuesserLoop({ clue: 'x', target: 'morot', targetLetterCount: 5, ai });
  // 'banan' (from 'banan hej') is 5 letters and is a real word — a legit miss
  assert.equal(r.type, 'wrong');
});

test('guesser loop: a non-word is re-prompted, then accepted', async () => {
  const ai = mockAi({ guesses: ['zxcvbn', 'stegen'] });
  const r = await runGuesserLoop({ clue: 'x', target: 'stövel', targetLetterCount: 6, ai });
  assert.equal(r.type, 'wrong');
  assert.equal(r.guess, 'stegen');
  assert.equal(ai.calls.guarded, 2);
});

test(`guesser loop runs at most ${MAX_GUESS_ROUNDS} rounds`, async () => {
  let calls = 0;
  const ai = {
    guardedGuesser: async () => { calls++; return { legal: true, guess: 'fel' }; }, // 3 letters, target is 5
  };
  const r = await runGuesserLoop({ clue: 'x', target: 'morot', targetLetterCount: 5, ai });
  assert.equal(calls, MAX_GUESS_ROUNDS);
  assert.equal(r.type, 'ai_failure');
});

// ---------------------------------------------------------------------------
// full pipeline (mocked AI)
// ---------------------------------------------------------------------------

test('judgeClue: code check rejects without touching AI', async () => {
  const ai = { guardedGuesser: async () => { throw new Error('should not be called'); } };
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

test('judgeClue: an unusable first answer with nothing to show is unplayable', async () => {
  // Fail-open applies to the rule check, but a guess cannot be invented.
  const ai = { guardedGuesser: async () => null };
  await assert.rejects(
    () => judgeClue({ clue: 'kaninmat', target: 'morot', forbidden: [], ai }),
    (e) => e.name === 'AiUnavailableError',
  );
});

test('judgeClue: score counts non-whitespace characters only', async () => {
  const ai = mockAi({ guesses: ['morot'] });
  // 11 characters, 10 of them non-whitespace: rejected under the old rule,
  // legal now, and the space costs nothing.
  const v = await judgeClue({ clue: 'kanin godis', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'correct');
  assert.equal(v.score, 10);

  const v2 = await judgeClue({ clue: 'kaningodis', target: 'morot', forbidden: [], ai });
  assert.equal(v2.type, 'correct');
  assert.equal(v2.score, 10, 'same letters, same score, with or without the space');
});

test('judgeClue: wrong valid guess is a miss', async () => {
  const ai = mockAi({ guesses: ['kanin'] });
  const v = await judgeClue({ clue: 'lång rot', target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'wrong');
  assert.equal(v.guess, 'kanin');
});
