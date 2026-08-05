// Pure helpers — every rule that can be checked deterministically lives here,
// not in a prompt. (Core principle: prompt for judgment, code for constraints.)

// Two numbers, doing different jobs.
//
// PAR is the target: the length worth aiming for, and the game's identity.
// MAX_CLUE_LENGTH is only a hard cap — it exists to bound cost and stop
// someone pasting an essay, not to create difficulty. Golf scoring already
// supplies the pressure to be short, so the cap can be generous without
// making the leaderboard soft: a 24-character solve is a solve, and it will
// sit at the bottom of the board where it belongs.
export const PAR_CLUE_LENGTH = 10;
export const MAX_CLUE_LENGTH = 25;

/** Lowercase + unicode-normalize + collapse whitespace. Keeps å/ä/ö intact. */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Swedish Scrabble letter values, used only as a tiebreaker: a clue built from
 * rarer letters beats one of the same length built from common ones.
 *
 * NOTE: assembled from the Swedish tile set. The confirmed anchors are A/D/E=1,
 * C=8 and Q/Z=10; the rest follows the standard distribution. I could not read
 * an authoritative table (the sources block automated fetches), so treat these
 * as correctable — the game only needs a stable ordering where rare letters
 * rank higher, and this is the single place to fix it.
 */
export const SCRABBLE_VALUES = {
  a: 1, d: 1, e: 1, i: 1, l: 1, n: 1, o: 1, r: 1, s: 1, t: 1,
  g: 2, k: 2, m: 2,
  h: 3, ä: 3,
  b: 4, f: 4, p: 4, u: 4, v: 4, å: 4, ö: 4,
  j: 7, y: 7,
  c: 8, x: 8, w: 8,
  q: 10, z: 10,
};

/** Summed Scrabble value of a clue's letters. Unknown characters score 0. */
export function scrabbleValue(s) {
  let total = 0;
  for (const c of normalize(s)) total += SCRABBLE_VALUES[c] ?? 0;
  return total;
}

/** How many whitespace characters a clue uses — the first tiebreaker. */
export function whitespaceCount(s) {
  return [...String(s ?? '')].filter((c) => /\s/u.test(c)).length;
}

/**
 * Leaderboard order for two clues. Lower is better overall:
 *   1. fewer characters (the score itself)
 *   2. fewer spaces — a clue that needs no spacing is tighter
 *   3. higher Scrabble value — rarer letters are the harder feat
 *   4. alphabetical, purely so equal clues never swap places between requests
 * Returns <0 if a ranks above b.
 */
export function compareClues(a, b) {
  const byLength = clueLength(a) - clueLength(b);
  if (byLength) return byLength;
  const bySpaces = whitespaceCount(a) - whitespaceCount(b);
  if (bySpaces) return bySpaces;
  const byRarity = scrabbleValue(b) - scrabbleValue(a);
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

const NAME_BLOCKLIST = [
  'hitler', 'nazi', 'fitta', 'kuk', 'hora', 'neger', 'fuck', 'shit', 'cunt',
  'bög', 'jävla', 'satan', 'knulla', 'bitch', 'idiot',
];

/**
 * Leaderboard name moderation: sanitize in code, blocklist crude words.
 * Returns a safe display name, or null if nothing usable remains.
 */
export function sanitizeName(name) {
  let s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (NAME_BLOCKLIST.some((w) => lower.includes(w))) return null;
  return s;
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
