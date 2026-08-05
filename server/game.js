import { checkClueCode, normalize, clueLength, letterCount, extractWord } from './util.js';
import * as defaultAi from './ai.js';
import { isSwedishWord } from './dictionary.js';

export const MAX_ATTEMPTS = 5; // per player per day — unlimited retries make it a grind
export const MAX_GUESS_ROUNDS = 4;

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
 *   { type: 'ai_failure', guess }
 */
export async function runGuesserLoop({ clue, target, targetLetterCount, ai }) {
  const feedback = [];
  let lastGuess = null;

  for (let round = 0; round < MAX_GUESS_ROUNDS; round++) {
    const result = await ai.guardedGuesser({ clue, letterCount: targetLetterCount, feedback });

    if (result == null) {
      // Unusable answer. Fail open on the rule check, but the guess itself
      // cannot be faked — with nothing to show, the round is unplayable.
      if (lastGuess == null) throw new AiUnavailableError();
      break;
    }

    if (result.legal === false) {
      return { type: 'rejected', reason: result.reason || 'Ledtråden bryter mot reglerna.' };
    }

    const guess = extractWord(result.guess);
    if (!guess) {
      feedback.push({ guess: String(result.guess).trim().slice(0, 30) || '?', problem: 'not_word' });
      continue;
    }
    lastGuess = guess;

    if (letterCount(guess) !== targetLetterCount) {
      feedback.push({ guess, problem: 'length' });
      continue;
    }

    // A guess equal to the target needs no checking at all — the target is a
    // real word by construction.
    if (normalize(guess) === normalize(target)) {
      return { type: 'correct', guess };
    }

    // Otherwise the dictionary decides, in code and for free, whether this is
    // a legitimate miss or a confabulation. A confabulation is the AI breaking
    // its own rules, so it is re-prompted rather than passed on to the player.
    const real = isSwedishWord(guess); // null → dictionary unavailable → fail open
    if (real === false) {
      feedback.push({ guess, problem: 'not_word' });
      continue;
    }
    return { type: 'wrong', guess };
  }

  return { type: 'ai_failure', guess: lastGuess }; // "räknas som miss"
}

/**
 * Full clue pipeline. Returns a verdict object that is cached per
 * (day, normalized clue) so identical clues resolve identically for everyone
 * — the first submission fixes the ruling for the whole day. The same cache
 * is the cost control.
 *
 * Verdict shape:
 *   { type: 'rejected', reason, source: 'code'|'referee' }
 *   { type: 'correct',  guess, score }
 *   { type: 'wrong',    guess }
 *   { type: 'ai_failure', guess }   // struck through in UI, counts as miss
 */
export async function judgeClue({ clue, target, forbidden, maxLength, ai = defaultAi }) {
  // 1. Deterministic checks — free, before any API call. The length limit is
  // per word (see clueLimitFor), so it has to travel with the call.
  const codeVerdict = checkClueCode(clue, target, forbidden, maxLength);
  if (codeVerdict) {
    return { type: 'rejected', reason: codeVerdict.reason, source: 'code' };
  }

  // 2. One blind call that both judges the clue-only rules and guesses.
  const result = await runGuesserLoop({
    clue,
    target,
    targetLetterCount: letterCount(target),
    ai,
  });

  if (result.type === 'rejected') {
    return { type: 'rejected', reason: result.reason, source: 'referee' };
  }
  if (result.type === 'correct') {
    return { type: 'correct', guess: result.guess, score: clueLength(clue) };
  }
  if (result.type === 'wrong') {
    return { type: 'wrong', guess: result.guess };
  }
  return { type: 'ai_failure', guess: result.guess ?? null };
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
