import { letterCount, dayNumber } from './util.js';
import { LOCALE } from './locale.js';

// The accessors every language shares. The bank itself and the rotation that
// orders it live under locales/<code>/ — see server/locale.js.
//
// `class` is defaulted here rather than at each use, so the player, the prompt
// and the tests can never disagree about what an unlabelled entry is.

export const WORDS = LOCALE.words;
const { rotation: ROTATION, rotationEpoch: ROTATION_EPOCH } = LOCALE;


export function wordByIndex(idx) {
  const entry = WORDS[idx];
  if (!entry) return null;
  return {
    index: idx,
    word: entry.word,
    forbidden: entry.forbidden,
    letterCount: letterCount(entry.word),
    // Defaulted here rather than at each use, so the player, the prompt and
    // the tests can never disagree about what an unlabelled entry is. Only
    // verbs and adjectives are written down in a bank; everything else is a
    // noun. The label itself is the locale's, because it is shown to the player
    // and sent to the guesser in the language being played.
    class: entry.class ?? LOCALE.defaultWordClass,
    // Optional, and absent for every word that hasn't been probed yet —
    // clueLimitFor() falls back to the global default. Carried through here so
    // callers never have to reach back into WORDS for it.
    limit: entry.limit,
  };
}

/**
 * Deterministic daily rotation: same date → same word for everyone.
 *
 * The schedule is read from a committed array rather than computed from the
 * bank size. Computing it — `(dayNumber * STRIDE) % WORDS.length` — made every
 * date depend on how many words exist, so adding words silently rewrote the
 * calendar, today included, while people were mid-play. See server/rotation.js.
 */
export function wordForDate(dateStr) {
  const pos = dayNumber(dateStr) - ROTATION_EPOCH;
  const n = ROTATION.length;
  return wordByIndex(ROTATION[((pos % n) + n) % n]);
}

/**
 * A random word for practice mode, never today's — practising on the live word
 * would be a free way around the daily attempt limit.
 */
export function randomWord(excludeIndex) {
  if (WORDS.length < 2) return wordByIndex(0);
  let idx;
  do {
    idx = Math.floor(Math.random() * WORDS.length);
  } while (idx === excludeIndex);
  return wordByIndex(idx);
}
