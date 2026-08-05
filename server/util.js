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
export const PAR_CLUE_LENGTH = 10;
export const MAX_CLUE_LENGTH = 18;

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
export function checkClueCode(clue, target, forbidden) {
  const raw = String(clue ?? '');
  const n = normalize(raw);

  if (n.length === 0) {
    return { code: 'empty', reason: 'Ledtråden är tom.' };
  }
  if (clueLength(raw) > MAX_CLUE_LENGTH) {
    return {
      code: 'too_long',
      reason: `Ledtråden får vara högst ${MAX_CLUE_LENGTH} tecken (mellanslag räknas inte).`,
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
