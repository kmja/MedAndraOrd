import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guesserSystemPrompt, batchGuesserSystemPrompt, retryNote } from '../server/locales/en/prompt.js';

// The English rulebook is a rewrite of the Swedish one, not a translation, so
// it needs its own tests. These assert the structural properties that took the
// Swedish prompt several rounds of live play to get right — a rule that is
// listed but never enforced, a rule deferred to step 2 that step 2 never
// applies, and worked examples close enough to be confused for each other.

const PROMPTS = () => [guesserSystemPrompt(5, 'noun'), batchGuesserSystemPrompt()];

test('every rule the English prompt lists is a rule it says to enforce', () => {
  // Rule 4 was listed for a while and the closing line only named 1–3, which
  // made it entirely inert. Nothing in the text says so; only this catches it.
  for (const prompt of PROMPTS()) {
    const numbered = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.ok(numbered.length >= 7, `expected the numbered rules, got ${numbered}`);
    const highest = Math.max(...numbered);
    assert.deepEqual(
      numbered, [...Array(highest).keys()].map((n) => n + 1),
      'the rules must be numbered 1..N with no gaps',
    );
    const range = prompt.match(/breaks 1–(\d+)/);
    assert.ok(range, 'the prompt must say which rules to enforce');
    assert.equal(Number(range[1]), highest, 'the enforcement range must cover every rule listed');
  }
});

test('every rule deferred to step 2 is actually applied there', () => {
  // Rules 5, 6 and 7 ask how the clue relates to the ANSWER, and the guesser is
  // blind — so they cannot be judged in step 1. Each defers itself; the set
  // that defers and the set step 2 names have to be the same set.
  for (const prompt of PROMPTS()) {
    const deferred = [...prompt.matchAll(/^(\d+)\. [^\n]*see STEP 2/gm)].map((m) => Number(m[1]));
    assert.deepEqual(deferred, [5, 6, 7], `expected 5,6,7 to defer, got ${deferred}`);

    const applyLine = prompt.match(/test rules ([\d, and]+) against your own guess/);
    assert.ok(applyLine, 'step 2 must say which rules it applies');
    const applied = (applyLine[1].match(/\d+/g) ?? []).map(Number);
    assert.deepEqual(applied, deferred, 'a rule that defers to step 2 must be one step 2 names');

    for (const n of deferred) {
      assert.ok(
        prompt.indexOf(`${n}. `) < prompt.indexOf(applyLine[0]),
        `rule ${n} must be stated before the step that applies it`,
      );
      assert.match(prompt, new RegExp(`Rule ${n} —`), `step 2 states no test for rule ${n}`);
    }
  }
});

test('no refused illustration shares a first word with an allowed one', () => {
  // The Swedish bug this guards against: the banned "blöt plask barn" made the
  // legal "blött plask" look like the start of it, and the model refused a
  // correctly formed clue for weeks.
  const firstWord = (s) => s.trim().split(/\s+/)[0].toLowerCase();
  for (const prompt of PROMPTS()) {
    // "..." ALLOWED does not match "..." NOT ALLOWED — the word after the
    // whitespace differs — so the two sets stay disjoint.
    const allowed = [...prompt.matchAll(/"([^"]+)"\s+ALLOWED/g)].map((m) => m[1]);
    const refused = [...prompt.matchAll(/"([^"]+)"\s+NOT ALLOWED/g)].map((m) => m[1]);
    assert.ok(allowed.length >= 4 && refused.length >= 3, `got ${allowed.length}/${refused.length}`);
    for (const bad of refused) {
      for (const good of allowed) {
        assert.notStrictEqual(firstWord(bad), firstWord(good), `"${bad}" vs "${good}"`);
        assert.ok(!bad.startsWith(good) && !good.startsWith(bad), `"${bad}" vs "${good}"`);
      }
    }
  }
});

test('rule 6 keeps the example-of-the-category clue it sits beside', () => {
  // An instance OF the answer describes it; a sibling does not. The two look
  // alike, so the prompt has to draw the line in one place and ship the
  // operational test rather than the label.
  for (const prompt of PROMPTS()) {
    assert.match(prompt, /proper names and well-known examples of the category are ALLOWED/);
    assert.match(prompt, /EXAMPLE OF the answer is allowed, a SIBLING of the answer is not/);
    assert.match(prompt, /can you say "this IS a <word>"\?/);
  }
});

test('rule 7 ships a sentence test and protects the clue kinds it could swallow', () => {
  for (const prompt of PROMPTS()) {
    for (const frame of ['IS ...', 'is used for ...', 'does or causes ...', 'resembles ...']) {
      assert.ok(prompt.includes(frame), `rule 7 is missing the "${frame}" frame`);
    }
    assert.match(prompt, /MADE of something does not count as being it/);
    // "wet splash" survives on "causes" — the English counterpart of the clue
    // the Swedish rule 4 fix was written for.
    assert.match(prompt, /a splash is no part of footwear/);
  }
});

test('both English guessers are given the same rulebook', () => {
  // Batching exists to measure the same game more cheaply. Two prompts that
  // drifted apart would measure two different games.
  const [single, batch] = PROMPTS();
  for (const rule of [
    'Is not English',
    'Spells or rhymes its way there',
    'blank to fill in',
    'proper names and well-known examples',
    'Be generous otherwise',
  ]) {
    assert.ok(single.includes(rule), `single prompt missing: ${rule}`);
    assert.ok(batch.includes(rule), `batch prompt missing: ${rule}`);
  }
  assert.match(batch, /Treat every clue entirely on its own/);
});

test('the English prompt states the letter count it was given', () => {
  assert.match(guesserSystemPrompt(7), /exactly 7 letters/);
  assert.match(guesserSystemPrompt(3), /exactly 3 letters/);
});

test('the ban list appears only on a retry, and then asks for three', () => {
  const first = guesserSystemPrompt(5, 'noun');
  assert.ok(!first.includes('FORBIDDEN ANSWERS'), 'the first ask has nothing to forbid');
  assert.match(first, /"legal": true, "guess":/, 'the first ask wants one guess');

  const retry = guesserSystemPrompt(5, 'noun', ['clock', 'chime']);
  assert.match(retry, /FORBIDDEN ANSWERS/);
  assert.match(retry, /• clock/);
  assert.match(retry, /• chime/);
  assert.match(retry, /give THREE different candidates/);
  assert.match(retry, /"guesses":/, 'a retry wants a list, not one word');
});

test('retryNote states the rulings rather than staging a dialogue', () => {
  // Replaying rejected guesses as `model` turns reads to the model as a worked
  // example of answering that way, and it repeated the same word for three
  // rounds. The rulings are stated by us, in one turn, each word listed once.
  const note = retryNote([
    { guess: 'clock', problem: 'not_word' },
    { guess: 'clocks', problem: 'length', letters: 6 },
    { guess: 'clock', problem: 'not_word' },
  ], 5);
  assert.equal(note.match(/"clock"/g).length, 1, 'a repeated guess is listed once');
  assert.match(note, /has 6 letters, not 5/);
  assert.match(note, /NOT on the list/);
});

test('rule 8 refuses a brand standing in for the product', () => {
  // "Deere" solved traktor. A tractor is not a Deere — it is MADE BY one, which
  // is the same shape as rule 7's "made of". And brands are engineered to be
  // short and to name a category unambiguously, so under golf scoring "name the
  // market leader" would be the shortest clue for every manufactured object in
  // the bank. A forbidden list cannot chase that; it is unbounded per word.
  for (const prompt of PROMPTS()) {
    assert.match(prompt, /8\. Is only a brand or a manufacturer standing in for the product/);
    assert.match(prompt, /is no manufacturer — it is MADE BY one/);
  }
});

test('rule 8 does not catch trademarks that became ordinary words', () => {
  // "thermos" and "zipper" are words now, not brands. A blanket ban on names
  // that were once trademarks would refuse ordinary vocabulary — and the
  // proper-name rule it sits beside has to survive intact.
  for (const prompt of PROMPTS()) {
    assert.match(prompt, /trademark that has become an ordinary word/);
    assert.match(prompt, /proper names and well-known examples of the category are ALLOWED/);
    assert.match(prompt, /"nile" for river is allowed/);
  }
});

test('rule 8 is judged in step 1, where it belongs', () => {
  // Unlike rules 5, 6 and 7, "is this clue merely a brand name" is a property of
  // the clue alone — no answer needed. So it must NOT defer to step 2, or it
  // would be checked in the one place that cannot see it any better.
  for (const prompt of PROMPTS()) {
    const deferred = [...prompt.matchAll(/^(\d+)\. [^\n]*see STEP 2/gm)].map((m) => Number(m[1]));
    assert.deepEqual(deferred, [5, 6, 7], `rule 8 must not defer, got ${deferred}`);
  }
});
