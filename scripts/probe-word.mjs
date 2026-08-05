#!/usr/bin/env node
// Measures how hard a word actually is, by playing the game against it.
//
//   GEMINI_API_KEY=... npm run probe -- stövel
//   GEMINI_API_KEY=... npm run probe -- --bank 20     (20 random bank words)
//
// The static audit (review:words) can only find *candidate* routes into a word.
// It cannot tell you whether a route works, because the guesser is blind: given
// "rid" and "5 letters" a model may well answer sadel rather than vante. The
// only way to know is to play.
//
// So this does what a strong player would: it asks the model for its best short
// clues — with the answer and the forbidden list in front of it, exactly the
// information a player has — and then runs each clue through the real pipeline,
// blind guesser and all. What comes back is the word's empirical par: the
// shortest clue that actually solved it.
//
// Reading the result:
//   shortest 2-4  — too easy. One cheap clue will dominate its leaderboard.
//   shortest 5-9  — good. Room to compete below par.
//   nothing solved — too hard, or the forbidden list is over-tight.
//   solved 90%+   — too easy in a different way: every route works, so the
//                   scoring collapses to whoever types fewest characters.

import { GoogleGenAI } from '@google/genai';

import { WORDS, wordByIndex } from '../server/words.js';
import { judgeClue } from '../server/game.js';
import { clueLength, MAX_CLUE_LENGTH } from '../server/util.js';

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('Sätt GEMINI_API_KEY (eller GOOGLE_API_KEY) först.');
  process.exit(2);
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.ORDKNAPP_MODEL || 'gemini-3.1-flash-lite';
const CANDIDATES = 12;

/** The adversarial player: sees everything, tries to win in as few characters as possible. */
async function proposeClues({ word, forbidden }) {
  const system = `Du är en mycket skicklig spelare i ordspelet Ordknapp. Du ska skriva ledtrådar som får en BLIND AI att gissa ett hemligt svenskt ord. AI:n ser bara din ledtråd och ordets antal bokstäver.

Poängen är antalet tecken — färre är bättre. Sikta så kort du kan.

Regler: svenska, inte målordet eller dess böjningar, inte de spärrade orden, ingen översättning, inga stavnings- eller rimtrick, och inget ordled som bara ska fyllas i till en sammansättning. Kända exempel (egennamn) är tillåtna.

Svara ENDAST med JSON: {"clues": ["...", "..."]} med ${CANDIDATES} förslag, sorterade kortast först. Blanda strategier: beskrivning, funktion, kända exempel, sammansättningar som beskriver.`;

  const user = `Hemligt ord: ${word} (${[...word].length} bokstäver)
Spärrade ord: ${forbidden.join(', ')}`;

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: user }] }],
    config: { systemInstruction: system, maxOutputTokens: 600, temperature: 1, responseMimeType: 'application/json' },
  });
  const text = res.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    return (JSON.parse(m[0]).clues ?? [])
      .filter((c) => typeof c === 'string' && clueLength(c) > 0 && clueLength(c) <= MAX_CLUE_LENGTH);
  } catch {
    return [];
  }
}

async function probe(entry) {
  const clues = await proposeClues(entry);
  const results = [];
  for (const clue of clues) {
    const verdict = await judgeClue({ clue, target: entry.word, forbidden: entry.forbidden });
    results.push({ clue, len: clueLength(clue), type: verdict.type, guess: verdict.guess });
  }
  const solved = results.filter((r) => r.type === 'correct').sort((a, b) => a.len - b.len);
  return { entry, results, solved, shortest: solved[0] ?? null };
}

const args = process.argv.slice(2);
let targets = [];
if (args[0] === '--bank') {
  const n = Number(args[1] || 10);
  const idx = new Set();
  while (idx.size < Math.min(n, WORDS.length)) idx.add(Math.floor(Math.random() * WORDS.length));
  targets = [...idx].map((i) => wordByIndex(i));
} else if (args.length) {
  targets = args.map((w) => WORDS.find((e) => e.word === w)).filter(Boolean);
  if (!targets.length) {
    console.error(`Hittade inte ordet i banken. Kända ord: ${WORDS.length} st.`);
    process.exit(2);
  }
} else {
  console.error('Ange ett ord ur banken, eller --bank <antal>.');
  process.exit(2);
}

console.log(`Modell: ${MODEL} · ${CANDIDATES} kandidater per ord\n`);
const summary = [];
for (const entry of targets) {
  const { results, solved, shortest } = await probe(entry);
  const rate = results.length ? Math.round((solved.length / results.length) * 100) : 0;
  const verdict = !shortest ? 'FÖR SVÅR' : shortest.len <= 4 ? 'FÖR LÄTT' : rate >= 90 ? 'FÖR LÄTT (allt löser)' : 'BRA';
  summary.push({ word: entry.word, shortest: shortest?.len ?? null, rate, verdict });

  console.log(`${entry.word.toUpperCase()}  (spärrat: ${entry.forbidden.join(', ')})`);
  console.log(`  ${solved.length}/${results.length} löste ordet · kortaste lyckade: ${shortest ? `"${shortest.clue}" (${shortest.len})` : '—'} · ${verdict}`);
  for (const r of results.slice(0, 8)) {
    const mark = r.type === 'correct' ? '✓' : r.type === 'rejected' ? '⊘' : '·';
    console.log(`    ${mark} ${String(r.len).padStart(2)}  ${r.clue.padEnd(24)} ${r.type === 'correct' ? '' : `→ ${r.guess ?? r.type}`}`);
  }
  console.log();
}

console.log('SAMMANFATTNING');
for (const s of summary) {
  console.log(`  ${s.word.padEnd(14)} kortaste ${String(s.shortest ?? '-').padStart(2)}  lösningsgrad ${String(s.rate).padStart(3)}%  ${s.verdict}`);
}
const bad = summary.filter((s) => s.verdict !== 'BRA');
console.log(`\n${bad.length}/${summary.length} ord behöver ses över.`);
