import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalize, charCount, clueLength, letterCount, checkClueCode, extractWord,
  dayNumber, MAX_CLUE_LENGTH, CLUE_LIMIT_FLOOR, CLUE_LIMIT_CEILING, inflectionsOf,
  clueLimitFor, suggestedLimit, compoundStemsOf, looksInflected,
  letterRarity, whitespaceCount, compareClues, LETTER_FREQUENCY,
} from '../server/util.js';
import { WORDS, wordForDate, wordByIndex, randomWord } from '../server/words.js';
import { ROTATION, ROTATION_EPOCH } from '../server/rotation.js';
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

test('the default limit sits inside the per-word bounds', () => {
  // Every unprobed word gets MAX_CLUE_LENGTH, so it has to be a value the
  // per-word machinery would also accept — otherwise probing a word could
  // move its limit somewhere the default never could.
  assert.ok(MAX_CLUE_LENGTH >= CLUE_LIMIT_FLOOR && MAX_CLUE_LENGTH <= CLUE_LIMIT_CEILING);
});

test('clueLimitFor falls back to the default and clamps anything odd', () => {
  assert.equal(clueLimitFor(undefined), MAX_CLUE_LENGTH);
  assert.equal(clueLimitFor({}), MAX_CLUE_LENGTH, 'an unprobed word uses the default');
  assert.equal(clueLimitFor({ limit: 12 }), 12);
  // A limit is derived from measurements, and measurements go wrong. Bounds
  // mean a bad number produces a tight or generous word, never an unplayable
  // one.
  assert.equal(clueLimitFor({ limit: 1 }), CLUE_LIMIT_FLOOR);
  assert.equal(clueLimitFor({ limit: 999 }), CLUE_LIMIT_CEILING);
  for (const bad of [null, '12', 12.5, NaN]) {
    assert.equal(clueLimitFor({ limit: bad }), MAX_CLUE_LENGTH, `expected fallback for ${bad}`);
  }
});

test('suggestedLimit leaves room above the shortest solve', () => {
  // With one or two solves the mean is nearly the shortest solve, and a limit
  // landing on top of it would leave no room to solve the word any other way.
  assert.equal(suggestedLimit([15]), 19, 'a single solve still gets headroom');
  assert.equal(suggestedLimit([5, 6]), 9);
  // With a spread, the mean does the work and an outlier does not drag it up.
  assert.equal(suggestedLimit([5, 6, 7, 20]), 11);
  assert.equal(suggestedLimit([14, 16, 18]), 19);
});

test('suggestedLimit returns null when nothing solved the word', () => {
  // No solve means no evidence. Inventing a limit from an empty sample would
  // be worse than leaving the word on the default.
  assert.equal(suggestedLimit([]), null);
  assert.equal(suggestedLimit(undefined), null);
  assert.equal(suggestedLimit([0, NaN, -3]), null);
});

test('suggestedLimit stays inside the bounds', () => {
  assert.equal(suggestedLimit([2]), CLUE_LIMIT_FLOOR);
  assert.equal(suggestedLimit([23, 24]), CLUE_LIMIT_CEILING);
});

test('checkClueCode rejects clues over the limit but allows exactly the limit', () => {
  assert.equal(checkClueCode('a'.repeat(MAX_CLUE_LENGTH + 1), 'morot', []).code, 'too_long');
  assert.equal(checkClueCode('a'.repeat(MAX_CLUE_LENGTH), 'morot', []), null);
});

test('checkClueCode honours a per-word limit and says which one applied', () => {
  // The reason is shown to the player, so it has to quote the limit that was
  // actually enforced — a message naming the global default under a tighter
  // word would read as a bug.
  const verdict = checkClueCode('a'.repeat(11), 'morot', [], 10);
  assert.equal(verdict.code, 'too_long');
  assert.match(verdict.reason, /högst 10 tecken/);
  assert.equal(checkClueCode('a'.repeat(10), 'morot', [], 10), null);
  // A looser word accepts what the default would have refused.
  assert.equal(checkClueCode('a'.repeat(MAX_CLUE_LENGTH + 2), 'morot', [], 22), null);
});

test('the limit counts unicode chars, so å/ä/ö cost the same as a/o', () => {
  const atCap = 'å'.repeat(MAX_CLUE_LENGTH);
  assert.equal(checkClueCode(atCap, 'morot', []), null);
  assert.equal(checkClueCode(atCap + 'å', 'morot', []).code, 'too_long');
});

test('a long clue is legal — it just scores worse', async () => {
  // The limit is a backstop, not a difficulty gate. Anything under it counts
  // in full and simply lands further down the board.
  const ai = mockAi({ guesses: ['morot'] });
  const long = 'a'.repeat(MAX_CLUE_LENGTH - 1);
  const v = await judgeClue({ clue: long, target: 'morot', forbidden: [], ai });
  assert.equal(v.type, 'correct');
  assert.equal(v.score, MAX_CLUE_LENGTH - 1);
});

test('judgeClue enforces the per-word limit it is given', async () => {
  // The limit travels with the call, so a tight word must refuse a clue that
  // a default word would accept — and refuse it in code, before paying for a
  // model call.
  let called = false;
  const ai = { guardedGuesser: async () => { called = true; return { legal: true, guess: 'morot' }; } };
  const v = await judgeClue({ clue: 'a'.repeat(12), target: 'morot', forbidden: [], maxLength: 10, ai });
  assert.equal(v.type, 'rejected');
  assert.equal(v.source, 'code');
  assert.equal(called, false, 'a too-long clue must never reach the model');
});

test('a blank reply is retried, not written off', async () => {
  // A legal clue plus a misbehaving model is not the player's fault. One
  // unusable reply used to end the round immediately, which came back so fast
  // it looked like nothing had been retried at all.
  let calls = 0;
  const recovers = {
    guardedGuesser: async () => {
      calls++;
      if (calls === 1) return { legal: true, guess: 'eldstad' }; // wrong length
      if (calls === 2) return null;                              // unusable
      return { legal: true, guess: 'fabrik' };
    },
  };
  const v = await runGuesserLoop({ clue: 'hus varv rök', target: 'fabrik', targetLetterCount: 6, ai: recovers });
  assert.equal(v.type, 'correct');
  assert.equal(calls, 3);
});

test('repeated blanks still give up, so a dead API does not burn the budget', async () => {
  // null also covers "the call failed". A player is waiting, so this must not
  // spend every round retrying something that is not coming back.
  let calls = 0;
  const dead = {
    guardedGuesser: async () => { calls++; return calls === 1 ? { legal: true, guess: 'eldstad' } : null; },
  };
  const v = await runGuesserLoop({ clue: 'x', target: 'fabrik', targetLetterCount: 6, ai: dead });
  assert.equal(v.type, 'ai_failure');
  assert.equal(v.guess, 'eldstad');
  assert.ok(calls <= 3, `expected an early stop, got ${calls} calls`);
});

test('a guesser that keeps offering new wrong words uses the whole round budget', async () => {
  // The visible symptom of the bug this pins was "that came back too fast", so
  // the number of attempts is worth holding down. Each guess differs, so every
  // round has something new to tell the model and all four are worth spending.
  let calls = 0;
  const varied = ['eldstadar', 'ugnshuset', 'skorstens', 'rokugnen'];
  const ai = { guardedGuesser: async () => ({ legal: true, guess: varied[calls++] }) };
  const v = await runGuesserLoop({ clue: 'x', target: 'fabrik', targetLetterCount: 6, ai });
  assert.equal(v.type, 'ai_failure');
  assert.equal(calls, MAX_GUESS_ROUNDS);
});

test('a guesser stuck on one word is stopped early, not asked four times', async () => {
  // Repeating a ruled-out guess leaves the feedback unchanged, so the next
  // round would send a byte-identical prompt at the same temperature. Asking
  // again cannot produce anything new — it only makes the player wait.
  let calls = 0;
  const stubborn = { guardedGuesser: async () => { calls++; return { legal: true, guess: 'eldstad' }; } };
  const v = await runGuesserLoop({ clue: 'x', target: 'fabrik', targetLetterCount: 6, ai: stubborn });
  assert.equal(v.type, 'ai_failure');
  assert.equal(v.guess, 'eldstad', 'the player still sees what it kept saying');
  assert.equal(calls, 2, 'one round to learn the word, one to see it repeated');
  assert.equal(v.trace.at(-1).event, 'stuck', 'and the trace has to say why it stopped');
});

test('checkClueCode rejects inflections the substring test cannot see', () => {
  // The rules always said inflections were out, but the check was a substring
  // test — and "stövlar" is not a substring of "stövel", because the e drops.
  // "Puss i stövlar" solved the word on the live site because of this.
  assert.equal(checkClueCode('Puss i stövlar', 'stövel', []).code, 'contains_inflection');
  assert.equal(checkClueCode('stövlarna', 'stövel', []).code, 'contains_inflection');
  assert.equal(checkClueCode('ridstövlar', 'stövel', []).code, 'contains_inflection');
  // Other stem changes, same idea.
  assert.equal(checkClueCode('nycklar', 'nyckel', []).code, 'contains_inflection');
  assert.equal(checkClueCode('blommor', 'blomma', []).code, 'contains_inflection');
  assert.equal(checkClueCode('vantar', 'vante', []).code, 'contains_inflection');
  // When the stem does NOT change, the plain substring check catches it first
  // and says so more directly — either message is a rejection, which is what
  // matters.
  assert.equal(checkClueCode('hundens', 'hund', []).code, 'contains_target');
});

test('checkClueCode still allows clues that merely describe the word', () => {
  // The inflection rule must not become a blunt prefix ban — these are exactly
  // the clues the game is for, and they came from a real probe run.
  for (const clue of ['läder till knä', 'ryttarens val', 'långt skaft', 'vintermode för ben']) {
    assert.equal(checkClueCode(clue, 'stövel', []), null, `${clue} should be allowed`);
  }
});

test('inflectionsOf never contains the word itself', () => {
  // The base form is caught by the substring check with its own message. If it
  // appeared here too, the player would get "innehåller en böjning" for a clue
  // that is simply the word.
  for (const w of ['stövel', 'blomma', 'vante', 'hund']) {
    assert.ok(!inflectionsOf(w).has(w), `${w} should not be its own inflection`);
  }
});

test('checkClueCode rejects a fill-in-the-blank fragment', () => {
  // "skit…" doesn't describe a boot; it asks the model to complete
  // "skitstövel". Only the explicit signal is caught in code — see the prompt
  // for the judgment half.
  for (const clue of ['skit...', 'skit…', 'skit-', '-stövelaktig', 'arbets..']) {
    assert.equal(checkClueCode(clue, 'stövel', []).code, 'fragment', `${clue} should be a fragment`);
  }
});

test('the fragment rule does not catch ordinary clues', () => {
  // Swedish compounds that *describe* must stay legal — that is most of the
  // good clues in the game.
  for (const clue of ['vadplagg', 'kanin mat', 'går i lera', '1-2 saker']) {
    assert.equal(checkClueCode(clue, 'stövel', []), null, `${clue} should pass`);
  }
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

// ---------------------------------------------------------------------------
// tiebreakers
// ---------------------------------------------------------------------------

test('letterRarity sums Swedish letter frequencies — lower is rarer', () => {
  assert.equal(letterRarity('a'), LETTER_FREQUENCY.a);
  assert.ok(letterRarity('qzx') < letterRarity('ate'), 'rare letters must total less');
  assert.equal(letterRarity('AE'), letterRarity('ae'), 'case must not matter');
  assert.equal(letterRarity('a e'), letterRarity('ae'), 'spaces are not letters');
  assert.equal(letterRarity(''), 0);
});

test('an unlisted letter is not a free tiebreak win', () => {
  // Reaching for é must not beat q, or the rule becomes "type something odd".
  assert.ok(letterRarity('é') > letterRarity('q'));
});

test('whitespaceCount counts every kind of space', () => {
  assert.equal(whitespaceCount('kanin mat'), 1);
  assert.equal(whitespaceCount('a\tb\nc'), 2);
  assert.equal(whitespaceCount('kaninmat'), 0);
});

test('compareClues applies the tiebreakers in order', () => {
  // 1. length beats everything
  assert.ok(compareClues('qzx', 'aaaa') < 0);
  // 2. then fewer spaces
  assert.ok(compareClues('abcd', 'ab cd') < 0);
  // 3. then rarer letters
  assert.ok(compareClues('xkvj', 'ades') < 0);
  // 4. identical clues tie
  assert.equal(compareClues('kaninmat', 'KANINMAT'), 0);
});

test('compareClues is a consistent ordering', () => {
  const clues = ['ades', 'xkvj', 'ab cd', 'abcd', 'qzwx', 'a', 'zz'];
  const once = clues.slice().sort(compareClues);
  const twice = clues.slice().reverse().sort(compareClues);
  assert.deepEqual(once, twice, 'sorting must not depend on input order');
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
  // Requires ROTATION to be a permutation of the bank. If a word were missing
  // or duplicated, the schedule would silently cycle through a fraction of the
  // bank forever while looking fine day to day.
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

test('the schedule is a permutation of the bank', () => {
  assert.equal(ROTATION.length, WORDS.length, 'every word needs exactly one slot');
  assert.equal(new Set(ROTATION).size, ROTATION.length, 'a word is scheduled twice');
  for (const i of ROTATION) {
    assert.ok(Number.isInteger(i) && i >= 0 && i < WORDS.length, `bad index ${i}`);
  }
});

test('appending words cannot move a day that is already scheduled', () => {
  // This is the whole reason the schedule is written down instead of computed.
  // The old rule was (dayNumber * STRIDE) % WORDS.length, so growing the bank
  // changed the modulus and rewrote the calendar — today included, mid-play.
  const start = dayNumber('2026-08-05');
  const before = [];
  for (let i = 0; i < 30; i++) before.push(ROTATION[(start + i - ROTATION_EPOCH) % ROTATION.length]);

  // Simulate the append: 40 more words on the end of the schedule.
  const grown = [...ROTATION, ...Array.from({ length: 40 }, (_, i) => WORDS.length + i)];
  const after = [];
  for (let i = 0; i < 30; i++) after.push(grown[(start + i - ROTATION_EPOCH) % grown.length]);

  assert.deepEqual(after, before, 'a scheduled day moved when the bank grew');
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
  assert.deepEqual(r, { type: 'correct', guess: 'morot', why: null });
});

test('the guesser reasoning is carried through to the verdict', async () => {
  // Shown to the player after the reveal, so it has to survive the whole
  // pipeline — and survive its own absence, since a model that omits it must
  // still produce a playable round.
  const withWhy = {
    guardedGuesser: async () => ({ legal: true, guess: 'morot', why: 'Kaninmat pekar mot en rotfrukt.' }),
  };
  const v = await judgeClue({ clue: 'kaninmat', target: 'morot', forbidden: [], ai: withWhy });
  assert.equal(v.type, 'correct');
  assert.equal(v.why, 'Kaninmat pekar mot en rotfrukt.');

  // A wrong guess explains itself too — that is the case where knowing how it
  // read the clue is worth most.
  const missed = {
    guardedGuesser: async () => ({ legal: true, guess: 'banan', why: 'Jag läste det som en gul frukt.' }),
  };
  const w = await judgeClue({ clue: 'gul', target: 'morot', forbidden: [], ai: missed });
  assert.equal(w.type, 'wrong');
  assert.equal(w.why, 'Jag läste det som en gul frukt.');

  const without = { guardedGuesser: async () => ({ legal: true, guess: 'morot' }) };
  const bare = await judgeClue({ clue: 'x', target: 'morot', forbidden: [], ai: without });
  assert.equal(bare.type, 'correct', 'a missing explanation must not fail the round');
  assert.equal(bare.why, null);
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
  // Four different non-words: it never complies, and every round is still
  // worth asking because each reply is new information.
  const ai = mockAi({ guesses: ['zxcvb', 'qwrtp', 'fjkld', 'mnbvc'] });
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
  // The exact key set is pinned on purpose: a new field is the obvious way the
  // answer would eventually get smuggled in, so adding one has to be a
  // deliberate edit here.
  assert.deepEqual(Object.keys(seen).sort(), ['clue', 'feedback', 'letterCount', 'wordClass']);
  const serialised = JSON.stringify(seen);
  assert.ok(!serialised.includes('morot'), 'target leaked into the guesser call');
  assert.ok(!serialised.includes('grönsak'), 'forbidden word leaked into the guesser call');
  assert.equal(seen.letterCount, 5);
});

test('the word class passed to the guesser is a class, never the word', async () => {
  // wordClass is the one field that comes straight off the bank entry, so it
  // is the one that could carry the answer if a bank row were mistyped. Only
  // these two values ever reach the model; nouns send nothing.
  let seen = null;
  const ai = { guardedGuesser: async (a) => { seen = a; return { legal: true, guess: 'springa' }; } };

  await judgeClue({ clue: 'x', target: 'springa', forbidden: [], wordClass: 'verb', ai });
  assert.equal(seen.wordClass, 'verb');

  // Only these three ever reach the model or the screen. The bank writes down
  // the unusual two; wordByIndex fills in the third.
  const ALLOWED = new Set(['substantiv', 'verb', 'adjektiv']);
  for (const { word, class: cls } of WORDS) {
    assert.ok(cls === undefined || ALLOWED.has(cls), `${word} has an unexpected class: ${cls}`);
  }
  for (let i = 0; i < WORDS.length; i++) {
    const entry = wordByIndex(i);
    assert.ok(ALLOWED.has(entry.class), `${entry.word} resolved to a bad class: ${entry.class}`);
  }
});

test('an unlabelled bank entry resolves to substantiv', () => {
  // Defaulted once, in wordByIndex, so the player, the prompt and the tests
  // cannot disagree about what an unlabelled entry is.
  const noun = wordByIndex(WORDS.findIndex((w) => !w.class));
  assert.equal(noun.class, 'substantiv');
  assert.equal(wordByIndex(WORDS.findIndex((w) => w.class === 'verb')).class, 'verb');
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
  // A new wrong word every time, so nothing stops it early — this is the
  // ceiling, and a player waits through every one of these.
  let calls = 0;
  const wrong = ['fel', 'fela', 'felar', 'felad', 'felat', 'felade'];
  const ai = {
    guardedGuesser: async () => ({ legal: true, guess: wrong[calls++] }), // never 5 letters
  };
  const r = await runGuesserLoop({ clue: 'x', target: 'morot', targetLetterCount: 5, ai });
  assert.equal(calls, MAX_GUESS_ROUNDS);
  assert.equal(r.type, 'ai_failure');
});

test('a round offering several candidates settles on the first usable one', async () => {
  // The retry asks for three alternatives at once. Walking them in order is
  // what lets one stuck answer stop costing a whole round.
  const ai = {
    guardedGuesser: async () => ({
      legal: true,
      candidates: [
        { guess: 'zzz', why: 'too short' },        // wrong length
        { guess: 'zxcvb', why: 'not a word' },     // not Swedish
        { guess: 'stegen', why: 'this one' },      // real, right length
      ],
    }),
  };
  const r = await runGuesserLoop({ clue: 'x', target: 'stövel', targetLetterCount: 6, ai });
  assert.equal(r.type, 'wrong');
  assert.equal(r.guess, 'stegen');
  assert.equal(r.why, 'this one', 'the reasoning must follow the candidate that won');
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

// ---------------------------------------------------------------------------
// Compounds built on the target, and guesses that are not base forms.

test('a compound built on the target is refused', () => {
  // inflectionsOf only adds endings, so it cannot see this: Swedish drops the
  // final -a before the second element, and "kyrk" is neither the word nor an
  // inflection of it. "kyrkklocka" and "kyrkogård" both got through.
  for (const clue of ['kyrkklocka', 'kyrkogård', 'kyrkbänk', 'kyrko gård']) {
    const v = checkClueCode(clue, 'kyrka', []);
    assert.equal(v?.code, 'contains_compound', `${clue} should be refused`);
  }
  // The other position is already covered by the plain substring test.
  assert.equal(checkClueCode('domkyrka', 'kyrka', [])?.code, 'contains_target');
});

test('the compound stem never gets short enough to swallow ordinary words', () => {
  // "vara" would yield "var", and then "varm" reads as containing the secret
  // word. Four letters is the floor.
  assert.deepEqual([...compoundStemsOf('vara')], []);
  assert.deepEqual([...compoundStemsOf('gata')], []);
  assert.deepEqual([...compoundStemsOf('kyrka')], ['kyrk']);
  assert.deepEqual([...compoundStemsOf('vante')], ['vant']);
  assert.equal(checkClueCode('varm dryck', 'vara', []), null);
});

test('no bank word is refused as a compound of itself', () => {
  // The stem test runs against every target, so a stem that matched its own
  // word bank would make legal clues impossible for that word.
  for (const { word } of WORDS) {
    for (const stem of compoundStemsOf(word)) {
      assert.ok(stem.length >= 4, `${word}: stem "${stem}" is too short to anchor on`);
    }
  }
});

test('an inflected form is not accepted as a guess', async () => {
  // The dictionary lists word FORMS, so "gravs" — a real genitive — passed the
  // "is this Swedish" check and went on screen as the AI's guess.
  const seen = [];
  const ai = {
    guardedGuesser: async ({ feedback }) => {
      seen.push(feedback.at(-1)?.problem ?? null);
      return feedback.length === 0
        ? { legal: true, guess: 'gravs' }
        : { legal: true, guess: 'kista' };
    },
  };
  const v = await judgeClue({ clue: 'vilorum', target: 'kyrka', forbidden: [], maxLength: 18, ai });
  assert.equal(v.type, 'wrong');
  assert.equal(v.guess, 'kista', 'the inflected guess should have been sent back');
  assert.deepEqual(seen, [null, 'not_base']);
});

test('base forms that merely look inflected are still accepted', async () => {
  // Stripping an ending and finding a word underneath is not enough on its
  // own: "glass" strips to "glas", "buss" to "bus", "dans" to "dan". All three
  // are ordinary base forms and must survive as guesses.
  for (const guess of ['glass', 'buss', 'dans', 'puls', 'kalas', 'krans', 'slips']) {
    const ai = { guardedGuesser: async () => ({ legal: true, guess }) };
    const v = await judgeClue({
      clue: 'ledtråd', target: 'xxxxx'.slice(0, guess.length), forbidden: [], maxLength: 18, ai,
    });
    assert.equal(v.type, 'wrong', `${guess} should have been accepted as a guess`);
    assert.equal(v.guess, guess);
  }
});

test('the attempt cap reads from the environment, and bad values do not lock the game', async () => {
  const { attemptCapFrom } = await import('../server/game.js');
  // Unset means uncapped — the current playtest setting.
  assert.equal(attemptCapFrom(undefined), Infinity);
  assert.equal(attemptCapFrom(''), Infinity);
  assert.equal(attemptCapFrom('5'), 5);
  // Anything malformed must fall back to uncapped rather than to a small
  // number: "0", "abc" or "-1" read as a cap would silently end the game
  // before it started.
  for (const bad of ['0', '-1', 'abc', '2.5', 'NaN']) {
    assert.equal(attemptCapFrom(bad), Infinity, `${bad} should not become a cap`);
  }
});
