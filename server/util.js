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
