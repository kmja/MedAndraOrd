import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalize } from './util.js';
import { LOCALE } from './locale.js';

// The word list for the language being played, used to judge the AI's *guess*
// — never the player's clue.
// That distinction matters: requiring dictionary words from players would ban
// exactly the invented compounds and unusual imagery the game is for. The
// guesser, by contrast, is explicitly told to answer with a real established
// word in base form, so checking it against a dictionary is precisely the rule.
//
// Replaces what used to be a second model call, which is what keeps every
// outcome at one request.
//
// One list per locale, named <code>-words-<length>.txt, chosen by the active
// locale. Each list ships its own licence beside it in server/data/.
// Regenerate with `npm run build:dictionary`.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

// Sharded by word length. A guess is length-checked before the dictionary is
// consulted, and a day has exactly one target length, so a running instance
// touches one shard — loading the whole 5.5 MB list would cost ~950 ms of cold
// start for no benefit.
const _shards = new Map(); // `${kind}:${len}` -> Set | null (null = unavailable)

function shard(kind, len) {
  const key = `${kind}:${len}`;
  if (_shards.has(key)) return _shards.get(key);
  let set = null;
  try {
    const raw = fs.readFileSync(path.join(DIR, `${LOCALE.code}-${kind}-${len}.txt`), 'utf8');
    set = new Set(raw.split('\n').filter(Boolean));
  } catch (err) {
    // A missing shard for a length we have no words for is normal, and a
    // language with no lemma list at all is normal too — see isBaseForm.
    // Anything else means the data did not ship, and callers fail open.
    if (err.code !== 'ENOENT') console.error(`dictionary shard failed (${key}):`, err.message);
  }
  _shards.set(key, set);
  return set;
}

/** Words available for a given length. Exposed for diagnostics and tests. */
export function dictionarySize(len) {
  if (len != null) return shard('words', len)?.size ?? 0;
  let total = 0;
  for (let l = 2; l <= 12; l++) total += shard('words', l)?.size ?? 0;
  return total;
}

/**
 * Is this a real word in the language being played?
 * Returns true/false, or null when the word list could not be read — callers
 * treat null as "unknown" and fail open, exactly as the old model-based
 * verifier did.
 */
export function isRealWord(word) {
  const w = normalize(word);
  if (!w) return false;
  const set = shard('words', [...w].length);
  if (set === null) return null; // data missing → unknown, not "fake"
  return set.has(w);
}

/**
 * Is this word a BASE form — a lemma — rather than an inflection of one?
 * Returns true/false, or null when the language has no lemma list.
 *
 * A separate question from isRealWord, and a separate list. The word list is
 * full-form, so it says yes to "churches" and "gravs"; the guesser is asked for
 * base forms, and telling the two apart from a full-form list alone needs a
 * heuristic. Where a lemma list exists the answer is exact instead: a real word
 * that is not a lemma is an inflected form, by definition.
 *
 * Null is not a failure. Swedish has no lemma list, and callers fall back to
 * the heuristic — see the locale's morphology.
 */
export function isBaseForm(word) {
  const w = normalize(word);
  if (!w) return false;
  const set = shard('lemmas', [...w].length);
  return set === null ? null : set.has(w);
}

// The old name, kept so nothing that imports it breaks mid-refactor. New code
// should use isRealWord — the function stopped being about Swedish when the
// language became a parameter.
export { isRealWord as isSwedishWord };
