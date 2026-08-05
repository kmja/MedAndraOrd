#!/usr/bin/env node
// Measures how hard a word actually is, by playing the game against it — and
// says what to ban if it turns out too easy.
//
//   npm run probe -- stövel                       ett ord ur banken
//   npm run probe -- stövel vulkan morot          flera
//   npm run probe -- --new "kikare:lins,titta,långt,glas,fjärran"
//   npm run probe -- --bank 10                    slumpat urval
//   npm run probe -- --dry --bank 30              vad skulle det kosta?
//   npm run probe -- --clues 20 --json ut.json stövel
//
// Kräver GEMINI_API_KEY. Lägg den i .env så laddas den härifrån.
//
// ---------------------------------------------------------------------------
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
// Then it reads the solutions back. Clues that solve the same word tend to
// share an element ("vinter" in both vinterplagg and vinterskodon), and that
// shared element is the route. Those are what a forbidden list is for, so they
// are reported as candidates — with the caveat that banning every route makes a
// word unsolvable rather than hard. Ban the cheapest one or two, then re-probe.
//
// Reading the verdict:
//   shortest 2-4  — too easy. One cheap clue will dominate its leaderboard.
//   shortest 5-9  — good. Room to compete below par.
//   nothing solved — too hard, or the forbidden list is over-tight.
//   solved 90%+   — too easy in a different way: every route works, so the
//                   scoring collapses to whoever types fewest characters.

import fs from 'node:fs';
import path from 'node:path';

import { GoogleGenAI } from '@google/genai';

import { WORDS, wordByIndex } from '../server/words.js';
import { judgeClue } from '../server/game.js';
import { isSwedishWord } from '../server/dictionary.js';
import { clueLength, letterCount, normalize, MAX_CLUE_LENGTH } from '../server/util.js';

// ---------------------------------------------------------------------------
// arguments

const argv = process.argv.slice(2);
const opts = {
  clues: 12, dry: false, json: null, bank: 0, words: [], custom: [],
  out: 'probe-results', save: true,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry') opts.dry = true;
  else if (a === '--clues') opts.clues = Number(argv[++i]);
  else if (a === '--json') opts.json = argv[++i];
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--no-save') opts.save = false;
  else if (a === '--bank') opts.bank = Number(argv[++i] || 10);
  else if (a === '--new') opts.custom.push(argv[++i]);
  else if (a.startsWith('--')) fail(`Okänd flagga: ${a}`);
  else opts.words.push(a);
}

function fail(msg) {
  console.error(msg);
  console.error(`
Användning:
  npm run probe -- <ord...>                      ord ur banken
  npm run probe -- --new "ord:spärr1,spärr2"     ord som inte finns i banken än
  npm run probe -- --bank <antal>                slumpat urval

Flaggor:
  --dry            visa bara hur många anrop det blir, ring ingen AI
  --clues <n>      antal kandidatledtrådar per ord (default 12)
  --out <mapp>     var resultaten sparas (default probe-results/)
  --no-save        spara inget
  --json <fil>     extra samlad dump av just den här körningen`);
  process.exit(2);
}

/** A candidate word that isn't in the bank yet — the point of vetting one. */
function parseCustom(spec) {
  const [word, list = ''] = spec.split(':');
  const forbidden = list.split(',').map((s) => s.trim()).filter(Boolean);
  if (!word?.trim()) fail(`Kunde inte läsa --new "${spec}". Format: "ord:spärr1,spärr2"`);
  return { word: word.trim(), forbidden, letterCount: letterCount(word.trim()), index: -1 };
}

const targets = [];
for (const spec of opts.custom) targets.push(parseCustom(spec));
for (const w of opts.words) {
  const found = WORDS.find((e) => normalize(e.word) === normalize(w));
  if (!found) fail(`"${w}" finns inte i banken. Vetta ett nytt ord med --new "${w}:spärr1,spärr2".`);
  targets.push(found);
}
if (opts.bank > 0) {
  const idx = new Set();
  while (idx.size < Math.min(opts.bank, WORDS.length)) idx.add(Math.floor(Math.random() * WORDS.length));
  for (const i of idx) targets.push(wordByIndex(i));
}
if (!targets.length) fail('Ange minst ett ord, --new eller --bank.');

// ---------------------------------------------------------------------------
// cost

// One proposal call per word, then one judgeClue per candidate clue. A wrong
// length or a confabulated guess re-prompts, so the pipeline can spend up to
// MAX_GUESS_ROUNDS on a single clue — the range, not the floor, is the honest
// number to plan against.
function estimate(n) {
  const proposals = n;
  const judged = n * opts.clues;
  return { proposals, judged, min: proposals + judged, max: proposals + judged * 4 };
}

if (opts.dry) {
  const e = estimate(targets.length);
  console.log(`TORRKÖRNING — inga anrop görs.\n`);
  console.log(`  ${targets.length} ord × ${opts.clues} ledtrådar`);
  console.log(`  ${e.proposals} förslagsanrop + ${e.judged} bedömningsanrop`);
  console.log(`  = ${e.min} anrop i bästa fall, upp till ${e.max} om AI:n måste tänka om.`);
  console.log(`\n  Varje anrop är litet (~300 tecken in, ~30 ut). Modell: ${process.env.ORDKNAPP_MODEL || 'gemini-3.1-flash-lite'}.`);
  console.log(`\nOrd som skulle testas:`);
  for (const t of targets) console.log(`  ${t.word.padEnd(14)} spärrat: ${t.forbidden.join(', ') || '(inget)'}`);
  process.exit(0);
}

// Load .env so the key doesn't have to be pasted on every run.
try { process.loadEnvFile('.env'); } catch { /* no .env — fall back to the environment */ }

const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error('Sätt GEMINI_API_KEY — i .env eller i miljön:\n  GEMINI_API_KEY=... npm run probe -- stövel');
  console.error('\nKör med --dry för att se omfattningen utan nyckel.');
  process.exit(2);
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.ORDKNAPP_MODEL || 'gemini-3.1-flash-lite';

// ---------------------------------------------------------------------------
// the adversarial player: sees everything, tries to win in as few characters
// as possible

async function proposeClues({ word, forbidden }) {
  const system = `Du är en mycket skicklig spelare i ordspelet Ordknapp. Du ska skriva ledtrådar som får en BLIND AI att gissa ett hemligt svenskt ord. AI:n ser bara din ledtråd och ordets antal bokstäver.

Poängen är antalet tecken — färre är bättre. Sikta så kort du kan.

Regler: svenska, inte målordet eller dess böjningar, inte de spärrade orden, ingen översättning, inga stavnings- eller rimtrick, och inget ordled som bara ska fyllas i till en sammansättning. Kända exempel (egennamn) är tillåtna.

Svara ENDAST med JSON: {"clues": ["...", "..."]} med ${opts.clues} förslag, sorterade kortast först. Blanda strategier: beskrivning, funktion, kända exempel, sammansättningar som beskriver.`;

  const user = `Hemligt ord: ${word} (${letterCount(word)} bokstäver)
Spärrade ord: ${forbidden.join(', ') || '(inga)'}`;

  const res = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: user }] }],
    config: { systemInstruction: system, maxOutputTokens: 800, temperature: 1, responseMimeType: 'application/json' },
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

// ---------------------------------------------------------------------------
// route analysis: what did the winning clues have in common?

/**
 * Every element of a clue that could stand as a clue of its own: the whole
 * token, plus both halves of any split where BOTH halves are real words.
 * "vinterplagg" yields vinter and plagg — the route is the shared element,
 * not the shared clue.
 *
 * Requiring both halves is what keeps this readable. Accepting any real word
 * found anywhere inside a token instead yields vin, agg and odon out of
 * vinterskodon: all real words, none of them a way into the answer. Swedish
 * also glues elements with a linking -s- (vinter|s|sko), so a head ending in
 * -s counts if the bare form is a word.
 */
function elementsOf(clue) {
  const out = new Set();
  for (const raw of normalize(clue).split(/[\s-]+/)) {
    const token = raw.replace(/[^\p{L}]/gu, '');
    if (token.length < 3) continue;
    out.add(token);
    for (let n = 3; n <= token.length - 3; n++) {
      const head = token.slice(0, n);
      const tail = token.slice(n);
      if (!isSwedishWord(tail)) continue;
      const bare = head.endsWith('s') ? head.slice(0, -1) : null;
      const realHead = isSwedishWord(head)
        ? head
        : (bare && bare.length >= 3 && isSwedishWord(bare) ? bare : null);
      if (realHead) { out.add(realHead); out.add(tail); }
    }
  }
  return out;
}

/** Elements shared by two or more solving clues, cheapest route first. */
function routes(solved, forbidden) {
  const seen = new Map(); // element -> { count, shortest }
  for (const r of solved) {
    for (const el of elementsOf(r.clue)) {
      const hit = seen.get(el) ?? { count: 0, shortest: Infinity };
      hit.count += 1;
      hit.shortest = Math.min(hit.shortest, r.len);
      seen.set(el, hit);
    }
  }
  const blocked = (el) => forbidden.some((f) => el.includes(normalize(f)) || normalize(f).includes(el));
  return [...seen.entries()]
    .filter(([el, v]) => v.count >= 2 && !blocked(el))
    .map(([el, v]) => ({ element: el, ...v }))
    // Cheapest route first: the element that produced the shortest solve is the
    // one that decides the leaderboard.
    .sort((a, b) => a.shortest - b.shortest || b.count - a.count)
    .slice(0, 6);
}

// ---------------------------------------------------------------------------
// storage — one file per word, appended to
//
// Curation is iterative: probe, ban a route, probe again, see whether the word
// actually got harder. That loop only works if the previous run is still
// around, so each word keeps its own history rather than the run overwriting a
// single results file.

const store = {
  file: (word) => path.join(opts.out, `${normalize(word).replace(/[^\p{L}\p{N}]/gu, '_')}.json`),

  read(word) {
    try {
      return JSON.parse(fs.readFileSync(this.file(word), 'utf8'));
    } catch {
      return null; // no history yet, or unreadable — either way, start fresh
    }
  },

  append(word, run) {
    fs.mkdirSync(opts.out, { recursive: true });
    const history = this.read(word) ?? { word, runs: [] };
    history.runs.push(run);
    fs.writeFileSync(this.file(word), JSON.stringify(history, null, 2));
  },

  /** Every word probed so far, latest run only — the "what still needs work" view. */
  index() {
    let files = [];
    try {
      files = fs.readdirSync(opts.out).filter((f) => f.endsWith('.json') && f !== 'index.json');
    } catch {
      return [];
    }
    const rows = [];
    for (const f of files) {
      try {
        const h = JSON.parse(fs.readFileSync(path.join(opts.out, f), 'utf8'));
        const last = h.runs?.[h.runs.length - 1];
        if (last) rows.push({ word: h.word, runs: h.runs.length, ...last });
      } catch { /* skip a file we can't read rather than losing the whole index */ }
    }
    const rank = { 'FÖR LÄTT': 0, 'FÖR LÄTT (allt löser)': 1, 'FÖR SVÅR': 2, BRA: 3 };
    return rows.sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) || (a.shortest ?? 99) - (b.shortest ?? 99));
  },
};

const arrow = (before, after) => {
  if (before == null && after == null) return '—';
  if (before === after) return `${after} (oförändrat)`;
  const d = before != null && after != null ? ` (${after > before ? '+' : ''}${after - before})` : '';
  return `${before ?? '—'} → ${after ?? '—'}${d}`;
};

/** What changed since the last run of this word — the point of keeping history. */
function printDelta(word, prev, now) {
  if (!prev) return;
  console.log(`\n  JÄMFÖRT MED FÖRRA KÖRNINGEN (${prev.at.slice(0, 16).replace('T', ' ')})`);
  console.log(`    kortaste      ${arrow(prev.shortest, now.shortest)}`);
  console.log(`    lösningsgrad  ${arrow(prev.rate, now.rate)} %`);
  if (prev.verdict !== now.verdict) console.log(`    omdöme        ${prev.verdict} → ${now.verdict}`);

  const before = new Set(prev.forbidden.map(normalize));
  const after = new Set(now.forbidden.map(normalize));
  const added = [...after].filter((f) => !before.has(f));
  const removed = [...before].filter((f) => !after.has(f));
  if (added.length || removed.length) {
    console.log(`    spärrlista    ${[...added.map((f) => `+${f}`), ...removed.map((f) => `−${f}`)].join(' ')}`);
  } else {
    // Same list, different numbers: the model is not deterministic, so a small
    // swing between identical runs is noise rather than a result.
    console.log(`    spärrlista    oförändrad — skillnader här är modellens spridning, inte en effekt`);
  }
}

// ---------------------------------------------------------------------------

async function probe(entry) {
  const clues = await proposeClues(entry);
  const results = [];
  for (const clue of clues) {
    const verdict = await judgeClue({ clue, target: entry.word, forbidden: entry.forbidden });
    results.push({ clue, len: clueLength(clue), type: verdict.type, guess: verdict.guess, reason: verdict.reason });
  }
  const solved = results.filter((r) => r.type === 'correct').sort((a, b) => a.len - b.len);
  const rate = results.length ? Math.round((solved.length / results.length) * 100) : 0;
  const shortest = solved[0] ?? null;
  const verdict = !shortest
    ? 'FÖR SVÅR'
    : shortest.len <= 4 ? 'FÖR LÄTT'
    : rate >= 90 ? 'FÖR LÄTT (allt löser)'
    : 'BRA';
  return { entry, results, solved, shortest, rate, verdict, routes: routes(solved, entry.forbidden) };
}

const e = estimate(targets.length);
console.log(`Modell: ${MODEL} · ${targets.length} ord × ${opts.clues} ledtrådar · ~${e.min}–${e.max} anrop\n`);

const report = [];
const startedAt = new Date().toISOString();

for (const entry of targets) {
  // Read the history BEFORE this run is appended, or the comparison would be
  // against itself.
  const prev = opts.save ? store.read(entry.word)?.runs?.slice(-1)[0] ?? null : null;

  const r = await probe(entry);
  const record = {
    at: startedAt,
    model: MODEL,
    clues: opts.clues,
    word: entry.word,
    forbidden: entry.forbidden,
    letters: letterCount(entry.word),
    inBank: entry.index >= 0,
    shortest: r.shortest?.len ?? null,
    shortestClue: r.shortest?.clue ?? null,
    rate: r.rate,
    verdict: r.verdict,
    solved: r.solved.map((s) => ({ clue: s.clue, len: s.len })),
    rejected: r.results.filter((x) => x.type === 'rejected').map((x) => ({ clue: x.clue, reason: x.reason })),
    missed: r.results.filter((x) => x.type === 'wrong').map((x) => ({ clue: x.clue, guess: x.guess })),
    routes: r.routes,
  };
  report.push(record);
  if (opts.save) store.append(entry.word, record);

  console.log(`${entry.word.toUpperCase()} (${letterCount(entry.word)} bokstäver)${entry.index < 0 ? '  [utanför banken]' : ''}`);
  console.log(`  spärrat: ${entry.forbidden.join(', ') || '(inget)'}`);
  console.log(`  ${r.solved.length}/${r.results.length} löste ordet · kortaste ${r.shortest ? `"${r.shortest.clue}" (${r.shortest.len})` : '—'} · ${r.verdict}`);
  console.log();
  for (const x of r.results) {
    const mark = x.type === 'correct' ? '✓' : x.type === 'rejected' ? '⊘' : '·';
    const tail = x.type === 'correct' ? '' : x.type === 'rejected' ? `⊘ ${x.reason ?? ''}` : `→ ${x.guess ?? x.type}`;
    console.log(`    ${mark} ${String(x.len).padStart(2)}  ${x.clue.padEnd(22)} ${tail}`);
  }
  if (r.routes.length) {
    console.log(`\n  VÄGAR IN (led som återkommer i lösningarna — kandidater till spärrlistan)`);
    for (const rt of r.routes) {
      console.log(`    ${rt.element.padEnd(16)} ${rt.count} lösningar, kortaste ${rt.shortest} tecken`);
    }
    console.log(`    Spärra den billigaste vägen först och kör om — spärrar man alla blir ordet olösligt, inte svårt.`);
  }
  printDelta(entry.word, prev, record);
  console.log();
}

console.log('SAMMANFATTNING\n');
for (const s of report) {
  console.log(`  ${s.word.padEnd(14)} kortaste ${String(s.shortest ?? '-').padStart(2)}  lösningsgrad ${String(s.rate).padStart(3)}%  ${s.verdict}`);
}
const bad = report.filter((s) => s.verdict !== 'BRA');
console.log(`\n${bad.length}/${report.length} ord behöver ses över.`);

if (opts.save) {
  console.log(`\nSparat i ${opts.out}/ — ett filnamn per ord, en post per körning.`);

  const index = store.index();
  if (index.length > report.length) {
    console.log(`\nALLA ORD SOM TESTATS (${index.length} st, senaste körningen per ord)\n`);
    for (const row of index) {
      const mark = row.verdict === 'BRA' ? ' ' : '!';
      console.log(
        `  ${mark} ${row.word.padEnd(14)} kortaste ${String(row.shortest ?? '-').padStart(2)}` +
        `  ${String(row.rate).padStart(3)}%  ${row.verdict.padEnd(21)} ${row.runs} körning${row.runs === 1 ? '' : 'ar'}`,
      );
    }
  }
}

if (opts.json) {
  fs.writeFileSync(opts.json, JSON.stringify(report, null, 2));
  console.log(`\nOckså sparat samlat till ${opts.json}`);
}
