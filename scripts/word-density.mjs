#!/usr/bin/env node
// Scores how CROWDED a target word's neighbourhood is.
//
//   npm run density                 -- score the English bank
//   npm run density -- anchor mirage lighthouse   -- score arbitrary words
//
// WHY THIS NUMBER.
//
// The obvious theory of difficulty is that specific or unusual words are
// harder. Mechanically it is closer to the opposite. What makes a clue have to
// work is how many OTHER words of the same length a vague clue could also land
// on — the guesser is told the letter count and the word class, so a target
// with no same-length rivals can be reached by pointing roughly at its area,
// while a target sitting in a crowd of same-length near-relatives forces the
// clue to distinguish it.
//
// So: siblings. Two words are siblings when they share a parent in WordNet's
// hierarchy — "anchor" and "grapnel" are both kinds of mooring hardware. A
// target with many same-length siblings is one where the category clue is not
// enough, which is exactly the property the game wants.
//
// This is a proxy, not a verdict. It says nothing about whether a word is
// evocative enough for a player to be clever with, and nothing about whether
// the AI happens to know an obscure route. The probe measures the real thing —
// the shortest clue that actually solves — and this is what you use to choose
// candidates worth probing.
//
// Nouns and verbs only. Adjectives have no hypernym hierarchy in WordNet, so
// they are reported as unscored rather than as zero.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let dictDir;
try {
  dictDir = require('wordnet-db').path;
} catch {
  console.error('wordnet-db is not installed. Run: npm install');
  process.exit(1);
}

/** lemma -> synset offsets, for one part of speech. */
function readIndex(pos) {
  const map = new Map();
  for (const line of fs.readFileSync(path.join(dictDir, `index.${pos}`), 'utf8').split('\n')) {
    if (!line || line.startsWith(' ')) continue;
    const parts = line.split(' ');
    const lemma = parts[0];
    if (!/^[a-z]+$/.test(lemma)) continue;
    // The offsets are the last synset_cnt fields on the line.
    const synsetCount = Number(parts[2]);
    map.set(lemma, parts.slice(-synsetCount));
  }
  return map;
}

/** offset -> { words, parents } for one part of speech. */
function readData(pos) {
  const map = new Map();
  for (const line of fs.readFileSync(path.join(dictDir, `data.${pos}`), 'utf8').split('\n')) {
    if (!line || line.startsWith(' ')) continue;
    const [head] = line.split(' | ');
    const f = head.split(' ');
    const offset = f[0];
    const wordCount = parseInt(f[3], 16);
    const words = [];
    for (let i = 0; i < wordCount; i++) words.push(f[4 + i * 2].toLowerCase());

    // Pointers follow the word list: a count, then four fields each.
    const pointerStart = 4 + wordCount * 2;
    const pointerCount = Number(f[pointerStart]);
    const parents = [];
    const children = [];
    for (let i = 0; i < pointerCount; i++) {
      const at = pointerStart + 1 + i * 4;
      const symbol = f[at];
      const target = f[at + 1];
      // @ and @i are hypernym (parent); ~ and ~i are hyponym (child).
      if (symbol === '@' || symbol === '@i') parents.push(target);
      if (symbol === '~' || symbol === '~i') children.push(target);
    }
    map.set(offset, { words, parents, children });
  }
  return map;
}

const INDEX = { noun: readIndex('noun'), verb: readIndex('verb') };
const DATA = { noun: readData('noun'), verb: readData('verb') };

/**
 * Every word sharing a parent with this one. Walks up one level and back down,
 * which is the level at which a category clue stops distinguishing.
 */
function siblingsOf(word, pos) {
  const offsets = INDEX[pos].get(word);
  if (!offsets) return null;
  const out = new Set();
  for (const offset of offsets) {
    const synset = DATA[pos].get(offset);
    if (!synset) continue;
    for (const parent of synset.parents) {
      for (const child of DATA[pos].get(parent)?.children ?? []) {
        for (const w of DATA[pos].get(child)?.words ?? []) {
          if (/^[a-z]+$/.test(w) && w !== word) out.add(w);
        }
      }
    }
  }
  return out;
}

function score(word, declaredClass) {
  const pos = declaredClass === 'verb' ? 'verb' : 'noun';
  if (declaredClass === 'adjective') return { word, unscored: true };
  const siblings = siblingsOf(word, pos);
  if (!siblings) return { word, unscored: true };
  const sameLength = [...siblings].filter((s) => s.length === word.length);
  return {
    word,
    siblings: siblings.size,
    rivals: sameLength.length,
    examples: sameLength.slice(0, 5),
  };
}

const args = process.argv.slice(2);
let entries;
if (args.length) {
  entries = args.map((w) => ({ word: w, class: undefined }));
} else {
  ({ WORDS: entries } = await import('../server/locales/en/words.js'));
}

const scored = entries.map((e) => ({ ...score(e.word, e.class), class: e.class ?? 'noun' }));
const rated = scored.filter((s) => !s.unscored).sort((a, b) => a.rivals - b.rivals);

console.log('RIVALS = same-length words sharing a parent. Higher is a harder target.\n');
console.log('rivals  sibs  word         same-length rivals');
for (const s of rated) {
  console.log(
    `${String(s.rivals).padStart(6)}  ${String(s.siblings).padStart(4)}  ${s.word.padEnd(12)} ${s.examples.join(', ')}`,
  );
}

const unscored = scored.filter((s) => s.unscored);
if (unscored.length) {
  console.log(`\nunscored (${unscored.length}): ${unscored.map((s) => s.word).join(', ')}`);
  console.log('  Adjectives have no hypernym hierarchy in WordNet, and a word absent');
  console.log('  from it cannot be placed at all.');
}

if (rated.length) {
  const rivals = rated.map((s) => s.rivals);
  const mean = rivals.reduce((a, b) => a + b, 0) / rivals.length;
  const lonely = rated.filter((s) => s.rivals === 0);
  console.log(`\n${rated.length} scored · mean ${mean.toFixed(1)} rivals · median ${rivals[Math.floor(rivals.length / 2)]}`);
  if (lonely.length) {
    console.log(`\n${lonely.length} with NO same-length rival — a clue pointing roughly at the`);
    console.log(`category has only one place to land: ${lonely.map((s) => s.word).join(', ')}`);
  }
}
