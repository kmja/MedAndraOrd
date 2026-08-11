import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdirSync } from 'node:fs';

import { letterCount, normalize } from '../server/util.js';

// The bank invariants, checked for every language rather than for whichever one
// the process happens to have loaded. Each of these caught something real in
// the Swedish bank; a second bank authored later gets them for free.

const localesDir = new URL('../server/locales/', import.meta.url);
const CODES = readdirSync(localesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

async function loadLocale(code) {
  const [{ WORDS }, rotation, prompt] = await Promise.all([
    import(`../server/locales/${code}/words.js`),
    import(`../server/locales/${code}/rotation.js`),
    import(`../server/locales/${code}/prompt.js`),
  ]);
  return { WORDS, ...rotation, ...prompt };
}

function dictionary(code) {
  const cache = new Map();
  return (word) => {
    const w = normalize(word);
    const len = [...w].length;
    if (!cache.has(len)) {
      try {
        const raw = fs.readFileSync(new URL(`../server/data/${code}-words-${len}.txt`, import.meta.url), 'utf8');
        cache.set(len, new Set(raw.split('\n').filter(Boolean)));
      } catch {
        cache.set(len, null);
      }
    }
    const set = cache.get(len);
    return set === null ? null : set.has(w);
  };
}

test('every locale has a bank, a rotation and a prompt', () => {
  assert.ok(CODES.length >= 2, `expected at least two locales, found ${CODES}`);
});

for (const code of CODES) {
  test(`${code}: every target is a real word in its own dictionary`, async () => {
    // A target the dictionary does not know can never be guessed: the guess is
    // checked against the same list, so the AI would be told its correct answer
    // is a confabulation.
    const { WORDS } = await loadLocale(code);
    const isWord = dictionary(code);
    const missing = WORDS.map((e) => e.word).filter((w) => isWord(w) !== true);
    assert.deepEqual(missing, [], `${code}: targets absent from the dictionary`);
  });

  test(`${code}: every entry carries a usable forbidden list`, async () => {
    const { WORDS } = await loadLocale(code);
    for (const { word, forbidden } of WORDS) {
      const n = letterCount(word);
      assert.ok(n >= 3 && n <= 9, `${code}: ${word} is ${n} letters`);
      assert.ok(forbidden.length >= 4, `${code}: ${word} needs a real forbidden list`);
      for (const f of forbidden) {
        // A forbidden word MAY be a substring of the target ("rot" in "morot"),
        // but it must never simply be the target.
        assert.notEqual(normalize(f), normalize(word), `${code}: ${word} forbids itself`);
      }
      assert.equal(new Set(forbidden).size, forbidden.length, `${code}: ${word} repeats a forbidden word`);
    }
  });

  test(`${code}: no target appears twice`, async () => {
    const { WORDS } = await loadLocale(code);
    const seen = new Set();
    for (const { word } of WORDS) {
      assert.ok(!seen.has(normalize(word)), `${code}: ${word} is in the bank twice`);
      seen.add(normalize(word));
    }
  });

  test(`${code}: the prompt names no word from the bank`, async () => {
    // The guesser is blind, but the prompt is in its context on every call. A
    // target named there — even as an example of a *rule* — is one the model can
    // reach for on a vague clue, making it quietly easier than the rest of the
    // bank for a reason unrelated to the player's clue. This caught six in
    // Swedish: morot, vulkan, torn, månad, stövel and kaffe.
    const { WORDS, guesserSystemPrompt, batchGuesserSystemPrompt } = await loadLocale(code);
    // Words the prompt cannot be written without. Keep this tiny, and only for
    // words that appear as GRAMMAR rather than as a possible answer.
    const UNAVOIDABLE = { sv: new Set(['vad']), en: new Set() }[code] ?? new Set();
    for (const [name, text] of [
      ['single', guesserSystemPrompt(6)],
      ['batch', batchGuesserSystemPrompt()],
    ]) {
      const mentioned = new Set(text.toLowerCase().match(/\p{L}+/gu) ?? []);
      const leaked = WORDS.map((e) => e.word)
        .filter((w) => !UNAVOIDABLE.has(normalize(w)))
        .filter((w) => mentioned.has(normalize(w)));
      assert.deepEqual(leaked, [], `${code} ${name} prompt names bank words: ${leaked.join(', ')}`);
    }
  });

  test(`${code}: the rotation is a permutation of the bank`, async () => {
    // The rotation indexes the bank, so the two travel together. A rotation
    // that outlived its bank would point past the end — or worse, quietly at
    // the wrong words.
    const { WORDS, ROTATION, ROTATION_EPOCH } = await loadLocale(code);
    assert.equal(ROTATION.length, WORDS.length, `${code}: rotation and bank differ in size`);
    assert.deepEqual(
      [...ROTATION].sort((a, b) => a - b),
      WORDS.map((_, i) => i),
      `${code}: rotation must visit every word exactly once`,
    );
    assert.ok(Number.isInteger(ROTATION_EPOCH) && ROTATION_EPOCH > 0, `${code}: bad epoch`);
  });

  test(`${code}: consecutive days are far apart in the bank`, async () => {
    // The bank is authored in themed blocks. Walking it in order would serve a
    // week of insects; the stride permutation is what stops that.
    const { ROTATION, WORDS } = await loadLocale(code);
    const minGap = Math.min(...ROTATION.slice(1).map((v, i) => Math.abs(v - ROTATION[i])));
    assert.ok(minGap > WORDS.length / 10, `${code}: consecutive days only ${minGap} apart`);
  });
}

test('every locale can render every refusal the rule engine can produce', async () => {
  // checkClueCode returns a language-neutral code and looks the words up in the
  // locale. A code with no message would throw at the moment a player wrote
  // that clue — the one path where a missing translation is a crash rather
  // than a cosmetic gap. So the codes are read out of the engine itself.
  const { readFileSync } = await import('node:fs');
  const engine = readFileSync(new URL('../server/util.js', import.meta.url), 'utf8');
  const codes = [...engine.matchAll(/refuse\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 6, `expected the refusal codes, found ${codes}`);

  for (const code of CODES) {
    const { clueMessages, FALLBACK_REFUSAL, errors } = await import(`../server/locales/${code}/messages.js`);
    for (const refusal of codes) {
      assert.equal(typeof clueMessages[refusal], 'function', `${code} has no message for "${refusal}"`);
      // And it must actually render — a template referring to a parameter that
      // is never passed would produce "undefined" on screen.
      const text = clueMessages[refusal]({ maxLength: 18, word: 'test' });
      assert.ok(text && !text.includes('undefined'), `${code}/${refusal} rendered "${text}"`);
    }
    assert.ok(FALLBACK_REFUSAL, `${code} has no fallback refusal`);
    for (const [key, value] of Object.entries(errors)) {
      assert.ok(value && typeof value === 'string', `${code}: error "${key}" is empty`);
    }
  }
});

test('the locales agree on which errors exist', async () => {
  // A key present in one language and missing in another is a blank message on
  // one of the two sites, and nothing would notice until someone hit it.
  const tables = await Promise.all(
    CODES.map(async (code) => [code, (await import(`../server/locales/${code}/messages.js`)).errors]),
  );
  const [firstCode, first] = tables[0];
  for (const [code, errors] of tables.slice(1)) {
    assert.deepEqual(
      Object.keys(errors).sort(), Object.keys(first).sort(),
      `${code} and ${firstCode} do not offer the same errors`,
    );
  }
});
