#!/usr/bin/env node
// Regenerates server/data/en-lemmas-*.txt. Run with: npm run build:lemmas:en
//
// The generated lists are committed, so neither the build nor the deploy
// depends on this script.
//
// Source: WordNet 3.1 via the `wordnet-db` package (MIT packaging; WordNet
// itself is distributed under Princeton's permissive licence, reproduced in
// server/data/en-lemmas.LICENSE).
//
// WHY A SECOND LIST. en-words-*.txt is a full-form list: it answers "is this
// English", which is what a guess has to pass first. It cannot answer "is this
// a BASE form", because "churches" and "gravs" are English too — and the
// guesser is asked for base forms. That question needed a heuristic while the
// only data was a full-form list; WordNet indexes lemmas, so it can be answered
// exactly instead. A real word that is not a lemma is an inflected form, by
// definition rather than by inference.
//
// Only single-word, purely alphabetic lemmas are kept: WordNet also carries
// multi-word entries ("ice_cream") and names, neither of which can ever be a
// one-word guess.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'server', 'data');

let dictDir;
try {
  dictDir = require('wordnet-db').path;
} catch {
  console.error('wordnet-db is not installed. Run: npm install --no-save wordnet-db');
  process.exit(1);
}

const MIN_LEN = 2;
const MAX_LEN = 12;
const POS_FILES = ['noun', 'verb', 'adj', 'adv'];

const buckets = new Map();
const counts = {};
for (const pos of POS_FILES) {
  let kept = 0;
  for (const line of fs.readFileSync(path.join(dictDir, `index.${pos}`), 'utf8').split('\n')) {
    // The file opens with a licence header; those lines start with a space.
    if (!line || line.startsWith(' ')) continue;
    const lemma = line.split(' ')[0];
    if (!/^[a-z]+$/.test(lemma)) continue;
    const len = lemma.length;
    if (len < MIN_LEN || len > MAX_LEN) continue;
    if (!buckets.has(len)) buckets.set(len, new Set());
    buckets.get(len).add(lemma);
    kept++;
  }
  counts[pos] = kept;
}

fs.mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [len, set] of [...buckets].sort((a, b) => a[0] - b[0])) {
  const words = [...set].sort();
  fs.writeFileSync(path.join(outDir, `en-lemmas-${len}.txt`), `${words.join('\n')}\n`);
  total += words.length;
}
console.log(Object.entries(counts).map(([p, n]) => `${p}: ${n}`).join('  '));
console.log(`${total} distinct lemmas written across lengths ${MIN_LEN}–${MAX_LEN}.`);
