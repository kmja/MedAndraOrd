#!/usr/bin/env node
// Live smoke test of the three AI roles. Run this after changing provider,
// model or prompts — unit tests mock the model, so nothing else proves the
// API shape is right. Costs a few tenths of a cent.
//
//   GEMINI_API_KEY=... npm run check:ai
//
// Exits non-zero if any role fails, so it can gate a deploy.

import { guardedGuesser, verifier, MODEL_ID } from '../server/ai.js';
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

const creative = await guardedGuesser({ clue: 'kaninglass', letterCount: 5 });
ok('ett anrop: tillåter påhittad svensk sammansättning', creative?.legal === true,
   creative === null ? 'INGET SVAR' : JSON.stringify(creative));

// 2. Verifier must separate real words from invented ones.
const real = await verifier('morot');
const fake = await verifier('morotsnäsa');
ok('verifierare: godkänner riktigt ord', real === true, `morot → ${real}`);
ok('verifierare: underkänner påhittat ord', fake === false, `morotsnäsa → ${fake}`);

// 3. Whole pipeline, as a player would hit it.
const verdict = await judgeClue({ clue: 'kaninmat', target: TARGET, forbidden: FORBIDDEN });
ok('hela kedjan ger ett utslag', ['correct', 'wrong', 'ai_failure', 'rejected'].includes(verdict?.type),
   JSON.stringify(verdict));

console.log(failed ? `\n${failed} kontroll(er) misslyckades.` : '\nAllt fungerar.');
process.exit(failed ? 1 : 0);
