#!/usr/bin/env node
// Re-plans the daily schedule after words have been added.
//
//   npm run rotation              visa vad som skulle ändras
//   npm run rotation -- --apply   skriv om server/locales/sv/rotation.js
//
// The rule this exists to keep: a day that has already been played must never
// change its word. Everything from today backwards is copied across untouched;
// only the future is re-planned, which is free because nobody has played it.
//
// Appending new words to the end of the array would also be safe, but they
// would then wait out the whole remaining cycle — over a year — before anyone
// saw them. Re-planning the tail lets a new batch start appearing tomorrow
// while still leaving played days alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORDS } from '../server/words.js';
import { ROTATION, ROTATION_EPOCH } from '../server/locales/sv/rotation.js';
import { dayNumber, todayInZone } from '../server/util.js';
import { LOCALE } from '../server/locale.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'server', 'rotation.js');
const apply = process.argv.includes('--apply');

const STRIDE = 97; // coprime with most bank sizes; only used to spread themes

const today = dayNumber(todayInZone(LOCALE.timeZone));
const frozenCount = Math.max(0, Math.min(ROTATION.length, today - ROTATION_EPOCH + 1));
const frozen = ROTATION.slice(0, frozenCount);

// Everything not already spoken for, spread by the stride so consecutive days
// don't come from the same themed block of the bank.
const used = new Set(frozen);
const rest = [];
for (let i = 0, seen = 0; seen < WORDS.length; i++) {
  const idx = (i * STRIDE) % WORDS.length;
  if (i >= WORDS.length) break;
  seen++;
  if (!used.has(idx)) rest.push(idx);
}
for (let i = 0; i < WORDS.length; i++) if (!used.has(i) && !rest.includes(i)) rest.push(i);

const next = [...frozen, ...rest];

// ---------------------------------------------------------------------------

const permutationOk = next.length === WORDS.length && new Set(next).size === WORDS.length;
const dayAt = (schedule, day) => {
  const n = schedule.length;
  return schedule[(((day - ROTATION_EPOCH) % n) + n) % n];
};

console.log(`Banken har ${WORDS.length} ord · schemat har ${ROTATION.length} platser`);
console.log(`Låsta dagar (till och med idag): ${frozenCount}`);
console.log(`Nya platser att lägga till: ${WORDS.length - ROTATION.length}\n`);

let moved = 0;
for (let d = ROTATION_EPOCH; d <= today; d++) {
  if (dayAt(ROTATION, d) !== dayAt(next, d)) moved++;
}
console.log(moved === 0
  ? '✓ Ingen spelad dag flyttas.'
  : `✖ ${moved} spelade dagar skulle flytta — det får inte hända, avbryter.`);
if (!permutationOk) console.log('✖ Det nya schemat är inte en permutation av banken.');

console.log('\nKommande dagar:');
for (let i = 0; i < 7; i++) {
  const d = today + i;
  const before = WORDS[dayAt(ROTATION, d)]?.word ?? '—';
  const after = WORDS[dayAt(next, d)]?.word ?? '—';
  const when = i === 0 ? 'idag' : `+${i}`;
  console.log(`  ${when.padEnd(5)} ${before.padEnd(14)}${before === after ? '' : `→ ${after}`}`);
}

if (moved > 0 || !permutationOk) process.exit(1);
if (!apply) {
  console.log('\nKör med --apply för att skriva om server/locales/sv/rotation.js.');
  process.exit(0);
}

const src = fs.readFileSync(file, 'utf8');
const header = src.slice(0, src.indexOf('export const ROTATION_EPOCH'));
const rows = [];
for (let i = 0; i < next.length; i += 16) rows.push('  ' + next.slice(i, i + 16).join(', ') + ',');
fs.writeFileSync(file, `${header}export const ROTATION_EPOCH = ${ROTATION_EPOCH};\n\nexport const ROTATION = [\n${rows.join('\n')}\n];\n`);
console.log(`\nSkrev ${next.length} platser till server/locales/sv/rotation.js. Kör \`npm test\`.`);
