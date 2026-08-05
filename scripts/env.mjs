// Asking for credentials beats explaining how to write a dotfile.
//
// Editing .env by hand is the step most likely to go wrong for someone who
// doesn't live in a terminal: it is a hidden file, Finder won't show it, and on
// Windows PowerShell a redirect writes UTF-16 that parses as garbage. So the
// scripts ask, and offer to save what they're told.
//
// Only ever offered on a real terminal. CI and pipes get the plain error, since
// a prompt nobody can answer is just a hang.

import fs from 'node:fs';

/** Load .env if there is one. Missing or unreadable is fine — fall through. */
export function loadEnv(file = '.env') {
  try { process.loadEnvFile(file); } catch { /* fall back to the environment */ }
}

function append(file, lines) {
  const body = lines.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.appendFileSync(file, fs.existsSync(file) ? `\n${body}` : body);
}

/**
 * Make sure every named variable is set, asking for the missing ones.
 *
 * `vars` is [{ name, label, alt }]. `alt` lists other names that mean the same
 * thing — the same credential goes by different names depending on where it was
 * copied from, and demanding one spelling when the other is already set would
 * be asking for something the caller already has.
 *
 * Returns true once everything is present, false if the user cancelled or there
 * was no terminal to ask on — callers print their own guidance and exit.
 */
export async function ensureEnv(vars, { intro = '', file = '.env' } = {}) {
  loadEnv(file);
  const have = (v) => [v.name, ...(v.alt ?? [])].some((n) => process.env[n]);
  const missing = vars.filter((v) => !have(v));
  if (!missing.length) return true;
  if (!process.stdin.isTTY) return false;

  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (intro) console.log(`\n${intro}\n`);
    const collected = [];
    for (const v of missing) {
      const answer = (await rl.question(`${v.label ?? v.name}: `)).trim();
      if (!answer) { console.log('\nAvbrutet.'); return false; }
      // Paste-proof: people copy whole lines out of dashboards, quotes and all.
      const value = answer.replace(/^[A-Z_]+=/, '').replace(/^["']|["']$/g, '');
      process.env[v.name] = value;
      collected.push([v.name, value]);
    }

    const save = (await rl.question('\nSpara i .env så du slipper klistra in dem igen? [J/n] ')).trim().toLowerCase();
    if (['', 'j', 'ja', 'y', 'yes'].includes(save)) {
      append(file, collected);
      console.log(`Sparat i ${file}.\n`);
    }
    return true;
  } catch {
    // Ctrl+C or Ctrl+D. A sentence, not a stack trace.
    console.log('\nAvbrutet.');
    return false;
  } finally {
    rl.close();
  }
}
