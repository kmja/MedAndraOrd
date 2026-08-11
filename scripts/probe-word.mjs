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
import { judgeClue, AiUnavailableError } from '../server/game.js';
import * as serverAi from '../server/ai.js';
import { classifyApiError, retryDelayMs } from '../server/ai.js';
import { isSwedishWord } from '../server/dictionary.js';
import { checkClueCode, extractWord } from '../server/util.js';
import { LOCALE } from '../server/locale.js';
import { loadEnv, ensureEnv } from './env.mjs';
import { clueLength, letterCount, normalize, suggestedLimit, clueLimitFor, CLUE_LIMIT_CEILING } from '../server/util.js';

// ---------------------------------------------------------------------------
// arguments

const argv = process.argv.slice(2);
const opts = {
  clues: 12, dry: false, json: null, bank: 0, words: [], custom: [],
  out: 'probe-results', save: true, batch: 0, batchCheck: false,
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
  else if (a === '--batch') opts.batch = Number(argv[i + 1]?.match(/^\d+$/) ? argv[++i] : 6);
  else if (a === '--batch-check') opts.batchCheck = true;
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
  --json <fil>     extra samlad dump av just den här körningen
  --batch [n]      bedöm n ledtrådar per anrop (default 6) — billigare, men
                   ledtrådarna delar kontext, så mätningen kan bli optimistisk
  --batch-check    kör samma ledtrådar båda vägarna och mät skillnaden`);
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
loadEnv();

/**
 * Ask for the key rather than explaining how to create a dotfile. Writing
 * .env by hand is the step most likely to go wrong for someone who doesn't
 * live in a terminal — on Windows PowerShell a redirect even writes UTF-16,
 * which parses as garbage. Only offered on a real terminal; CI keeps the
 * plain error.
 */
async function askForKey() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Ingen GEMINI_API_KEY hittades.\n');
    console.log('Hämta en på https://aistudio.google.com/apikey (Create API key) och klistra in den här.');
    console.log('Nyckeln syns när du klistrar in den — den skrivs bara till .env, som är gitignorerad.\n');
    const key = (await rl.question('Nyckel: ')).trim();
    if (!key) return null;

    const save = (await rl.question('Spara i .env så du slipper klistra in den igen? [J/n] ')).trim().toLowerCase();
    if (['', 'j', 'ja', 'y', 'yes'].includes(save)) {
      const line = `GEMINI_API_KEY=${key}\n`;
      // Append rather than overwrite: .env may already hold other settings.
      fs.appendFileSync('.env', fs.existsSync('.env') ? `\n${line}` : line);
      console.log('Sparad i .env.\n');
    }
    return key;
  } catch {
    // Ctrl+C, Ctrl+D or a closed pipe. Someone who isn't comfortable in a
    // terminal should get a sentence, not a Node stack trace.
    console.log('\nAvbrutet.');
    return null;
  } finally {
    rl.close();
  }
}

let apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!apiKey && process.stdin.isTTY) {
  apiKey = await askForKey();
  // Back into the environment, not just into this file's client. server/ai.js
  // builds its own client from process.env, so a key that only lived here left
  // the guesser unauthenticated — it fell through to Google's default
  // credentials and every guess failed, while the proposal call worked fine.
  if (apiKey) process.env.GEMINI_API_KEY = apiKey;
}
if (!apiKey) {
  console.error('\nSätt GEMINI_API_KEY — i .env eller i miljön:\n  GEMINI_API_KEY=... npm run probe -- stövel');
  console.error('\nKör med --dry för att se omfattningen utan nyckel.');
  process.exit(2);
}
const ai = new GoogleGenAI({ apiKey });
const MODEL = process.env.ORDKNAPP_MODEL || 'gemini-3.1-flash-lite';

// ---------------------------------------------------------------------------
// quota
//
// The free tier is per-minute, so a run of any size will meet it. That is not
// an error to report and move past — it is a signal to wait, because the same
// call will succeed shortly. The live server retries twice and gives up fast,
// since a player is waiting; a probe is not in a hurry and can afford to sit
// out the rest of a minute.

const quota = { hits: 0, waited: 0, absorbed: 0, stop: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The free tier allows 15 requests per minute per model
// (GenerateRequestsPerMinutePerProjectPerModel-FreeTier). A single word with
// 12 clues is 13 calls, so an unpaced run walks straight into the wall and
// then spends a minute waiting — and worse, the calls that fail are not
// random, they are the ones at the end, which quietly biases whatever the run
// was measuring.
//
// So pace instead of react: hold a rolling window of send times and wait until
// there is room. Retrying is still there for the cases pacing can't predict —
// a shared project, or another client on the same key.
const RPM = Number(process.env.ORDKNAPP_RPM || 13); // a little under 15, for the retries pacing can't see
const sent = [];

async function paced() {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0] > 60_000) sent.shift();
    if (sent.length < RPM) { sent.push(now); return; }
    const wait = 60_000 - (now - sent[0]) + 250;
    process.stderr.write(`  · håller kvoten: väntar ${Math.ceil(wait / 1000)}s\n`);
    await sleep(wait);
  }
}

// Long enough to outlast a per-minute window, few enough to notice a quota
// that isn't coming back.
const MAX_WAITS = 4;
const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000];

/**
 * Run one API-shaped call, waiting out quota errors. Returns { ok, value } so
 * callers can distinguish "no answer" from "answered with nothing".
 */
async function withQuotaRetry(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      await paced();
      return { ok: true, value: await fn() };
    } catch (err) {
      const kind = classifyApiError(err);

      if (kind === 'auth') {
        // No amount of waiting fixes a bad key, and continuing would fail every
        // remaining word the same way.
        console.error(`\n  ✖ Nyckeln avvisades av API:et. Kontrollera GEMINI_API_KEY i .env.`);
        console.error(`    ${err.message?.slice(0, 160)}`);
        quota.stop = true;
        return { ok: false, kind };
      }

      if (kind !== 'rate_limit' && kind !== 'transient') return { ok: false, kind, err };

      quota.hits++;
      if (attempt >= MAX_WAITS) {
        console.error(`  ✖ ${label}: kvoten släppte inte efter ${MAX_WAITS} försök. Avbryter.`);
        quota.stop = true;
        return { ok: false, kind };
      }

      const wait = retryDelayMs(err) ?? BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      quota.waited += wait;
      const why = kind === 'rate_limit' ? 'Kvotgräns nådd (429)' : 'API:et svarar inte';
      console.error(`  ⏳ ${why} — väntar ${Math.round(wait / 1000)}s och försöker igen (${label})`);
      await sleep(wait);
    }
  }
}

// The probe reaches the guesser through judgeClue's `ai` seam, so it can wait
// out a quota without making the live game patient too.
const patientAi = {
  guardedGuesser: async (args) => {
    const r = await withQuotaRetry('gissning', async () => {
      let failure = null;
      const out = await serverAi.guardedGuesser({
        ...args,
        onFailure: (kind, err) => {
          failure = { kind, err };
          // Fires for every failed attempt, including ones the server's own
          // retry then recovers from. Counted separately: being throttled and
          // silently recovering is still worth knowing about, or a run looks
          // clean while sitting right on the quota.
          if (kind === 'rate_limit') quota.absorbed++;
        },
      });
      // guardedGuesser fails open and returns null, so the error never reaches
      // us as a throw. Rethrow the quota case ourselves, or the wait never
      // happens and the clue is written off as unanswerable.
      if (out == null && (failure?.kind === 'rate_limit' || failure?.kind === 'transient')) throw failure.err;
      if (out == null && failure?.kind === 'auth') throw failure.err;
      return out;
    });
    return r.ok ? r.value : null;
  },
};

// ---------------------------------------------------------------------------
// the adversarial player: sees everything, tries to win in as few characters
// as possible

async function proposeClues({ word, forbidden }) {
  const n = letterCount(word);
  const system = `Du är en av Sveriges vassaste spelare i ordspelet Ordknapp.

SÅ FUNGERAR DET: en BLIND AI ska gissa ett hemligt svenskt ord. Den ser BARA din ledtråd och hur många bokstäver ordet har — inget annat. Den vet inte vad ordet är, den ser inga andra ledtrådar, och den kan inte fråga.

POÄNGEN är antalet tecken, färre är bättre. MEN en ledtråd som inte får AI:n att gissa rätt är värd exakt noll, hur kort den än är. Du jagar alltså den kortaste ledtråd som FAKTISKT FUNGERAR — inte den kortaste ledtråden.

TESTET du måste ställa på varje förslag:
Av ALLA svenska ord på ${n} bokstäver — pekar min ledtråd ut just det här ordet, eller passar den lika bra på tjugo andra?
Ett ensamt allmänt ord klarar aldrig det testet. "gå", "väder", "skydd", "ben" passar på hundratals ord och gissas därför fel varje gång. Sådana förslag är bortkastade.

FORMEN: ledtråden måste bilda EN språklig enhet — ett ord, en sammansättning, en fras med huvudord och bestämningar, en sats. En uppräkning av fristående utpekanden ("rep gnista damm") är otillåten, hur väl den än pekar. Testet är grammatiskt, inte semantiskt, och handlar aldrig om antalet ord: "blött plask", "trögt skodon" och "en glimt av frost" är alla fraser och alla tillåtna.

VAD SOM FAKTISKT FUNGERAR:
- påhittade sammansättningar som beskriver saken ("kaninmat", "blomvatten")
- ett konkret sammanhang där saken är den självklara: platsen, situationen, vem som använder den
- kända exempel och egennamn
- oväntade bilder och sneda vinklar, som i ett kryptiskt korsord
- två ord som tillsammans smalnar av kraftigt, när ett ord inte räcker

REGLER: svenska; inte målordet eller dess böjningar; inte de spärrade orden; ingen översättning; inga stavnings- eller rimtrick; och inget ordled som bara ska fyllas i till en sammansättning.

Ge ${opts.clues} förslag med SPRIDNING i längd — några djärvt korta, några i mellanlängd, några längre och säkrare. Poängen är att hitta var gränsen går, så slösa inte alla förslag på samma längd.

För varje förslag: skriv kort varför just den pekar ut ordet och inget annat. Om du inte kan motivera det, är förslaget för vagt — byt ut det.

Svara ENDAST med JSON:
{"clues": [{"clue": "...", "why": "..."}, ...]}`;

  const user = `Hemligt ord: ${word} (${n} bokstäver)
Spärrade ord: ${forbidden.join(', ') || '(inga)'}`;

  const call = await withQuotaRetry(`förslag för ${word}`, () => ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: user }] }],
    config: {
      systemInstruction: system,
      // Room for the reasoning field — cutting it off mid-JSON loses the whole
      // proposal, and a truncated batch is the one failure that looks like a
      // hard word rather than a broken call.
      maxOutputTokens: 2200,
      temperature: 1,
      responseMimeType: 'application/json',
    },
  }));
  // An unanswered proposal call used to throw straight out of the run, taking
  // every word already measured with it. Now the word is skipped and the rest
  // of the run stands.
  if (!call.ok) return [];

  const text = call.value.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const raw = JSON.parse(m[0]).clues ?? [];
    return raw
      // Accept both shapes: the reasoning field is what we ask for, but a bare
      // string is a normal thing for a model to fall back to and there is no
      // reason to throw the run away over it.
      .map((c) => (typeof c === 'string' ? { clue: c, why: null } : { clue: c?.clue, why: c?.why ?? null }))
      .filter((c) => typeof c.clue === 'string' && clueLength(c.clue) > 0 && clueLength(c.clue) <= CLUE_LIMIT_CEILING);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// batched judging
//
// The probe's cost is one call per clue, because that is how the real game
// works: each clue is judged alone. Batching asks the model to judge several
// at once, which is cheaper but not the same measurement — the clues share a
// context, so the model can read them against each other. Several clues
// circling the same idea give away far more together than any of them does
// alone, and a clue that only "works" that way is not a clue that works.
//
// So batching is opt-in, and --batch-check measures what it costs in accuracy
// rather than leaving it to be assumed either way.

/** The deterministic half, unchanged: free, and identical in both modes. */
function codeVerdict(item) {
  const v = checkClueCode(item.clue, item.entry.word, item.entry.forbidden, CLUE_LIMIT_CEILING, LOCALE.morphology);
  return v ? { type: 'rejected', reason: v.reason, source: 'code' } : null;
}

/** Turn one batched ruling into a verdict, or null if it needs re-asking. */
function verdictFromRuling(ruling, entry) {
  if (!ruling) return null;
  if (ruling.legal === false) {
    return { type: 'rejected', reason: ruling.reason || 'Ledtråden bryter mot reglerna.', source: 'referee' };
  }
  const guess = extractWord(ruling.guess);
  if (!guess) return null;
  if (letterCount(guess) !== letterCount(entry.word)) return null; // wrong length — re-ask, with feedback
  if (normalize(guess) === normalize(entry.word)) return { type: 'correct', guess };
  if (isSwedishWord(guess) === false) return null;                 // confabulated — re-ask
  return { type: 'wrong', guess };
}

/**
 * Judge many clues with as few calls as possible.
 *
 * Anything the batch cannot answer cleanly falls through to the single-clue
 * path, which already knows how to re-prompt a wrong-length or invented guess.
 * Batching may therefore make a run cheaper or slower, but never wrong in a
 * way the single path would not also be.
 */
async function judgeBatched(items, size) {
  const out = new Map();
  const pending = [];

  for (const item of items) {
    const code = codeVerdict(item);
    if (code) out.set(item.id, code);
    else pending.push(item);
  }

  for (let i = 0; i < pending.length; i += size) {
    if (quota.stop) break;
    const chunk = pending.slice(i, i + size);
    const call = await withQuotaRetry(`batch ${1 + i / size}`, () =>
      serverAi.batchedGuesser({
        items: chunk.map((it) => ({ id: it.id, clue: it.clue, letterCount: letterCount(it.entry.word) })),
        onFailure: (kind) => { if (kind === 'rate_limit') quota.absorbed++; },
      }));

    const rulings = call.ok ? call.value : null;
    for (const it of chunk) {
      const v = rulings ? verdictFromRuling(rulings.get(it.id), it.entry) : null;
      if (v) out.set(it.id, v);
      else it.needsSingle = true;
    }
  }

  // Everything the batch could not settle, done properly one at a time.
  for (const it of pending) {
    if (out.has(it.id)) continue;
    if (quota.stop) break;
    try {
      out.set(it.id, await judgeClue({
        clue: it.clue, target: it.entry.word, forbidden: it.entry.forbidden,
        maxLength: CLUE_LIMIT_CEILING, ai: patientAi,
      }));
    } catch (err) {
      if (!(err instanceof AiUnavailableError)) throw err;
      out.set(it.id, { type: 'ai_unavailable', guess: null });
    }
  }
  return out;
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

/** Judge one word's clues one at a time — how the real game works. */
async function judgeOneByOne(entry, clues) {
  const results = [];
  for (const { clue, why } of clues) {
    try {
      // Measured against the ceiling, not the word's current limit. Probing
      // inside the existing limit would only ever confirm it: clues longer than
      // the setting would be rejected unread, so the evidence could never argue
      // for raising it. The suggestion has to see the whole space.
      const verdict = await judgeClue({
        clue, target: entry.word, forbidden: entry.forbidden, maxLength: CLUE_LIMIT_CEILING,
        // patientAi, not the default: this is what puts the call through the
        // pacing and the quota waits. Without it this path ran unpaced with
        // only the server's two short retries, so on a tight quota it lost
        // calls that the batched path — which did go through here — kept. A
        // calibration between the two then measured the wiring, not batching.
        ai: patientAi,
      });
      results.push({ clue, why, len: clueLength(clue), type: verdict.type, guess: verdict.guess, reason: verdict.reason });
    } catch (err) {
      // A run is a measurement, and losing every earlier clue because the last
      // one timed out would be the worst possible way to spend the calls. Note
      // it, keep going, and say so in the summary — a rate computed from a run
      // that half-failed must not read as a finding.
      if (!(err instanceof AiUnavailableError)) throw err;
      results.push({ clue, why, len: clueLength(clue), type: 'ai_unavailable', guess: null });
    }
  }
  return results;
}

/** The same clues, several per call. */
async function judgeInBatches(entry, clues, size) {
  const items = clues.map((c, i) => ({ id: i + 1, clue: c.clue, entry }));
  const verdicts = await judgeBatched(items, size);
  return clues.map((c, i) => {
    const v = verdicts.get(i + 1) ?? { type: 'ai_unavailable', guess: null };
    return { clue: c.clue, why: c.why, len: clueLength(c.clue), type: v.type, guess: v.guess, reason: v.reason };
  });
}

function summarise(clues, results) {
  const answered = results.filter((r) => r.type !== 'ai_unavailable');
  const solved = answered.filter((r) => r.type === 'correct').sort((a, b) => a.len - b.len);
  const rate = answered.length ? Math.round((solved.length / answered.length) * 100) : 0;
  const shortest = solved[0] ?? null;
  const thin = answered.length < Math.max(4, clues.length * 0.6);
  const verdict = thin
    ? 'OSÄKER (för få svar)'
    : !shortest ? 'FÖR SVÅR'
    : shortest.len <= 4 ? 'FÖR LÄTT'
    : rate >= 90 ? 'FÖR LÄTT (allt löser)'
    : 'BRA';
  return { answered, solved, rate, shortest, verdict, unavailable: results.length - answered.length };
}

async function probe(entry) {
  const clues = await proposeClues(entry);

  if (opts.batchCheck) {
    // The same clues, both ways. Anything the two disagree about is the cost
    // of batching, stated rather than assumed.
    const single = summarise(clues, await judgeOneByOne(entry, clues));
    const batched = summarise(clues, await judgeInBatches(entry, clues, opts.batch || 6));
    return { entry, clues, calibration: { single, batched }, ...single, results: [] };
  }

  const results = opts.batch
    ? await judgeInBatches(entry, clues, opts.batch)
    : await judgeOneByOne(entry, clues);

  // A verdict is a claim about the word. Too few answers and it is really a
  // claim about the run — say so instead of printing "FÖR SVÅR" for a word
  // that mostly hit the quota.
  const sum = summarise(clues, results);
  return {
    entry, results, clues,
    solved: sum.solved, shortest: sum.shortest, rate: sum.rate, verdict: sum.verdict,
    unavailable: sum.unavailable, answered: sum.answered.length,
    routes: routes(sum.solved, entry.forbidden),
  };
}

const e = estimate(targets.length);
const mode = opts.batchCheck
  ? 'kalibrering: båda vägarna'
  : opts.batch ? `batch om ${opts.batch} per anrop` : 'en ledtråd per anrop';
console.log(`Modell: ${MODEL} · ${targets.length} ord × ${opts.clues} ledtrådar · ${mode}`);
if (!opts.batchCheck) console.log(opts.batch ? '' : `~${e.min}–${e.max} anrop`);
console.log();
if (opts.batch && !opts.batchCheck) {
  console.log('OBS: batch delar kontext mellan ledtrådar, så resultaten kan vara optimistiska.');
  console.log('     Kör --batch-check en gång för att se hur mycket det rör sig om.\n');
}

const report = [];
const startedAt = new Date().toISOString();

for (const entry of targets) {
  if (quota.stop) {
    console.log(`Avbröt före ${entry.word} — se meddelandet ovan. Det som hann mätas är sparat.`);
    break;
  }
  // Read the history BEFORE this run is appended, or the comparison would be
  // against itself.
  const prev = opts.save ? store.read(entry.word)?.runs?.slice(-1)[0] ?? null : null;

  const r = await probe(entry);

  if (r.calibration) {
    const { single, batched } = r.calibration;
    const d = batched.solved.length - single.solved.length;
    console.log(`${entry.word.toUpperCase()} — KALIBRERING, samma ${r.clues.length} ledtrådar båda vägarna\n`);
    const line = (name, m) =>
      `  ${name.padEnd(12)} ${String(m.solved.length).padStart(2)} lösta av ${String(m.answered.length).padStart(2)} svarade` +
      ` · kortaste ${m.shortest?.len ?? '-'} · ${m.verdict}` +
      (m.unavailable ? `  ⚠ ${m.unavailable} utan svar` : '');
    console.log(line('en i taget', single));
    console.log(line(`batch (${opts.batch || 6})`, batched));

    // The two modes make very different numbers of calls — one per clue versus
    // one per batch — so on a tight quota the slower mode loses answers the
    // faster one keeps. That difference alone can produce the whole gap, and a
    // comparison between an interrupted run and a clean one measures the quota,
    // not the batching.
    if (Math.abs(single.unavailable - batched.unavailable) >= 2) {
      console.log(`\n  ⚠ OJÄMFÖRBART: lägena tappade olika många svar (${single.unavailable} mot ${batched.unavailable}).`);
      console.log(`  Skillnaden nedan kan lika gärna vara kvoten som batchningen. Kör om när kvoten är fri.`);
      console.log();
      continue;
    }

    if (d === 0) {
      console.log(`\n  Ingen skillnad på det här ordet. Batch ser ut att mäta samma sak — kör fler ord innan du litar på det.`);
    } else if (d > 0) {
      console.log(`\n  Batch löste ${d} fler. Ledtrådarna hjälper varandra i delad kontext, precis som befarat:`);
      console.log(`  mätningen blir för optimistisk och gränserna för snäva. Använd inte --batch för att sätta limit.`);
    } else {
      console.log(`\n  Batch löste ${-d} färre — modellen tappar fokus när den bedömer flera samtidigt.`);
      console.log(`  Också en snedvridning, åt andra hållet: ord ser svårare ut än de är.`);
    }
    const onlyBatch = batched.solved.filter((b) => !single.solved.some((x) => x.clue === b.clue));
    if (onlyBatch.length) {
      console.log(`\n  Löstes BARA i batch (misstänkta): ${onlyBatch.map((x) => `"${x.clue}"`).join(', ')}`);
    }
    console.log();
    continue;
  }

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
    unavailable: r.unavailable,
    currentLimit: clueLimitFor(entry),
    // No limit suggestion from a run that didn't get enough answers. The
    // limit decides whether real players can win the word; deriving it from a
    // handful of clues that survived a quota storm is how a word silently
    // becomes unwinnable.
    suggestedLimit: r.verdict.startsWith('OSÄKER') ? null : suggestedLimit(r.solved.map((s) => s.len)),
    solved: r.solved.map((s) => ({ clue: s.clue, len: s.len, why: s.why ?? null })),
    rejected: r.results.filter((x) => x.type === 'rejected').map((x) => ({ clue: x.clue, reason: x.reason })),
    missed: r.results.filter((x) => x.type === 'wrong').map((x) => ({ clue: x.clue, guess: x.guess })),
    routes: r.routes,
  };
  report.push(record);
  if (opts.save) store.append(entry.word, record);

  console.log(`${entry.word.toUpperCase()} (${letterCount(entry.word)} bokstäver)${entry.index < 0 ? '  [utanför banken]' : ''}`);
  console.log(`  spärrat: ${entry.forbidden.join(', ') || '(inget)'}`);
  console.log(`  ${r.solved.length}/${r.answered} löste ordet · kortaste ${r.shortest ? `"${r.shortest.clue}" (${r.shortest.len})` : '—'} · ${r.verdict}`);
  if (r.unavailable) {
    console.log(`  ⚠ ${r.unavailable} av ${r.results.length} ledtrådar fick inget svar från AI:n — siffrorna ovan bygger på resten.`);
  }
  console.log();
  for (const x of r.results) {
    const mark = x.type === 'correct' ? '✓' : x.type === 'rejected' ? '⊘' : x.type === 'ai_unavailable' ? '⚠' : '·';
    const tail = x.type === 'correct' ? ''
      : x.type === 'rejected' ? `⊘ ${x.reason ?? ''}`
      : x.type === 'ai_unavailable' ? '⚠ inget svar från AI:n'
      : `→ ${x.guess ?? x.type}`;
    console.log(`    ${mark} ${String(x.len).padStart(2)}  ${x.clue.padEnd(22)} ${tail}`);
    if (x.type === 'correct' && x.why) console.log(`         ${x.why}`);
  }
  if (r.routes.length) {
    console.log(`\n  VÄGAR IN (led som återkommer i lösningarna — kandidater till spärrlistan)`);
    for (const rt of r.routes) {
      console.log(`    ${rt.element.padEnd(16)} ${rt.count} lösningar, kortaste ${rt.shortest} tecken`);
    }
    console.log(`    Spärra den billigaste vägen först och kör om — spärrar man alla blir ordet olösligt, inte svårt.`);
  }
  if (record.suggestedLimit != null) {
    const same = record.suggestedLimit === record.currentLimit;
    console.log(`\n  TECKENGRÄNS  nu ${record.currentLimit} · föreslagen ${record.suggestedLimit}` +
      (same ? '  (oförändrad)' : '  — sätt limit i server/words.js, eller kör npm run limits'));
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

if (quota.hits || quota.absorbed) {
  const parts = [];
  if (quota.absorbed) parts.push(`${quota.absorbed} återförsöktes direkt`);
  if (quota.hits) parts.push(`${quota.hits} krävde väntan (${Math.round(quota.waited / 1000)}s totalt)`);
  console.log(`\nKVOT: ${quota.absorbed + quota.hits} kvotfel — ${parts.join(', ')}.`);
  console.log('     Du ligger nära gränsen. Kör färre ord åt gången, eller vänta en stund mellan körningar.');
}
if (report.some((r) => r.unavailable)) {
  console.log('Ord med ⚠ mättes på färre ledtrådar än begärt — siffrorna för dem är osäkrare.');
}
if (quota.stop) {
  console.log('\nKörningen avbröts i förtid. Resultaten ovan är kompletta för de ord som hanns med.');
  process.exitCode = 1;
}

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
