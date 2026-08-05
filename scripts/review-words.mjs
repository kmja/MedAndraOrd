#!/usr/bin/env node
// Audits the word bank for words that are too easy, and for forbidden lists
// that leave the obvious routes open.  Run with: npm run review:words
//
// The signal it measures is the compound route. Swedish compounds are the
// cheapest way to point at a word: for "stövel" a player can write "rid" and
// let the model reach ridstövel. So for every target we find every word in the
// dictionary that has it as a first or last element, take the *other* element,
// and ask which of those the forbidden list actually blocks.
//
// The shortest unblocked partner is an upper bound on how cheaply the word can
// be solved that way. A target with a three-letter opening is a target whose
// leaderboard will be a pile of three-letter clues.
//
// What this cannot see: whether a word has a famous named instance ("etna" for
// vulkan, "jan" for månad). That needs world knowledge — run review:words:ai
// for that half, which asks the model and costs a few cents.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORDS } from '../server/words.js';
import { normalize, clueLength, letterCount } from '../server/util.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'data');

function loadDictionary() {
  const words = [];
  for (const file of fs.readdirSync(dataDir)) {
    if (!/^sv-words-\d+\.txt$/.test(file)) continue;
    words.push(...fs.readFileSync(path.join(dataDir, file), 'utf8').split('\n').filter(Boolean));
  }
  return words;
}

/** Is this partner already blocked by the target's forbidden list? */
function isBlocked(partner, forbidden) {
  const p = normalize(partner);
  return forbidden.some((f) => p.includes(normalize(f)) || normalize(f).includes(p));
}

function review() {
  const dict = loadDictionary();
  const known = new Set(dict);

  // A compound element is itself a word. Without this the results are swamped
  // by inflections — "ns" from stjärnans, "de" from blommade — which nobody
  // can write as a clue. Swedish also glues elements with a linking -s-
  // (morots|röd), so try the form with and without it and keep whichever is
  // a real word.
  const asPartner = (raw, linkAtEnd) => {
    const stripped = linkAtEnd ? raw.replace(/s$/, '') : raw.replace(/^s/, '');
    for (const cand of [raw, stripped]) {
      if (cand.length >= 3 && known.has(cand)) return cand;
    }
    return null;
  };

  const rows = [];

  for (const { word, forbidden } of WORDS) {
    const t = normalize(word);
    const partners = new Map(); // partner -> example compound

    for (const w of dict) {
      if (w === t || w.length <= t.length) continue;
      let p = null;
      if (w.endsWith(t)) p = asPartner(w.slice(0, w.length - t.length), true);
      else if (w.startsWith(t)) p = asPartner(w.slice(t.length), false);
      if (p && !partners.has(p)) partners.set(p, w);
    }

    const all = [...partners.entries()].map(([partner, compound]) => ({ partner, compound }));
    const open = all.filter(({ partner }) => !isBlocked(partner, forbidden));
    open.sort((a, b) => clueLength(a.partner) - clueLength(b.partner));

    rows.push({
      word,
      letters: letterCount(word),
      partners: all.length,
      open: open.length,
      blocked: all.length - open.length,
      coverage: all.length ? (all.length - open.length) / all.length : 1,
      shortest: open.length ? clueLength(open[0].partner) : null,
      examples: open.slice(0, 4),
    });
  }
  return rows;
}

const rows = review();
const scored = rows.filter((r) => r.shortest != null);

// ---------------------------------------------------------------------------

const bucket = (r) => (r.shortest <= 3 ? 'mycket lätt' : r.shortest <= 4 ? 'lätt' : r.shortest <= 6 ? 'ok' : 'svår');
const counts = {};
for (const r of rows) counts[r.shortest == null ? 'ingen väg' : bucket(r)] = (counts[r.shortest == null ? 'ingen väg' : bucket(r)] ?? 0) + 1;

console.log(`ORDBANKSGRANSKNING — ${WORDS.length} ord, ${loadDictionary().length} ord i ordlistan\n`);
console.log('Kortaste oblockerade sammansättningsled:');
for (const k of ['mycket lätt', 'lätt', 'ok', 'svår', 'ingen väg']) {
  if (counts[k]) console.log(`  ${k.padEnd(12)} ${String(counts[k]).padStart(3)} ord`);
}

const weakest = scored.sort((a, b) => a.shortest - b.shortest || a.coverage - b.coverage).slice(0, 25);
console.log('\nSVAGASTE ORDEN (kortaste vägen in, och hur mycket spärrlistan täcker)\n');
console.log('  ord           len  kortaste  täckning  öppna vägar');
for (const r of weakest) {
  const ex = r.examples.map((e) => `${e.partner}→${e.compound}`).slice(0, 3).join(', ');
  console.log(
    `  ${r.word.padEnd(13)} ${String(r.letters).padStart(2)}   ${String(r.shortest).padStart(6)}  ${String(Math.round(r.coverage * 100)).padStart(6)}%  ${ex}`,
  );
}

const leaky = rows
  .filter((r) => r.partners >= 8)
  .sort((a, b) => a.coverage - b.coverage)
  .slice(0, 12);
console.log('\nSPÄRRLISTOR SOM TÄCKER MINST (av orden med många sammansättningar)\n');
for (const r of leaky) {
  console.log(
    `  ${r.word.padEnd(13)} ${String(Math.round(r.coverage * 100)).padStart(3)}% täckt — ${r.open}/${r.partners} vägar öppna, kortast ${r.shortest ?? '-'}`,
  );
}

const strongest = scored.slice().sort((a, b) => b.shortest - a.shortest).slice(0, 12);
console.log('\nSTARKASTE ORDEN (ingen billig sammansättningsväg)\n');
console.log('  ' + strongest.map((r) => `${r.word} (${r.shortest})`).join(', '));
