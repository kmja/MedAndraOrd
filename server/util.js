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
 * Summed letter frequency of a clue. **Lower is rarer, and rarer wins.**
 * Comparing sums is fair because this only ever runs between clues of equal
 * length, so both sums have the same number of terms.
 */
export function letterRarity(s, frequency, unlisted) {
  let sum = 0;
  for (const c of normalize(s)) {
    if (!/\p{L}/u.test(c)) continue;
    sum += frequency[c] ?? unlisted;
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
 *   3. rarer letters, by summed letter frequency for the language being played
 *   4. alphabetical, purely so equal clues never swap places between requests
 * Returns <0 if a ranks above b.
 *
 * The frequency table and the collation both come from the locale. Swedish
 * frequencies scoring English clues would rank the wrong ones higher, and
 * `localeCompare` with the wrong tag sorts å and ä in the wrong place.
 */
export function compareClues(a, b, { frequency, unlisted, collation }) {
  const byLength = clueLength(a) - clueLength(b);
  if (byLength) return byLength;
  const bySpaces = whitespaceCount(a) - whitespaceCount(b);
  if (bySpaces) return bySpaces;
  // lower frequency = rarer
  const byRarity = letterRarity(a, frequency, unlisted) - letterRarity(b, frequency, unlisted);
  if (byRarity) return byRarity;
  return normalize(a).localeCompare(normalize(b), collation);
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
 * The language-independent half of the base-form test. Each locale supplies its
 * own suffixes and its own inflectionsOf; the reasoning is the same everywhere.
 *
 * A dictionary lists word FORMS, not lemmas, so "is this a word" cannot answer
 * "is this a base form" — that is how "gravs", a genitive, reached the screen
 * as a guess. Stripping a known ending and finding a word underneath is not
 * enough on its own either: it rejects "glass", "buss" and "dans", all base
 * forms that happen to end in -s. The second test is what makes it safe — a
 * lemma inflects and an inflected form does not. "glass" has "glassen" and
 * "glassar" in the dictionary; "gravs" has no "gravsen".
 *
 * Deliberately biased toward letting things through: a wrong rejection costs a
 * player their round, a miss costs one odd-looking guess.
 */
export function looksInflectedWith(word, isWord, candidateBases, inflectionsOf) {
  const w = normalize(word);
  if (!w) return false;
  // `candidateBases` rather than a list of suffixes, because undoing an
  // inflection is not always removing letters: English turns "cities" back into
  // "city" and "running" back into "run". Swedish only ever strips, so its
  // implementation is a one-liner over a suffix list.
  const strips = candidateBases(w).some((base) => (
    // `isWord` can also answer null for "dictionary unavailable", and only a
    // definite yes may be used to reject — otherwise an outage would start
    // refusing guesses.
    base.length >= 3 && base !== w && isWord(base) === true && inflectionsOf(base).has(w)
  ));
  if (!strips) return false;
  for (const form of inflectionsOf(w)) {
    if (isWord(form) === true) return false; // it inflects, so it is a lemma
  }
  return true;
}

/**
 * `language` carries the two things this needs from the locale: how words are
 * formed, and what to tell the player. Injected rather than imported so this
 * file stays free of both — the browser runs the same function, and the text
 * has to come out in the language being played.
 */
export function checkClueCode(clue, target, forbidden, maxLength = MAX_CLUE_LENGTH, language) {
  const { morphology, clueMessages: msg } = language;
  const refuse = (code, params = {}) => ({ code, reason: msg[code](params) });
  const raw = String(clue ?? '');
  const n = normalize(raw);

  if (n.length === 0) {
    return refuse('empty');
  }
  if (clueLength(raw) > maxLength) {
    return refuse('too_long', { maxLength });
  }
  if (EMOJI_RE.test(raw)) {
    return refuse('emoji');
  }
  if (FRAGMENT_RE.test(raw.trim())) {
    return refuse('fragment');
  }
  if (n.includes(normalize(target))) {
    return refuse('contains_target');
  }
  // Inflections, which the substring test above cannot see: "stövlar" is not a
  // substring of "stövel". Short forms are matched as whole words only —
  // a three-letter form as a substring would catch far too much.
  const words = new Set(n.split(/[^\p{L}]+/u).filter(Boolean));
  for (const form of morphology.inflectionsOf(target)) {
    if (form.length >= 5 ? n.includes(form) : words.has(form)) {
      return refuse('contains_inflection');
    }
  }
  // Compounds built ON the target: "kyrkklocka", "kyrkogård". Matched as a word
  // prefix, because that is where a Swedish compound puts its first element,
  // and a free substring test on a four-letter stem would catch far too much.
  for (const stem of morphology.compoundStemsOf(target)) {
    for (const w of words) {
      if (w.startsWith(stem)) {
        return refuse('contains_compound');
      }
    }
  }
  // How a forbidden word is matched is a fact about the language, not about
  // the rules — Swedish compounds concatenate and English ones do not.
  for (const f of forbidden) {
    if (morphology.matchesForbidden(n, words, normalize(f))) {
      return refuse('contains_forbidden', { word: f });
    }
  }
  return null;
}

/** Extract the single word from a guesser response. */
export function extractWord(text) {
  const m = String(text ?? '').match(/[\p{L}][\p{L}-]*/u);
  return m ? normalize(m[0]) : null;
}

export const MAX_NAME_LENGTH = 20;

// A speed bump, not moderation. Substring matching over-blocks — "hora" also
// catches "Horacio" — and that is the side to err on for a board a family
// scrolls through, but it is trivially defeated by anyone trying, so do not
// mistake this for a safety feature. The real protection is that a board is
// per-day and per-word, and that nothing here is public by default.
const NAME_BLOCKLIST = [
  'hitler', 'nazi', 'fitta', 'kuk', 'hora', 'neger', 'fuck', 'shit', 'cunt',
  'bög', 'jävla', 'satan', 'knulla', 'bitch', 'idiot',
];

/**
 * A display name that is safe to put on the board, or null if nothing usable
 * survives. Pure, so the browser runs the same function and a name the client
 * accepts is never one the server then silently drops.
 *
 * NFKC first, so fullwidth and other lookalike encodings collapse to the
 * characters the blocklist is written in. Then everything outside letters,
 * digits and a little punctuation goes — which also removes the zero-width
 * characters that would otherwise let two different names render identically.
 */
export function sanitizeName(name) {
  const s = String(name ?? '')
    .normalize('NFKC')
    // Whitespace becomes a space BEFORE the strip, not after. Stripping first
    // deletes a newline outright and welds the words either side of it
    // together — "Karl\nAndersson" came out as "KarlAndersson".
    .replace(/\s+/gu, ' ')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/ +/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (NAME_BLOCKLIST.some((w) => lower.includes(w))) return null;
  return s;
}

/**
 * Local date string (YYYY-MM-DD) in the game's own time zone — the day
 * boundary. Always formatted with 'sv-SE' regardless of the language being
 * played: that is not a language choice, it is the one locale tag that yields
 * ISO-shaped output, and the string is a storage key rather than something a
 * player reads.
 */
export function todayInZone(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
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
