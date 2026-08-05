#!/usr/bin/env node
// Live smoke test of the AI call plus the dictionary. Run this after changing provider,
// model or prompts — unit tests mock the model, so nothing else proves the
// API shape is right. Costs a few tenths of a cent.
//
//   GEMINI_API_KEY=... npm run check:ai
//
// Exits non-zero if any role fails, so it can gate a deploy.

import { guardedGuesser, MODEL_ID } from '../server/ai.js';
import { isSwedishWord, dictionarySize } from '../server/dictionary.js';
import { judgeClue } from '../server/game.js';

if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.error('Sätt GEMINI_API_KEY (eller GOOGLE_API_KEY) först.');
  process.exit(2);
}

const TARGET = 'morot';
const FORBIDDEN = ['grönsak', 'orange', 'kanin', 'rot', 'odla'];

let failed = 0;
const ok = (label, pass, detail) => {
  console.log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failed++;
};

console.log(`Modell: ${MODEL_ID}\n`);

// 1. The single call must both judge and guess. A check that fails open on
//    everything looks identical to a working one from the UI, which is
//    exactly why this exists.
const fair = await guardedGuesser({ clue: 'kaninmat', letterCount: 5 });
ok('ett anrop: godkänner laglig ledtråd OCH gissar', fair?.legal === true && !!fair.guess,
   fair === null ? 'INGET SVAR (fail open — kontrollen är död)' : JSON.stringify(fair));

const cheat = await guardedGuesser({ clue: 'carrot', letterCount: 5 });
ok('ett anrop: stoppar icke-svenska (översättning)', cheat?.legal === false,
   cheat === null ? 'INGET SVAR (fail open)' : JSON.stringify(cheat));

const abbrev = await guardedGuesser({ clue: 'bl.a. rotsak', letterCount: 5 });
ok('ett anrop: stoppar förkortning', abbrev?.legal === false,
   abbrev === null ? 'INGET SVAR (fail open)' : JSON.stringify(abbrev));

// The judgment half of the compound rule: no ellipsis to give it away.
const fragment = await guardedGuesser({ clue: 'skit', letterCount: 6 });
ok('ett anrop: stoppar sammansättningsledtråd', fragment?.legal === false,
   fragment === null ? 'INGET SVAR (fail open)' : JSON.stringify(fragment));

const describing = await guardedGuesser({ clue: 'kaffe', letterCount: 4 });
ok('ett anrop: tillåter beskrivande sammansättning', describing?.legal === true,
   describing === null ? 'INGET SVAR' : JSON.stringify(describing));

// Proper nouns must survive rule 1, which bans foreign words. This is the
// check most likely to regress on a prompt or model change.
const propernoun = await guardedGuesser({ clue: 'etna', letterCount: 6 });
ok('ett anrop: tillåter känt exempel (egennamn)', propernoun?.legal === true,
   propernoun === null ? 'INGET SVAR' : JSON.stringify(propernoun));

const creative = await guardedGuesser({ clue: 'kaninglass', letterCount: 5 });
ok('ett anrop: tillåter påhittad svensk sammansättning', creative?.legal === true,
   creative === null ? 'INGET SVAR' : JSON.stringify(creative));

// 2. Dictionary replaces the old verifier call — no API, no cost.
ok('ordlista: laddad', dictionarySize() > 100000, `${dictionarySize()} ord`);
ok('ordlista: godkänner riktigt ord', isSwedishWord('morot') === true);
ok('ordlista: underkänner påhittat ord', isSwedishWord('morotsnäsa') === false);

// 3. Whole pipeline, as a player would hit it.
const verdict = await judgeClue({ clue: 'kaninmat', target: TARGET, forbidden: FORBIDDEN });
ok('hela kedjan ger ett utslag', ['correct', 'wrong', 'ai_failure', 'rejected'].includes(verdict?.type),
   JSON.stringify(verdict));

console.log(failed ? `\n${failed} kontroll(er) misslyckades.` : '\nAllt fungerar.');
process.exit(failed ? 1 : 0);
