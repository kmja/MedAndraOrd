#!/usr/bin/env node
// Regenerates server/data/en-words-*.txt. Run with: npm run build:dictionary:en
//
// The generated lists are committed, so neither the build nor the deploy
// depends on this script — it exists to make the artifact reproducible.
//
// Source: the `word-list` package (MIT, © Sindre Sorhus), whose data comes from
// github.com/atebits/Words. It carries fully inflected forms, which is what
// this needs: the dictionary judges the AI's guess, and a guess like "churches"
// has to be recognised as a real word before the base-form check can decide it
// is not a lemma.
//
// Sharded and length-limited exactly like the Swedish list — a guess is
// length-checked before the dictionary is consulted, so a running instance
// only ever touches one shard.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'word-list', 'words.txt');
const outDir = path.join(root, 'server', 'data');

const MIN_LEN = 2;
const MAX_LEN = 12;

if (!fs.existsSync(source)) {
  console.error('word-list is not installed. Run: npm install --no-save word-list');
  process.exit(1);
}

const buckets = new Map();
let skipped = 0;
for (const raw of fs.readFileSync(source, 'utf8').split('\n')) {
  const w = raw.trim().toLowerCase();
  if (!w) continue;
  // Letters only. The list is clean, but an apostrophe or a digit slipping in
  // would become a "real word" the guesser could hide behind.
  if (!/^[a-z]+$/.test(w)) { skipped++; continue; }
  const len = w.length;
  if (len < MIN_LEN || len > MAX_LEN) continue;
  if (!buckets.has(len)) buckets.set(len, new Set());
  buckets.get(len).add(w);
}

fs.mkdirSync(outDir, { recursive: true });
let total = 0;
for (const [len, set] of [...buckets].sort((a, b) => a[0] - b[0])) {
  const words = [...set].sort();
  fs.writeFileSync(path.join(outDir, `en-words-${len}.txt`), `${words.join('\n')}\n`);
  total += words.length;
  console.log(`en-words-${len}.txt  ${String(words.length).padStart(6)} words`);
}
console.log(`\n${total} words written, ${skipped} non-alphabetic entries skipped.`);
