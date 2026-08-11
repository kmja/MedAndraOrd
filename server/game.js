import { checkClueCode, normalize, clueLength, letterCount, extractWord } from './util.js';
import { LOCALE } from './locale.js';
import * as defaultAi from './ai.js';
import { isSwedishWord } from './dictionary.js';

/**
 * Attempts per player per day, or Infinity for no limit.
 *
 * A cap is right for a daily puzzle — unlimited retries turn a guessing game
 * into a grind, and the leaderboard means something because everyone had the
 * same five tries. It is wrong while the game is being shown to people for the
 * first time, where the point is that they try things and say what happened.
 * So it is currently uncapped, and ORDKNAPP_MAX_ATTEMPTS=5 puts the limit back
 * without a deploy.
 */
export const MAX_ATTEMPTS = attemptCapFrom(process.env.ORDKNAPP_MAX_ATTEMPTS);

/** Read the cap from a raw env value. Exported so the parsing can be tested
 * without reloading the module under a different environment. */
export function attemptCapFrom(raw) {
  if (raw == null || raw === '') return Infinity;
  const n = Number(raw);
  // A malformed value must not silently mean "one attempt" — that is a worse
  // game than either setting anyone meant to choose.
  return Number.isInteger(n) && n > 0 ? n : Infinity;
}

export const MAX_GUESS_ROUNDS = 4;

// A ceiling on the whole loop, not just on the number of rounds. Rounds bound
// how many times we ask; this bounds how long the asking may take, which is
// the number the player actually experiences. Comfortably inside the 60s
// serverless limit, so the request returns a real verdict rather than being
// killed mid-flight and leaving the UI with nothing to show.
export const GUESS_DEADLINE_MS = 25_000;

/** Thrown when the guesser itself is unreachable — the one role that can't fail open. */
export class AiUnavailableError extends Error {
  constructor() {
    super('AI unavailable');
    this.name = 'AiUnavailableError';
  }
}

/**
 * Judge-and-guess loop. One model call per round, because the clue-only rules
 * ride along in the guesser's prompt (see ai.guardedGuesser) — the target
 * never enters the model's context, so the guess stays blind.
 *
 * Wrong-length guesses are caught in code (free — and length feedback leaks
 * nothing, the guesser already knows the length) and re-prompted; that retry is
 * the only path that can cost a second request. Whether a right-length guess is
 * a real word is settled by the dictionary, in code, with no retry — so every
 * other outcome costs exactly one. A confabulated guess is still surfaced as an
 * AI failure rather than presented as a legitimate miss.
 *
 * Returns one of:
 *   { type: 'rejected', reason }
 *   { type: 'correct',  guess }
 *   { type: 'wrong',    guess }
 *   { type: 'ai_failure', guess, trace }
 *
 * `trace` records what every round actually did. A failure here is the one
 * outcome with no visible cause — the player is told the AI gave no valid
 * answer and nothing about why, and from the outside a loop that gave up
 * after one round looks exactly like one that tried four times. It carries
 * guesses and rulings only; the target never enters it.
 */
export async function runGuesserLoop({ clue, target, targetLetterCount, wordClass, ai }) {
  const feedback = [];
  const trace = [];
  const tried = new Set();
  let lastGuess = null;
  let blanks = 0;
  const started = Date.now();
  const deadline = started + GUESS_DEADLINE_MS;
  const step = (round, event, extra = {}) =>
    trace.push({ round, ms: Date.now() - started, event, ...extra });

  for (let round = 0; round < MAX_GUESS_ROUNDS; round++) {
    // Checked before asking again, not after: another round could take as long
    // as the one that just used up the budget.
    if (round > 0 && Date.now() > deadline) {
      step(round, 'deadline', { budgetMs: GUESS_DEADLINE_MS });
      break;
    }

    const asked = Date.now();
    const result = await ai.guardedGuesser({ clue, letterCount: targetLetterCount, wordClass, feedback });
    const tookMs = Date.now() - asked;

    if (result == null) {
      // Unusable answer. Fail open on the rule check, but the guess itself
      // cannot be faked — with nothing to show, the round is unplayable.
      if (lastGuess == null) throw new AiUnavailableError();
      // Otherwise this is the same situation as a wrong-length guess: the
      // player wrote a legal clue and the model misbehaved, so try again
      // rather than writing the clue off after a single bad reply. Bounded
      // separately, because null also covers "the API call failed" — and a
      // dead API should not spend the whole budget while a player waits.
      step(round, 'blank', { tookMs, blanks: blanks + 1 });
      if (++blanks >= 2) break;
      continue;
    }

    if (result.legal === false) {
      step(round, 'refused', { tookMs, reason: result.reason ?? null });
      return { type: 'rejected', reason: result.reason || 'Ledtråden bryter mot reglerna.' };
    }

    // A retry asks for several alternatives at once, so a round can carry more
    // than one candidate. They are walked best-first and the first usable one
    // settles the round; the rest are only there so a single stuck answer
    // cannot waste the whole round.
    // The `ai` seam is implemented by more than the live module — the probe's
    // batch path builds rulings by hand, and so do the tests. A single `guess`
    // is still a valid reply; only the retry asks for a list.
    const candidates = result.candidates
      ?? (result.guess != null ? [{ guess: result.guess, why: result.why }] : []);

    let progressed = false;
    for (const candidate of candidates) {
      const guess = extractWord(candidate.guess);
      if (!guess) {
        const shown = String(candidate.guess).trim().slice(0, 30) || '?';
        step(round, 'unreadable', { tookMs, reply: shown });
        feedback.push({ guess: shown, problem: 'not_word' });
        progressed = true;
        continue;
      }

      // Already ruled out. Re-checking it would push the same entry into the
      // feedback again and send an identical prompt next round — which is how
      // four rounds came back holding one word.
      if (tried.has(guess)) {
        step(round, 'repeat', { tookMs, guess });
        continue;
      }
      tried.add(guess);
      progressed = true;
      lastGuess = guess;

      if (letterCount(guess) !== targetLetterCount) {
        step(round, 'wrong_length', { tookMs, guess, letters: letterCount(guess), wanted: targetLetterCount });
        feedback.push({ guess, problem: 'length', letters: letterCount(guess) });
        continue;
      }

      // A guess equal to the target needs no checking at all — the target is a
      // real word by construction.
      if (normalize(guess) === normalize(target)) {
        step(round, 'correct', { tookMs, guess });
        return { type: 'correct', guess, why: candidate.why ?? null };
      }

      // Otherwise the dictionary decides, in code and for free, whether this is
      // a legitimate miss or a confabulation. A confabulation is the AI breaking
      // its own rules, so it is re-prompted rather than passed on to the player.
      const real = isSwedishWord(guess); // null → dictionary unavailable → fail open
      if (real === false) {
        step(round, 'not_a_word', { tookMs, guess });
        feedback.push({ guess, problem: 'not_word' });
        continue;
      }

      // A real word is not enough: the guess has to be the base form. The
      // dictionary lists every form, so "gravs" — a genitive — passed the check
      // above and went on screen as the AI's answer. Same treatment as a
      // wrong-length guess: the clue was legal, so re-prompt rather than let a
      // half-word stand as the round's result.
      if (LOCALE.morphology.looksInflected(guess, isSwedishWord)) {
        step(round, 'not_base_form', { tookMs, guess });
        feedback.push({ guess, problem: 'not_base' });
        continue;
      }
      step(round, 'wrong', { tookMs, guess });
      return { type: 'wrong', guess, why: candidate.why ?? null };
    }

    // Nothing new came back — every candidate was already ruled out. The
    // feedback is therefore unchanged, so the next round would send a
    // byte-identical prompt at the same temperature and get the same reply.
    // Stop and say so rather than spend the remaining rounds proving it.
    if (!progressed) {
      step(round, 'stuck');
      break;
    }
  }

  return { type: 'ai_failure', guess: lastGuess, trace }; // "räknas som miss"
}

/**
 * Full clue pipeline. Returns a verdict object that is cached per
 * (day, normalized clue) so identical clues resolve identically for everyone
 * — the first submission fixes the ruling for the whole day. The same cache
 * is the cost control.
 *
 * Verdict shape:
 *   { type: 'rejected', reason, source: 'code'|'referee' }
 *   { type: 'correct',  guess, score, why }
 *   { type: 'wrong',    guess, why }
 *   { type: 'ai_failure', guess, trace } // struck through in UI, counts as miss
 *
 * `why` is the guesser's own account of how it read the clue, shown to the
 * player after the reveal. It is optional everywhere: a missing one is a
 * slightly duller card, never a failed round.
 */
export async function judgeClue({ clue, target, forbidden, maxLength, wordClass, ai = defaultAi }) {
  // 1. Deterministic checks — free, before any API call. The length limit is
  // per word (see clueLimitFor), so it has to travel with the call.
  const codeVerdict = checkClueCode(clue, target, forbidden, maxLength, LOCALE.morphology);
  if (codeVerdict) {
    return { type: 'rejected', reason: codeVerdict.reason, source: 'code' };
  }

  // 2. One blind call that both judges the clue-only rules and guesses.
  const result = await runGuesserLoop({
    clue,
    target,
    targetLetterCount: letterCount(target),
    wordClass,
    ai,
  });

  if (result.type === 'rejected') {
    return { type: 'rejected', reason: result.reason, source: 'referee' };
  }
  if (result.type === 'correct') {
    return { type: 'correct', guess: result.guess, score: clueLength(clue), why: result.why ?? null };
  }
  if (result.type === 'wrong') {
    return { type: 'wrong', guess: result.guess, why: result.why ?? null };
  }
  // A failure is the one verdict that cannot explain itself, so the round's
  // steps travel with it — to the server log, and to the player behind a
  // disclosure. Without this, "gave up after one round" and "tried four times"
  // are indistinguishable from the outside, which is exactly the doubt this
  // outcome creates.
  const trace = result.trace ?? [];
  console.error(`ai_failure after ${trace.length} step(s):`, JSON.stringify(trace));
  return { type: 'ai_failure', guess: result.guess ?? null, trace };
}

/**
 * Does this verdict cost the player one of their daily attempts?
 *
 * Only outcomes the player is responsible for. A clue refused by the rules
 * never reached the guesser, and an AI failure means the model could not
 * produce a legal answer to a legal clue after several tries — neither is the
 * player's doing, and charging for them would punish people for the AI
 * misbehaving.
 */
export function costsAttempt(verdict) {
  return verdict?.type === 'correct' || verdict?.type === 'wrong';
}

/**
 * Should this verdict be cached as the day's ruling for that clue?
 *
 * Rulings about the clue are cached so identical clues resolve identically.
 * An AI failure is not a ruling — it is transient misbehaviour — and caching
 * it would freeze the clue as permanently failed, so a resubmission could
 * never get a fresh attempt at a real guess.
 */
export function isCacheableVerdict(verdict) {
  return verdict?.type !== 'ai_failure';
}

// How long a refusal stays cached. Long enough to absorb a double-click or an
// annoyed re-submit, which is all the cache was ever protecting against here.
export const REJECTION_TTL_SECONDS = 10 * 60;

/**
 * How long this ruling should be cached for, in seconds. Null means "as long
 * as the puzzle lives", which is the default for everything else.
 *
 * A correct or wrong ruling has to be frozen: it scores a clue, and two
 * players writing the same clue must land in the same place on the board.
 * A refusal scores nothing and costs no attempt, so there is no fairness
 * stake in freezing it — and freezing it is actively harmful, because the
 * refusal might be wrong. One bad ruling on a legal clue used to ban that
 * clue for every player for the rest of the puzzle, with no way back.
 */
export function verdictTtlSeconds(verdict) {
  return verdict?.type === 'rejected' ? REJECTION_TTL_SECONDS : null;
}
