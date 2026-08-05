#!/usr/bin/env node
// Turns probe results into per-word character limits in server/words.js.
//
//   npm run limits              visa vad som skulle ändras (ändrar inget)
//   npm run limits -- --apply   skriv ändringarna
//
// The probe measures how long a working clue actually has to be for a given
// word (see suggestedLimit in server/util.js). This applies those measurements
// to the bank, so the cap stops being one number guessed for 376 different
// words and becomes a property of each word.
//
// Editing is line-oriented on purpose. Every bank entry is written on a single
// line, so a limit can be inserted or replaced without parsing or re-printing
// the file — which would reflow the whole bank and lose its comments, its theme
// grouping and the readability the hand-authoring depends on.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORDS } from '../server/words.js';
import { clueLimitFor, normalize } from '../server/util.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const wordsFile = path.join(root, 'server', 'words.js');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
// Resolved against the working directory, like the probe's own --out, so the
// two agree about where results live. path.resolve leaves an absolute path
// alone; path.join would have nailed it onto the repo root.
const dir = (() => {
  const i = argv.indexOf('--out');
  return path.resolve(i >= 0 ? argv[i + 1] : 'probe-results');
})();

// ---------------------------------------------------------------------------

/** Latest run per word, from whatever the probe has stored. */
function latestRuns() {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    console.error(`Hittade inga probe-resultat i ${path.relative(root, dir)}/.`);
    console.error('Kör t.ex.:  npm run probe -- stövel vulkan');
    process.exit(2);
  }
  const runs = new Map();
  for (const f of files) {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const last = h.runs?.[h.runs.length - 1];
      if (last?.word) runs.set(normalize(last.word), last);
    } catch {
      console.warn(`Kunde inte läsa ${f} — hoppar över den.`);
    }
  }
  return runs;
}

/**
 * Rewrite one bank line's limit. Returns null when the line already says the
 * right thing, so an unchanged file stays byte-identical.
 */
function setLimit(line, limit) {
  if (/\blimit:\s*\d+/.test(line)) {
    const next = line.replace(/\blimit:\s*\d+/, `limit: ${limit}`);
    return next === line ? null : next;
  }
  // Insert after the forbidden array, keeping the existing field order.
  const next = line.replace(/(forbidden:\s*\[[^\]]*\])/, `$1, limit: ${limit}`);
  return next === line ? null : next;
}

const runs = latestRuns();
const source = fs.readFileSync(wordsFile, 'utf8');
const lines = source.split('\n');

const changes = [];
const skipped = [];

for (const entry of WORDS) {
  const run = runs.get(normalize(entry.word));
  if (!run) continue;

  if (run.verdict?.startsWith('OSÄKER')) {
    skipped.push({ word: entry.word, why: 'osäker mätning — kör om ordet' });
    continue;
  }
  if (run.suggestedLimit == null) {
    // Nothing solved the word, so the probe has no evidence about length.
    // Leaving the limit alone is the honest move; the word needs a looser
    // forbidden list, not a number.
    skipped.push({ word: entry.word, why: 'inget löste ordet' });
    continue;
  }

  const current = clueLimitFor(entry);
  if (current === run.suggestedLimit) continue;

  const idx = lines.findIndex((l) => l.includes(`word: '${entry.word}'`));
  if (idx < 0) {
    skipped.push({ word: entry.word, why: 'hittade inte raden i words.js' });
    continue;
  }
  const rewritten = setLimit(lines[idx], run.suggestedLimit);
  if (!rewritten) {
    skipped.push({ word: entry.word, why: 'kunde inte skriva om raden' });
    continue;
  }

  changes.push({ word: entry.word, from: current, to: run.suggestedLimit, idx, rewritten, run });
}

// ---------------------------------------------------------------------------

console.log(`${runs.size} ord har probe-resultat · ${changes.length} skulle ändras\n`);

if (changes.length) {
  console.log('  ord            gräns          kortaste lösning   omdöme');
  for (const c of changes) {
    const dir = c.to > c.from ? '↑' : '↓';
    console.log(
      `  ${c.word.padEnd(14)} ${String(c.from).padStart(2)} → ${String(c.to).padStart(2)} ${dir}` +
      `        ${String(c.run.shortest ?? '-').padStart(2)}          ${c.run.verdict}`,
    );
  }
}

if (skipped.length) {
  console.log('\nHoppade över:');
  for (const s of skipped) console.log(`  ${s.word.padEnd(14)} ${s.why}`);
}

if (!apply) {
  console.log(changes.length ? '\nKör med --apply för att skriva ändringarna.' : '\nInget att göra.');
  process.exit(0);
}

if (!changes.length) process.exit(0);

for (const c of changes) lines[c.idx] = c.rewritten;
fs.writeFileSync(wordsFile, lines.join('\n'));
console.log(`\nSkrev ${changes.length} ändringar till server/words.js.`);
console.log('Kör `npm test` — banken har invarianter som fångar en trasig rad.');
