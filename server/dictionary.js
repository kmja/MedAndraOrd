import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from './util.js';

// Swedish word list, used to judge the AI's *guess* — never the player's clue.
// That distinction matters: requiring dictionary words from players would ban
// exactly the invented compounds and unusual imagery the game is for. The
// guesser, by contrast, is explicitly told to answer with a real established
// word in base form, so checking it against a dictionary is precisely the rule.
//
// Replaces what used to be a second model call, which is what keeps every
// outcome at one request.
//
// Source: Den Stora Svenska Ordlistan via the `dictionary-sv` package,
// LGPL-3.0, © Göran Andersson. Licence travels with the data in
// server/data/sv-words.LICENSE. Regenerate with `npm run build:dictionary`.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

// Sharded by word length. A guess is length-checked before the dictionary is
// consulted, and a day has exactly one target length, so a running instance
// touches one shard — loading the whole 5.5 MB list would cost ~950 ms of cold
// start for no benefit.
const _shards = new Map(); // length -> Set | null (null = shard unavailable)

function shard(len) {
  if (_shards.has(len)) return _shards.get(len);
  let set = null;
  try {
    const raw = fs.readFileSync(path.join(DIR, `sv-words-${len}.txt`), 'utf8');
    set = new Set(raw.split('\n').filter(Boolean));
  } catch (err) {
    // A missing shard for a length we have no words for is normal; anything
    // else means the data did not ship, and callers should fail open.
    if (err.code !== 'ENOENT') console.error('dictionary shard failed:', err.message);
  }
  _shards.set(len, set);
  return set;
}

/** Words available for a given length. Exposed for diagnostics and tests. */
export function dictionarySize(len) {
  if (len != null) return shard(len)?.size ?? 0;
  let total = 0;
  for (let l = 2; l <= 12; l++) total += shard(l)?.size ?? 0;
  return total;
}

/**
 * Is this a real Swedish word?
 * Returns true/false, or null when the word list could not be read — callers
 * treat null as "unknown" and fail open, exactly as the old model-based
 * verifier did.
 */
export function isSwedishWord(word) {
  const w = normalize(word);
  if (!w) return false;
  const set = shard([...w].length);
  if (set === null) return null; // data missing → unknown, not "fake"
  return set.has(w);
}
