// Swedish word-formation. Pure — no imports beyond the shared kit — so the
// browser can run the same checks the server does.
//
// This is the file a new language mostly consists of. Everything the rule
// engine does with word forms goes through here: what counts as an inflection
// of the target, what a compound built on it looks like, and whether a guess is
// a base form. The engine itself knows none of it.

import { normalize, looksInflectedWith } from '../../util.js';

/**
 * Plausible inflected forms of a Swedish word.
 *
 * The rules always said inflections were out, but the code only did a
 * substring check, which silently missed every form where the stem changes:
 * "stövlar" is not a substring of "stövel", so "Puss i stövlar" sailed through
 * and solved the word. A substring test cannot express Swedish morphology.
 *
 * This generates rather than recognises, because the target is known and the
 * clue is not. It covers the regular patterns — added endings, the dropped
 * vowel in -el/-er/-en words (nyckel → nycklar), -a and -e stems (blomma →
 * blommor, vante → vantar).
 *
 * It does NOT cover umlaut plurals (morot → morötter, hand → händer), which
 * are irregular and would need a real morphology table. Those stay the word
 * author's job: put the awkward form on the word's forbidden list.
 */
export function inflectionsOf(word) {
  const w = normalize(word);
  const out = new Set();
  if (!w) return out;

  const add = (...forms) => { for (const f of forms) if (f.length >= 3 && f !== w) out.add(f); };

  // Endings that attach straight onto the whole word.
  for (const s of ['en', 'n', 'et', 't', 'er', 'ar', 'or', 'r', 'na', 'arna', 'erna', 'orna',
    'ens', 'ns', 'ets', 'ts', 'ers', 'ars', 'ors', 's', 'de', 'te', 'tt', 'ade', 'at', 'a']) {
    add(w + s);
  }

  // -el/-en/-er drop the vowel before a vowel-initial ending: stövel → stövlar,
  // nyckel → nycklar, fönster → fönstret.
  const dropped = /^(.+)e([lnr])$/.exec(w);
  if (dropped) {
    const stem = dropped[1] + dropped[2];
    add(...['ar', 'arna', 'ars', 'arnas', 'en', 'ens', 'et', 'ets', 'na'].map((s) => stem + s));
  }

  // -a stems: blomma → blommor, klocka → klockor.
  if (w.endsWith('a')) {
    const stem = w.slice(0, -1);
    add(...['or', 'orna', 'ors', 'ornas', 'an', 'ans', 'ade', 'at', 'ar'].map((s) => stem + s));
  }

  // -e stems: vante → vantar, pojke → pojkar.
  if (w.endsWith('e')) {
    const stem = w.slice(0, -1);
    add(...['ar', 'arna', 'ars', 'arnas', 'en', 'ens'].map((s) => stem + s));
  }

  // Verbs are listed in the infinitive, which ends in -a for all but a handful.
  // springa → springer, sprang, sprungit are irregular and out of reach, but
  // the regular conjugation is not: viska → viskar, viskade, viskat.
  if (w.endsWith('a')) {
    const stem = w.slice(0, -1);
    add(...['ar', 'ade', 'at', 'as', 'ades', 'ats', 'andes'].map((s) => stem + s));
    add(stem + 'ande'); // present participle: viskande
  }

  // Adjectives inflect for gender, number and degree: grön → grönt, gröna,
  // grönare, grönast. The comparative is the one that matters most, since it
  // is the form a player would reach for.
  add(...['t', 'a', 'are', 'ast', 'aste', 'ares'].map((s) => w + s));
  if (w.endsWith('ig')) add(...['t', 'a', 'are', 'ast', 'aste'].map((s) => w + s));

  return out;
}

/**
 * The forms a word takes as the FIRST half of a compound. Exported for tests.
 *
 * inflectionsOf only ever adds endings, so it cannot see "kyrkklocka": Swedish
 * drops a final -a or -e before the second element, and the result is neither
 * the word nor any inflection of it. When the target is the SECOND half
 * ("domkyrka") the whole word is present and the plain substring test already
 * catches it — this covers the other position.
 *
 * The linking forms (kyrko-, gatu-) all begin with the same stem, so matching
 * the stem as a prefix covers them without listing them.
 */
export function compoundStemsOf(word) {
  const w = normalize(word);
  const out = new Set();
  for (const pattern of [/^(.+)a$/, /^(.+)e$/]) {
    const hit = pattern.exec(w);
    // Three letters is too little to anchor on. "vara" would yield "var", and
    // then "varm" reads as a clue containing the secret word. Four is where
    // stems stop swallowing ordinary vocabulary by accident.
    if (hit && hit[1].length >= 4) out.add(hit[1]);
  }
  return out;
}

// Suffixes that, stripped, might reveal a base form underneath. -a and -e are
// here for adjective and weak-noun forms ("kloka" from "klok"). They look risky
// next to a bank full of nouns ending in -a, but the two tests in
// looksInflectedWith carry it: "kyrka" only strips to "kyrk" if that is a word,
// and it is not. Measured over the bank, they add no false positives at all.
const INFLECTION_SUFFIXES = ['s', 'n', 't', 'a', 'e', 'en', 'et', 'er', 'ar', 'or', 'na', 'ns',
  'ts', 'ets', 'ens', 'arna', 'erna', 'orna', 'ade', 'at'];

/** Swedish only ever adds letters, so undoing an inflection is stripping one. */
const candidateBases = (w) => INFLECTION_SUFFIXES
  .filter((suffix) => w.endsWith(suffix))
  .map((suffix) => w.slice(0, -suffix.length));

/**
 * Is this an inflected form rather than the base form the guesser was asked for?
 *
 * Heuristic, because the Swedish data is a full-form list and there is no lemma
 * index to check against. English has one and answers this exactly; if a
 * Swedish lemma list ever ships, this should do the same.
 */
export function looksInflected(word, isWord) {
  return looksInflectedWith(word, isWord, candidateBases, inflectionsOf);
}

export const morphology = { inflectionsOf, compoundStemsOf, looksInflected };
