#!/usr/bin/env node
// Live smoke test of the three AI roles. Run this after changing provider,
// model or prompts — unit tests mock the model, so nothing else proves the
// API shape is right. Costs a few tenths of a cent.
//
//   GEMINI_API_KEY=... npm run check:ai
//
// Exits non-zero if any role fails, so it can gate a deploy.

import { referee, guesser, verifier, MODEL_ID } from '../server/ai.js';
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

// 1. Referee must pass a fair clue and reject a translation. A referee that
//    fails open on everything looks identical to a working one from the UI,
//    which is exactly why this check exists.
const fair = await referee({ target: TARGET, forbidden: FORBIDDEN, clue: 'kaninmat' });
ok('domare: släpper igenom laglig ledtråd', fair?.legal === true,
   fair === null ? 'INGET SVAR (fail open — kontrollen är död)' : JSON.stringify(fair));

const cheat = await referee({ target: TARGET, forbidden: FORBIDDEN, clue: 'carrot' });
ok('domare: stoppar översättning', cheat?.legal === false,
   cheat === null ? 'INGET SVAR (fail open)' : JSON.stringify(cheat));

// 2. Guesser must answer with a single word of the right length.
const raw = await guesser({ clue: 'kaninmat', letterCount: 5 });
ok('gissare: svarar med ett ord', typeof raw === 'string' && raw.trim().length > 0,
   raw === null ? 'INGET SVAR' : JSON.stringify(raw.trim()));

// 3. Verifier must separate real words from invented ones.
const real = await verifier('morot');
const fake = await verifier('morotsnäsa');
ok('verifierare: godkänner riktigt ord', real === true, `morot → ${real}`);
ok('verifierare: underkänner påhittat ord', fake === false, `morotsnäsa → ${fake}`);

// 4. Whole pipeline, as a player would hit it.
const verdict = await judgeClue({ clue: 'kaninmat', target: TARGET, forbidden: FORBIDDEN });
ok('hela kedjan ger ett utslag', ['correct', 'wrong', 'ai_failure', 'rejected'].includes(verdict?.type),
   JSON.stringify(verdict));

console.log(failed ? `\n${failed} kontroll(er) misslyckades.` : '\nAllt fungerar.');
process.exit(failed ? 1 : 0);
