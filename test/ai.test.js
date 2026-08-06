import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  textOf, parseRuling, guesserSystemPrompt, batchGuesserSystemPrompt,
  parseBatchGuesses, cleanReason, classifyApiError, retryDelayMs,
  guessCorrection, retryTemperature,
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
  assert.deepEqual(got.get(1), { legal: true, guess: 'stövel', why: null });
  assert.deepEqual(got.get(2), { legal: false, reason: 'Rim.' });
});

test('cleanReason tidies the sentence shown to the player', () => {
  // Model-written text going straight onto a card. Length is capped here
  // rather than trusted to the prompt — a model that ignores "max 100 tecken"
  // should cost a clipped line, not a broken layout.
  assert.equal(cleanReason('  Jag läste det   som\n en frukt. '), 'Jag läste det som en frukt.');
  assert.equal(cleanReason('x'.repeat(300)).length, 120);
  assert.match(cleanReason('x'.repeat(300)), /…$/);
  for (const bad of [undefined, null, 123, '', '   ', {}]) {
    assert.equal(cleanReason(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
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

test('the guesser prompt requires a clue to read as Swedish', () => {
  // Golf scoring plus a model that guesses by association makes a pile of
  // loose keywords the strongest tactic — and the least interesting one. The
  // rule that a clue must hold together as a phrase is what makes a crafted
  // clue beat "blöt plask barn", so it is load-bearing.
  for (const prompt of [guesserSystemPrompt(6), batchGuesserSystemPrompt()]) {
    assert.match(prompt, /uppräkning/);
    // The test the model is asked to apply must be the grammatical one. Phrased
    // as "does this read as Swedish" it drifted into a vibe check, and a
    // correctly-formed two-word phrase got refused.
    assert.match(prompt, /Testet är grammatiskt/);
    assert.match(prompt, /fras med ett huvudord/);
    // And it must say what it is NOT, or it becomes a ban on short clues.
    assert.match(prompt, /[Ee]nsamt ord.*aldrig avvisas/);
    assert.match(prompt, /skillnaden är strukturen, aldrig antalet ord/);
    // A rejected example must not contain an allowed one as a prefix. "blöt
    // plask barn" was the banned illustration, and "blött plask" — a correct
    // adjective-noun phrase — got refused for looking like the start of it.
    // The model pattern-matches the examples, so they have to be disjoint.
    const allowed = [...prompt.matchAll(/"([^"]+)"\s+TILLÅTEN/g)].map((m) => m[1]);
    const refused = [...prompt.matchAll(/"([^"]+)"\s+OTILLÅTEN/g)].map((m) => m[1]);
    assert.ok(allowed.length >= 3 && refused.length >= 1, 'rule 4 needs a worked contrast');
    // Rule 4's own prose carries refused examples too, and they are not tagged
    // OTILLÅTEN — so checking only the tagged ones missed that the banned
    // "trögt snöre yta" opened with the same word as the allowed "trögt
    // skodon". Everything quoted inside rule 4 is an illustration of breaking
    // it, so pick those up as well.
    const ruleFour = prompt.slice(prompt.indexOf('4. Är en uppräkning'), prompt.indexOf('\n5. Pekar ut'));
    refused.push(...[...ruleFour.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    // Whole-string containment was too weak a test: "trögt skodon" is not a
    // prefix of "trögt snöre yta", yet they open with the same word, which is
    // all the model needs to read one as the other. Examples on opposite sides
    // of the rule must not share a first word.
    const firstWord = (s) => s.trim().split(/\s+/)[0].toLowerCase();
    for (const bad of refused) {
      for (const good of allowed) {
        assert.ok(
          !bad.startsWith(good) && !good.startsWith(bad),
          `"${good}" is a prefix of the refused example "${bad}" — the model will confuse them`,
        );
        assert.notStrictEqual(
          firstWord(bad), firstWord(good),
          `refused "${bad}" and allowed "${good}" open with the same word — the model will confuse them`,
        );
      }
    }
  }
});

test('every rule the prompt lists is a rule it says to enforce', () => {
  // The rules are numbered, and the closing instruction names a range. Adding
  // rule 4 without widening that range left it described but not enforced —
  // the prompt said "avvisa bara det som klart bryter mot 1–3" underneath a
  // list of four. Nothing in the output looks wrong when this happens; the
  // rule simply never fires.
  for (const prompt of [guesserSystemPrompt(6), batchGuesserSystemPrompt()]) {
    const listed = [...prompt.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    const highest = Math.max(...listed);
    assert.ok(highest >= 4, `expected at least 4 numbered rules, saw ${highest}`);

    const range = /bryter mot 1[–-](\d+)/.exec(prompt);
    assert.ok(range, 'the prompt must say which rules to enforce');
    assert.equal(
      Number(range[1]),
      highest,
      `prompt lists ${highest} rules but only tells the model to enforce 1-${range[1]}`,
    );
  }
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

test('the rulebook fingerprint changes when the rulebook does', async () => {
  // The verdict cache is keyed by this. If it did not move with the rules, a
  // ruling made under the old wording would outlive the fix that changed it —
  // which is exactly how "blött plask" stayed refused after being made legal.
  const { RULEBOOK_ID } = await import('../server/ai.js');
  assert.match(RULEBOOK_ID, /^[0-9a-f]{8}$/);

  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../server/ai.js', import.meta.url), 'utf8');
  // Derived from the rule text, not typed in by hand — a literal would drift
  // the moment someone edited a rule without remembering to bump it.
  assert.match(source, /RULEBOOK_ID = createHash/);

  // And it must cover ALL of it. Naming the pieces in the hash by hand has the
  // same failure mode as a version number: add a section to the prompt, forget
  // to add it here, and rulings survive an edit they should not have. So check
  // the real property — every shared block the prompts interpolate is hashed.
  const hashed = source.match(/\.update\(\[([^\]]+)\]/)[1];
  const interpolated = new Set([...source.matchAll(/\$\{([A-Z][A-Z_]+)\}/g)].map((m) => m[1]));
  assert.ok(interpolated.size >= 3, 'expected the prompts to be built from shared blocks');
  for (const block of interpolated) {
    assert.ok(
      hashed.includes(block),
      `${block} goes into a prompt but not into RULEBOOK_ID — edits to it would not expire cached rulings`,
    );
  }
});

test('rule 5 refuses a part standing in for the whole', () => {
  // "altare" and "församling" both solved kyrka. Neither says what a church
  // IS — an altar stands inside one — so they read as a lookup rather than a
  // clue, which is the thing this game is meant not to reward.
  for (const prompt of [guesserSystemPrompt(5), batchGuesserSystemPrompt()]) {
    assert.match(prompt, /5\. Pekar ut en DEL av saken/);
    assert.match(prompt, /de människor som hör till svaret/, 'must cover participants, not just objects');
  }
});

test('rule 5 is checked against the guess, because step 1 cannot see the answer', () => {
  // Every other rule is a property of the clue alone. "Is this a part of the
  // answer?" needs an answer to be a part OF, and the guesser is blind — so
  // the check has to happen once it has its own guess, or it is unanswerable.
  for (const prompt of [guesserSystemPrompt(5), batchGuesserSystemPrompt()]) {
    assert.match(prompt, /pröva regel 5 mot din egen gissning/);
    // Stated in step 1, applied in step 2 — the rule must point forward, or
    // the model will try to judge it with information it does not have.
    assert.ok(
      prompt.indexOf('5. Pekar ut en DEL') < prompt.indexOf('pröva regel 5 mot din egen gissning'),
      'the rule must be stated before the step that applies it',
    );
    assert.match(prompt, /se STEG 2/);
  }
});

test('rule 5 does not swallow the evocative clues rule 4 was fixed to allow', () => {
  // The obvious phrasing of rule 5 — "the clue must be substitutable for the
  // answer" — also refuses "blött plask", which is the clue rule 4 was
  // repaired for. A boot is not a wet splash. So the line drawn is narrower:
  // a part sits IN the thing; a description says what it does or causes.
  for (const prompt of [guesserSystemPrompt(6), batchGuesserSystemPrompt()]) {
    assert.match(prompt, /något ordet gör, orsakar, används till, eller påminner om/);
    assert.match(prompt, /Ett plask är ingen del av ett skodon/);
    // And the worked contrast must show both sides, or it reads as a ban on
    // association in general.
    assert.match(prompt, /"sväva över taken"\s+TILLÅTEN/);
    assert.match(prompt, /"propeller"\s+OTILLÅTEN/);
  }
});

test('a retry tells the model what it has already tried', () => {
  // Without this every round sent the same sentence, and the same sentence at
  // temperature 0 gets the same answer back. The loop ran its four rounds and
  // collected four copies of "klock" — retries that fire but cannot diverge.
  const first = guessCorrection({ guess: 'klock', problem: 'not_word' }, 5, ['klock']);
  assert.match(first, /redan föreslagit: "klock"/);

  const third = guessCorrection({ guess: 'klok', problem: 'not_word' }, 5, ['klock', 'klok', 'kloka']);
  for (const g of ['klock', 'klok', 'kloka']) assert.ok(third.includes(`"${g}"`), `missing ${g}`);
  assert.match(third, /ANNAT ord/);

  // The very first ask has nothing to list, and must not grow a dangling
  // "already suggested:" with an empty list after it.
  const clean = guessCorrection({ guess: 'x', problem: 'not_word' }, 5);
  assert.ok(!clean.includes('redan föreslagit'), 'the first ask has no history to cite');
});

test('every correction kind carries the tried list', () => {
  // Three branches, and a retry that forgets its history is useless whichever
  // branch produced it.
  for (const problem of ['length', 'not_base', 'not_word']) {
    const msg = guessCorrection({ guess: 'klock', problem }, 5, ['klock']);
    assert.match(msg, /redan föreslagit/, `${problem} branch drops the history`);
    assert.match(msg, /samma JSON-format/, `${problem} branch drops the format reminder`);
  }
});

test('retries are allowed to wander, the first answer is not', () => {
  // The first answer to a clue is the one that gets cached, and identical
  // clues should tend to identical verdicts — so it stays deterministic. A
  // retry exists to produce a DIFFERENT word, and asking a temperature-0 model
  // again is asking it to repeat itself.
  assert.equal(retryTemperature(0), 0);
  assert.ok(retryTemperature(1) > 0);
  for (let n = 1; n < 6; n++) {
    assert.ok(retryTemperature(n) <= 1, `temperature must stay in range at ${n}`);
    assert.ok(retryTemperature(n) >= retryTemperature(n - 1), 'must not narrow as it retries');
    // Sent verbatim in a request body, so it must not carry binary float noise.
    assert.equal(retryTemperature(n), Math.round(retryTemperature(n) * 10) / 10);
  }
});
