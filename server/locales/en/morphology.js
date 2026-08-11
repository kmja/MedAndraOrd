// English word-formation. Pure — no imports beyond the shared kit — so the
// browser can run the same checks the server does.
//
// Written against the same brief as the Swedish module: generate the forms a
// target could hide inside a clue, and recognise when a guess is an inflected
// form rather than the base form the guesser was asked for. English is easier
// on one count and harder on another. Easier, because compounds leave the stem
// alone. Harder, because undoing an inflection is not always removing letters —
// "cities" comes from "city" and "running" from "run".

import { normalize, looksInflectedWith } from '../../util.js';

const VOWELS = 'aeiou';
const isVowel = (c) => Boolean(c) && VOWELS.includes(c);

/**
 * A short consonant–vowel–consonant word doubles its final consonant before a
 * vowel-initial ending: run → running, big → bigger, stop → stopped.
 *
 * w, x and y are excluded because they do not double — "flow" gives "flowing",
 * not "flowwing", and "play" gives "playing".
 */
function doublesFinal(w) {
  if (w.length < 3) return false;
  const [c1, v, c2] = [w.at(-3), w.at(-2), w.at(-1)];
  return !isVowel(v) ? false : !isVowel(c1) && !isVowel(c2) && !'wxy'.includes(c2);
}

// The irregulars common enough to appear in a word bank. Anything beyond this
// stays the word author's job — put the awkward form on the word's forbidden
// list — exactly as Swedish leaves umlaut plurals to the author.
const IRREGULAR_PLURALS = {
  man: 'men', woman: 'women', child: 'children', person: 'people',
  foot: 'feet', tooth: 'teeth', goose: 'geese', mouse: 'mice', louse: 'lice',
  ox: 'oxen', die: 'dice', penny: 'pence',
};

/**
 * Plausible inflected forms of an English word.
 *
 * Generates rather than recognises, because the target is known and the clue is
 * not. Covers the regular patterns; irregular verbs (go → went, buy → bought)
 * are out of reach without a real table and are left to the forbidden list.
 */
export function inflectionsOf(word) {
  const w = normalize(word);
  const out = new Set();
  if (!w) return out;

  const add = (...forms) => { for (const f of forms) if (f.length >= 3 && f !== w) out.add(f); };
  const last = w.at(-1);
  const prev = w.at(-2);

  // Endings that attach straight onto the whole word.
  add(w + 's', w + 'ed', w + 'ing', w + 'er', w + 'est', w + 'ers', w + 'ness');

  // Sibilants take -es: church → churches, box → boxes, buzz → buzzes.
  if (/(s|x|z|ch|sh)$/.test(w)) add(`${w}es`);

  // -o often takes -es: potato → potatoes, hero → heroes.
  if (last === 'o') add(`${w}es`);

  // Consonant + y flips to i: city → cities, carry → carried, happy → happier.
  if (last === 'y' && !isVowel(prev)) {
    const stem = w.slice(0, -1);
    add(`${stem}ies`, `${stem}ied`, `${stem}ier`, `${stem}iest`, `${stem}iness`, `${stem}ily`);
  }

  // A final -e drops before a vowel-initial ending: make → making, large → larger.
  if (last === 'e') {
    const stem = w.slice(0, -1);
    add(`${stem}ing`, `${stem}ed`, `${stem}er`, `${stem}est`, `${stem}ers`);
  }

  // -f and -fe turn into -ves: leaf → leaves, knife → knives.
  if (w.endsWith('fe')) add(`${w.slice(0, -2)}ves`);
  else if (last === 'f') add(`${w.slice(0, -1)}ves`);

  // Short CVC doubles: run → running, big → biggest.
  if (doublesFinal(w)) {
    const doubled = w + last;
    add(`${doubled}ing`, `${doubled}ed`, `${doubled}er`, `${doubled}est`);
  }

  if (IRREGULAR_PLURALS[w]) add(IRREGULAR_PLURALS[w]);

  return out;
}

/**
 * English compounds keep the stem intact — "bookshelf" still contains "book" —
 * so the plain substring test in checkClueCode already catches every compound
 * built on the target and there is nothing left for this to add.
 *
 * It exists because the rule engine asks every language the same question, and
 * because the Swedish answer is genuinely different: Swedish drops a final -a
 * or -e before the second element, so "kyrka" hides in "kyrkklocka" as "kyrk"
 * and no substring test can see it. Returning an empty set here is the correct
 * answer for English, not a stub.
 */
export function compoundStemsOf() {
  return new Set();
}

// Base forms whose plural is the same word. They defeat the usual test twice
// over: stripping the -s leaves something the dictionary knows ("specie" is
// real money), and the word has no inflections of its own to prove it is a
// lemma. Measured, "species" was the only one of these to actually trip; the
// rest are here because they fail the same way and cost nothing to list.
const INVARIANT_PLURALS = new Set([
  'species', 'series', 'sheep', 'deer', 'fish', 'aircraft', 'means',
  'news', 'crossroads', 'headquarters', 'barracks', 'offspring',
]);

/**
 * Candidate base forms of a possibly-inflected word — the inverse of the
 * generation above, and the reason the shared helper takes a function rather
 * than a suffix list. Removing letters is not enough in English: "cities" has
 * to become "city" and "running" has to become "run".
 *
 * Over-generates on purpose. Every candidate is checked against the dictionary
 * and against inflectionsOf before it counts, so a wrong guess here costs
 * nothing while a missing one lets an inflected guess through.
 */
function candidateBases(w) {
  const out = new Set();
  const push = (b) => { if (b && b.length >= 3) out.add(b); };

  for (const suffix of ['s', 'es', 'ed', 'ing', 'er', 'est', 'ers', 'en', 'ness']) {
    if (!w.endsWith(suffix)) continue;
    const stem = w.slice(0, -suffix.length);
    push(stem);
    // making → mak → make; larger → larg → large.
    if ('ed ing er est ers'.split(' ').includes(suffix)) push(`${stem}e`);
    // running → runn → run; biggest → bigg → big.
    if (stem.length >= 3 && stem.at(-1) === stem.at(-2)) push(stem.slice(0, -1));
  }
  // cities → city, carried → carry, happiest → happy.
  for (const [suffix, back] of [['ies', 'y'], ['ied', 'y'], ['ier', 'y'], ['iest', 'y'], ['ily', 'y']]) {
    if (w.endsWith(suffix)) push(w.slice(0, -suffix.length) + back);
  }
  // leaves → leaf or leave; knives → knife.
  if (w.endsWith('ves')) {
    push(`${w.slice(0, -3)}f`);
    push(`${w.slice(0, -3)}fe`);
  }
  for (const [singular, plural] of Object.entries(IRREGULAR_PLURALS)) {
    if (w === plural) push(singular);
  }
  return [...out];
}

/** Is this an inflected form rather than the base form the guesser was asked for? */
export function looksInflected(word, isWord) {
  if (INVARIANT_PLURALS.has(normalize(word))) return false;
  return looksInflectedWith(word, isWord, candidateBases, inflectionsOf);
}

export const morphology = { inflectionsOf, compoundStemsOf, looksInflected };
