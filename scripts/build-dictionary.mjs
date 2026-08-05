#!/usr/bin/env node
// Regenerates server/data/sv-words.txt. Run with: npm run build:dictionary
//
// The generated list is committed, so neither the build nor the deploy depends
// on this script — it exists to make the artifact reproducible and to make
// updating the dictionary a one-liner.
//
// Source: @cspell/dict-sv (GPL-3.0-or-later), which carries fully inflected
// forms — 2.19M of them. The alternative, dictionary-sv (LGPL-3.0), is a
// hunspell stem list, and stems alone drop ordinary base forms that happen to
// be affix-derived: lärare, källare, stege, kulle, pengar were all absent.
// Those would have been reported as AI confabulations, which is worse than the
// licence difference. Both packages stay in devDependencies so the choice is
// easy to revisit.
//
// Only lengths 2–12 are kept. A guess is length-checked against the target
// before the dictionary ever sees it, and the bank tops out at 9 letters, so
// longer entries can never be consulted — dropping them cuts the artifact by
// roughly three quarters.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { importTrie, iteratorTrieWords } from 'cspell-trie-lib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'node_modules', '@cspell', 'dict-sv');
const outDir = path.join(root, 'server', 'data');

if (!fs.existsSync(pkg)) {
  console.error('@cspell/dict-sv saknas. Kör: npm install --save-dev @cspell/dict-sv cspell-trie-lib');
  process.exit(1);
}

const MIN_LEN = 2;
const MAX_LEN = 12;
const WORD = /^[a-zåäöéèüáàóô]+$/;

const raw = zlib.gunzipSync(fs.readFileSync(path.join(pkg, 'Swedish.trie.gz'))).toString('utf8');
const trie = importTrie(raw.split('\n'));

const words = new Set();
let total = 0;
for (const w of iteratorTrieWords(trie.root ?? trie)) {
  total++;
  const lower = w.toLowerCase();
  if (lower.length >= MIN_LEN && lower.length <= MAX_LEN && WORD.test(lower)) words.add(lower);
}

// Sharded by word length. A guess is length-checked before the dictionary is
// consulted, and a given day has exactly one target length — so a running
// instance loads one shard, not the whole list. That turns a ~950 ms cold
// load into ~100 ms.
const byLength = new Map();
for (const w of words) {
  if (!byLength.has(w.length)) byLength.set(w.length, []);
  byLength.get(w.length).push(w);
}

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) {
  if (/^sv-words-\d+\.txt$/.test(f)) fs.unlinkSync(path.join(outDir, f));
}
const shards = [];
for (const [len, list] of [...byLength].sort((a, b) => a[0] - b[0])) {
  list.sort();
  fs.writeFileSync(path.join(outDir, `sv-words-${len}.txt`), list.join('\n') + '\n');
  shards.push(`${len}:${list.length}`);
}
const sorted = [...words];

// The licence travels with the data.
fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(outDir, 'sv-words.LICENSE'));
fs.writeFileSync(
  path.join(outDir, 'sv-words.SOURCE.md'),
  `# Källa för ordlistan

Genererad av \`npm run build:dictionary\` från **@cspell/dict-sv**.

- Licens: GPL-3.0-or-later (se \`sv-words.LICENSE\`)
- Filtrering: gemener, endast bokstäver, längd ${MIN_LEN}–${MAX_LEN}
- Antal ord: ${sorted.length} (av ${total} i källan), sparade som \`sv-words-<längd>.txt\`

Listan används **endast** för att bedöma AI:ns gissning, aldrig spelarens
ledtråd — att kräva ordboksord av spelaren skulle förbjuda just den
kreativitet spelet finns för.
`,
);

const bytes = fs.readdirSync(outDir)
  .filter((f) => /^sv-words-\d+\.txt$/.test(f))
  .reduce((sum, f) => sum + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`Skrev ${sorted.length} ord av ${total} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`Skärvor (längd:antal): ${shards.join(', ')}`);
