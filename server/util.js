// Pure helpers — every rule that can be checked deterministically lives here,
// not in a prompt. (Core principle: prompt for judgment, code for constraints.)

// Two numbers, doing different jobs.
//
// PAR is the target: the length worth aiming for, and the game's identity.
// MAX_CLUE_LENGTH is only a hard cap — it exists to bound cost and stop
// someone pasting an essay, not to create difficulty. Golf scoring already
// supplies the pressure to be short, so the cap can be generous without
// making the leaderboard soft: an 18-character solve is a solve, and it will
// sit at the bottom of the board where it belongs.
export const MAX_CLUE_LENGTH = 18;

// A per-word limit needs bounds, because it is derived from measurements and
// measurements go wrong. CLUE_LIMIT_CEILING is the real abuse stop; the floor
// keeps a freak run of very short solves from producing a limit nobody can
// write inside.
export const CLUE_LIMIT_FLOOR = 8;
export const CLUE_LIMIT_CEILING = 24;

/**
 * How many characters this word allows.
 *
 * One global cap is wrong in both directions: it strangles a word whose only
 * routes are long, and leaves an easy word wide open. So a word may carry its
 * own `limit`, measured by the probe (see scripts/probe-word.mjs) rather than
 * guessed. Words without one fall back to the global default, which is what
 * every word does until it has been probed.
 */
export function clueLimitFor(entry) {
  const limit = entry?.limit;
  if (!Number.isInteger(limit)) return MAX_CLUE_LENGTH;
  return Math.min(CLUE_LIMIT_CEILING, Math.max(CLUE_LIMIT_FLOOR, limit));
}

/**
 * Turn a word's probe results into a character limit.
 *
 * The basis is the mean length of the clues that ACTUALLY SOLVED it, plus a
 * margin — not the mean of everything proposed, which would be dragged around
 * by clues that were rejected or missed and never told us anything about how
 * long a working clue has to be.
 *
 * The margin exists because the probe is a sample, not a census: a human will
 * find routes the model didn't, and some of them will be a little longer. The
 * floor of `shortest + 4` is the same worry in sharper form — with only one or
 * two solves the mean is nearly the shortest solve, and a limit that lands on
 * top of it leaves no room to solve the word any other way.
 */
export function suggestedLimit(solvedLengths, { margin = 0.2 } = {}) {
  const lengths = (solvedLengths ?? []).filter((n) => Number.isFinite(n) && n > 0);
  if (!lengths.length) return null; // nothing solved it — no evidence to work from

  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const shortest = Math.min(...lengths);
  const raw = Math.round(mean * (1 + margin));

  return Math.min(CLUE_LIMIT_CEILING, Math.max(CLUE_LIMIT_FLOOR, shortest + 4, raw));
}

/** Lowercase + unicode-normalize + collapse whitespace. Keeps å/ä/ö intact. */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How often each letter occurs in Swedish, as a percentage.
 * Used only as a tiebreaker: between two clues of the same length, the one
 * built from rarer letters is the harder feat and ranks higher.
 */
export const LETTER_FREQUENCY = {
  a: 10.04, e: 9.85, t: 8.89, n: 8.45, r: 7.88, s: 5.32, i: 5.01, d: 4.90,
  l: 4.81, o: 4.06, m: 3.55, g: 3.44, k: 3.24, h: 2.85, v: 2.55, ä: 2.10,
  u: 1.86, f: 1.81, c: 1.71, å: 1.66, p: 1.57, ö: 1.50, b: 1.31, j: 0.90,
  y: 0.49, x: 0.11, w: 0.06, z: 0.04, q: 0.01,
};

// An unlisted letter (é, à, …) gets roughly the mean, so reaching for an exotic
// character is not a free way to win a tiebreak.
const UNLISTED_FREQUENCY = 3.4;

/**
 * Summed letter frequency of a clue. **Lower is rarer, and rarer wins.**
 * Comparing sums is fair because this only ever runs between clues of equal
 * length, so both sums have the same number of terms.
 */
export function letterRarity(s) {
  let sum = 0;
  for (const c of normalize(s)) {
    if (!/\p{L}/u.test(c)) continue;
    sum += LETTER_FREQUENCY[c] ?? UNLISTED_FREQUENCY;
  }
  return sum;
}

/** How many whitespace characters a clue uses — the first tiebreaker. */
export function whitespaceCount(s) {
  return [...String(s ?? '')].filter((c) => /\s/u.test(c)).length;
}

/**
 * Leaderboard order for two clues. Lower is better overall:
 *   1. fewer characters (the score itself)
 *   2. fewer spaces — a clue that needs no spacing is tighter
 *   3. rarer letters, by summed Swedish letter frequency
 *   4. alphabetical, purely so equal clues never swap places between requests
 * Returns <0 if a ranks above b.
 */
export function compareClues(a, b) {
  const byLength = clueLength(a) - clueLength(b);
  if (byLength) return byLength;
  const bySpaces = whitespaceCount(a) - whitespaceCount(b);
  if (bySpaces) return bySpaces;
  const byRarity = letterRarity(a) - letterRarity(b); // lower frequency = rarer
  if (byRarity) return byRarity;
  return normalize(a).localeCompare(normalize(b), 'sv');
}

/** Count of unicode characters. */
export function charCount(s) {
  return [...String(s)].length;
}

/**
 * The golf score of a clue: non-whitespace characters only, so spacing is
 * free. "en lång ledtråd" and "enlångledtråd" cost the same, and players are
 * never pushed into unreadable run-together clues to save a character.
 * This is the number both the limit and the score are measured in.
 */
export function clueLength(s) {
  return [...String(s ?? '')].filter((c) => !/\s/u.test(c)).length;
}

/** Count of letters in a word (what the guesser is told about the target). */
export function letterCount(word) {
  return [...normalize(word)].filter((c) => /\p{L}/u.test(c)).length;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

// An ellipsis or a dangling hyphen turns a clue into a fill-in-the-blank:
// "skit…" doesn't describe a boot, it asks the model to complete a compound.
// Only the explicit signal is caught here — whether a clue describes or merely
// completes is judgment, and lives in the prompt.
const FRAGMENT_RE = /(\.{2,}|…|^-|-$|^\s*-|-\s*$)/;

/**
 * Deterministic clue checks, run before any API call.
 * Returns null if the clue passes, otherwise { code, reason } (reason in Swedish,
 * shown to the player). Rejections here cost no attempt, like referee rejections.
 */
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

const INFLECTION_SUFFIXES = ['s', 'n', 't', 'en', 'et', 'er', 'ar', 'or', 'na', 'ns', 'ts',
  'ets', 'ens', 'arna', 'erna', 'orna', 'ade', 'at'];

/**
 * Is this an inflected form rather than the base form the guesser was asked
 * for? The dictionary arrives as a predicate so this file stays import-free
 * and the browser can keep using it.
 *
 * The dictionary lists word FORMS, so it answers "is this Swedish", not "is
 * this a lemma" — which is how "gravs" came back as a guess for a five-letter
 * word. It is a real genitive, so isSwedishWord said yes.
 *
 * Stripping a known ending and finding a word underneath is not enough on its
 * own: measured against the bank it rejects `glass`, `buss` and `dans`, all
 * base forms that happen to end in -s. The second test is what makes it safe —
 * a lemma inflects, an inflected form does not. "glass" has "glassen" and
 * "glassar" in the dictionary; "gravs" has no "gravsen". Measured over every
 * inflection the bank can produce, this rejects about half of them and, across
 * 475 known lemmas, none. Deliberately biased that way: a wrong rejection
 * costs the player a round, a miss costs an odd-looking guess.
 */
export function looksInflected(word, isWord) {
  const w = normalize(word);
  if (!w) return false;
  const strips = INFLECTION_SUFFIXES.some((suffix) => {
    if (!w.endsWith(suffix)) return false;
    const base = w.slice(0, -suffix.length);
    // `isWord` can also answer null for "dictionary unavailable", and only a
    // definite yes may be used to reject — otherwise an outage would start
    // refusing guesses.
    return base.length >= 3 && isWord(base) === true && inflectionsOf(base).has(w);
  });
  if (!strips) return false;
  for (const form of inflectionsOf(w)) {
    if (isWord(form) === true) return false; // it inflects, so it is a lemma
  }
  return true;
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

export function checkClueCode(clue, target, forbidden, maxLength = MAX_CLUE_LENGTH) {
  const raw = String(clue ?? '');
  const n = normalize(raw);

  if (n.length === 0) {
    return { code: 'empty', reason: 'Ledtråden är tom.' };
  }
  if (clueLength(raw) > maxLength) {
    return {
      code: 'too_long',
      reason: `Ledtråden får vara högst ${maxLength} tecken (mellanslag räknas inte).`,
    };
  }
  if (EMOJI_RE.test(raw)) {
    return { code: 'emoji', reason: 'Emoji är inte tillåtna i ledtråden.' };
  }
  if (FRAGMENT_RE.test(raw.trim())) {
    return {
      code: 'fragment',
      reason: 'Ledtråden får inte vara en halv sammansättning att fylla i. Beskriv ordet i stället.',
    };
  }
  if (n.includes(normalize(target))) {
    return { code: 'contains_target', reason: 'Ledtråden innehåller det hemliga ordet.' };
  }
  // Inflections, which the substring test above cannot see: "stövlar" is not a
  // substring of "stövel". Short forms are matched as whole words only —
  // a three-letter form as a substring would catch far too much.
  const words = new Set(n.split(/[^\p{L}]+/u).filter(Boolean));
  for (const form of inflectionsOf(target)) {
    if (form.length >= 5 ? n.includes(form) : words.has(form)) {
      return { code: 'contains_inflection', reason: 'Ledtråden innehåller en böjning av det hemliga ordet.' };
    }
  }
  // Compounds built ON the target: "kyrkklocka", "kyrkogård". Matched as a word
  // prefix, because that is where a Swedish compound puts its first element,
  // and a free substring test on a four-letter stem would catch far too much.
  for (const stem of compoundStemsOf(target)) {
    for (const w of words) {
      if (w.startsWith(stem)) {
        return {
          code: 'contains_compound',
          reason: 'Ledtråden bygger på det hemliga ordet i en sammansättning.',
        };
      }
    }
  }
  for (const f of forbidden) {
    if (n.includes(normalize(f))) {
      return { code: 'contains_forbidden', reason: `Ledtråden innehåller det förbjudna ordet ”${f}”.` };
    }
  }
  return null;
}

/** Extract the single word from a guesser response. */
export function extractWord(text) {
  const m = String(text ?? '').match(/[\p{L}][\p{L}-]*/u);
  return m ? normalize(m[0]) : null;
}

/** Local date string (YYYY-MM-DD) in Swedish time — the game day boundary. */
export function todayInStockholm(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Deterministic day number from a YYYY-MM-DD string. */
export function dayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
