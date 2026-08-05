#!/usr/bin/env node
// Moves a day's stored results from the old date-only keys to the new
// (date, word index) keys.
//
//   npm run migrate:puzzle -- 2026-08-05 158
//   npm run migrate:puzzle -- 2026-08-05 158 --apply
//
// Scoping a day's data by date alone was a bug: growing the word bank changes
// which word a date maps to, so the day's leaderboard could end up belonging to
// a word nobody was playing. Fixing it changed the keys, which orphaned
// whatever had already been written under the old ones. This carries that
// across — once, for a named day and the word it was actually played with.
//
// Needs the KV credentials in .env:
//   KV_REST_API_URL=...
//   KV_REST_API_TOKEN=...
// Both are in the Vercel dashboard under Storage → your KV store → .env.local.

import { WORDS } from '../server/words.js';

try { process.loadEnvFile('.env'); } catch { /* fall back to the environment */ }

const [date, indexArg, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const index = Number(indexArg);

if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isInteger(index)) {
  console.error('Användning: npm run migrate:puzzle -- <datum> <ordindex> [--apply]');
  console.error('  t.ex.     npm run migrate:puzzle -- 2026-08-05 158');
  console.error('\nOrdindex är ordets plats i banken den dagen. Är du osäker:');
  console.error('  node -e "import(\'./server/words.js\').then(m=>console.log(m.WORDS.findIndex(w=>w.word===\'stövel\')))"');
  process.exit(2);
}

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error('Saknar KV_REST_API_URL och KV_REST_API_TOKEN.');
  console.error('Hämta dem i Vercel: Storage → din KV-databas → .env.local, och klistra in i .env.');
  process.exit(2);
}

async function cmd(...command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV ${command[0]} misslyckades: ${res.status}`);
  return (await res.json()).result;
}

const from = date;
const to = `${date}:${index}`;
const word = WORDS[index]?.word ?? '(okänt ord)';
const TTL = 60 * 60 * 24 * 40;

console.log(`Flyttar ${from} → ${to}  (ord: ${word})`);
console.log(apply ? 'SKARPT LÄGE\n' : 'TORRKÖRNING — inget skrivs\n');

// --- scores ---------------------------------------------------------------
const flat = await cmd('ZRANGE', `best:${from}`, '0', '-1', 'WITHSCORES');
const scores = [];
for (let i = 0; i < (flat?.length ?? 0); i += 2) scores.push({ pid: flat[i], score: Number(flat[i + 1]) });

const clues = scores.length
  ? await cmd('HMGET', `bestclue:${from}`, ...scores.map((s) => s.pid))
  : [];

console.log(`  ${scores.length} resultat på den gamla nyckeln`);
for (const [i, s] of scores.entries()) {
  console.log(`    ${String(s.score).padStart(3)}  ${clues?.[i] ?? '(ingen ledtråd)'}`);
}

// --- attempts -------------------------------------------------------------
// SCAN, because attempt keys are per player. The pattern also matches keys
// that are already migrated (att:<date>:<index>:<pid>), so only the ones whose
// remainder is a bare player id are ours.
const attempts = [];
let cursor = '0';
do {
  const [next, keys] = await cmd('SCAN', cursor, 'MATCH', `att:${from}:*`, 'COUNT', '200');
  cursor = next;
  for (const key of keys ?? []) {
    const rest = key.slice(`att:${from}:`.length);
    if (/^[a-f0-9]{32}$/.test(rest)) attempts.push({ key, pid: rest });
  }
} while (cursor !== '0');
console.log(`  ${attempts.length} spelare med förbrukade försök`);

if (!scores.length && !attempts.length) {
  console.log('\nInget att flytta. Antingen är dagen redan migrerad, eller så fanns aldrig någon data (ingen KV kopplad då).');
  process.exit(0);
}

if (!apply) {
  console.log('\nKör om med --apply för att skriva.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// ZADD LT and HSET are the same primitives recordBest uses, so a migration can
// only ever improve a player's stored score — never replace a better one that
// was set under the new key in the meantime.
for (const { pid, score } of scores) {
  await cmd('ZADD', `best:${to}`, 'LT', String(score), pid);
}
for (const [i, s] of scores.entries()) {
  const clue = clues?.[i];
  if (clue == null) continue;
  const now = Number(await cmd('ZSCORE', `best:${to}`, s.pid));
  // Only attach the clue if this score is the one that ended up holding the
  // record, exactly as recordBest does — otherwise a row could show a clue
  // that does not match its number.
  if (now === s.score) await cmd('HSET', `bestclue:${to}`, s.pid, clue);
}
if (scores.length) {
  await cmd('EXPIRE', `best:${to}`, TTL);
  await cmd('EXPIRE', `bestclue:${to}`, TTL);
}

for (const { key, pid } of attempts) {
  const n = await cmd('GET', key);
  const existing = Number(await cmd('GET', `att:${to}:${pid}`)) || 0;
  // Keep whichever count is higher: attempts are spent, and the migration must
  // not hand anyone extra tries.
  const keep = Math.max(Number(n) || 0, existing);
  await cmd('SET', `att:${to}:${pid}`, String(keep));
  await cmd('EXPIRE', `att:${to}:${pid}`, TTL);
}

console.log(`\nKlart: ${scores.length} resultat och ${attempts.length} försöksräknare flyttade.`);
console.log('Gamla nycklar lämnas kvar och försvinner av sig själva efter 40 dagar.');
