#!/usr/bin/env node
// Lägger språkprefixet på en dags nycklar.
//
//   npm run migrate:locale -- 2026-08-11 288
//   npm run migrate:locale -- 2026-08-11 288 --apply
//
// De två utgåvorna kan dela databas, och båda skrev till "2026-08-11:0" — två
// olika ord, en topplista. Nu heter nycklarna "sv:..." respektive "en:...".
// Ändringen föräldralöser det som redan skrivits under de gamla namnen, och
// det här flyttar över en namngiven dag.
//
// Bara svenska behöver det: engelskan har aldrig skrivit något ännu.
//
// Behöver databasens REST-uppgifter. Båda namnsätten fungerar:
//   KV_REST_API_URL / KV_REST_API_TOKEN                (Vercels namn)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash egna)
//
// Vercel märker integrationsuppgifter "Sensitive" och visar dem aldrig igen —
// men Upstash, som utfärdat dem, gör det: Vercel → Storage → din databas →
// Open in Upstash → fliken REST API.

import { ensureEnv } from './env.mjs';

const [date, indexArg, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const index = Number(indexArg);
const PREFIX = process.env.ORDKNAPP_LOCALE || 'sv';

if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isInteger(index)) {
  console.error('Användning: npm run migrate:locale -- <datum> <ordindex> [--apply]');
  console.error('  t.ex.     npm run migrate:locale -- 2026-08-11 288');
  console.error('\nOrdindex är ordets plats i banken den dagen. Är du osäker:');
  console.error("  node -e \"import('./server/words.js').then(m=>console.log(m.wordForDate('2026-08-11')))\"");
  process.exit(2);
}

const ok = await ensureEnv(
  [
    { name: 'KV_REST_API_URL', label: 'REST-URL', alt: ['UPSTASH_REDIS_REST_URL'] },
    { name: 'KV_REST_API_TOKEN', label: 'REST-token', alt: ['UPSTASH_REDIS_REST_TOKEN'] },
  ],
  {
    intro: 'Behöver databasens REST-uppgifter.\n\n'
      + 'Kan Vercel inte visa dem (de är märkta "Sensitive") så finns de i källan:\n'
      + '  Vercel → Storage → din databas → Open in Upstash → fliken REST API.\n\n'
      + 'Klistra in hela raden om du vill; prefix och citattecken städas bort.',
  },
);

const url = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (!ok || !url || !token) {
  console.error('\nSaknar KV_REST_API_URL och KV_REST_API_TOKEN.');
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

const from = `${date}:${index}`;
const to = `${PREFIX}:${from}`;

console.log(`Flyttar ${from} → ${to}`);
console.log(apply ? 'SKARPT LÄGE\n' : 'TORRKÖRNING — inget skrivs\n');

// Exakta nycklar plus två mönster, eftersom försök och ledtrådscache har en
// svans per spelare respektive per ledtråd.
const exact = [`best:${from}`, `bestclue:${from}`];
const patterns = [`att:${from}:*`, `clue:${from}:*`];

const keys = [];
for (const key of exact) {
  if (await cmd('EXISTS', key)) keys.push(key);
}
for (const pattern of patterns) {
  let cursor = '0';
  do {
    const [next, found] = await cmd('SCAN', cursor, 'MATCH', pattern, 'COUNT', '200');
    cursor = next;
    keys.push(...(found ?? []));
  } while (cursor !== '0');
}

if (!keys.length) {
  console.log('Hittade inga nycklar för den dagen. Inget att flytta.');
  process.exit(0);
}

console.log(`${keys.length} nycklar att flytta:`);
for (const key of keys) console.log(`  ${key}`);

if (!apply) {
  console.log('\nKör med --apply för att flytta dem.');
  process.exit(0);
}

// RENAMENX skriver aldrig över något som redan finns på målnamnet — kör man
// skriptet två gånger ska den andra körningen inte rasera den första.
let moved = 0;
let skipped = 0;
for (const key of keys) {
  const target = key.replace(from, to);
  const result = await cmd('RENAMENX', key, target);
  if (Number(result) === 1) moved++;
  else {
    skipped++;
    console.log(`  hoppade över ${key} — ${target} fanns redan`);
  }
}
console.log(`\nFlyttade ${moved} nycklar${skipped ? `, hoppade över ${skipped}` : ''}.`);
console.log('Ladda om sidan — dagens topplista ska vara tillbaka.');
