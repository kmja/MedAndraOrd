import { checkClueCode, normalize, clueLength, letterCount, extractWord } from './util.js';
import * as defaultAi from './ai.js';

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
 * nothing, the guesser already knows the length) and re-prompted. Right-length
 * guesses go to the verifier, with failures fed back. If the loop exhausts,
 * the last guess is surfaced as an AI failure — a rule-breaking guess is never
 * presented as a legitimate outcome.
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

    // A guess equal to the target needs no verification — the target is a real
    // word by construction. This is what keeps a successful submission at
    // exactly one model call.
    if (normalize(guess) === normalize(target)) {
      return { type: 'correct', guess };
    }

    const real = await ai.verifier(guess); // null → fail open
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
export async function judgeClue({ clue, target, forbidden, ai = defaultAi }) {
  // 1. Deterministic checks — free, before any API call.
  const codeVerdict = checkClueCode(clue, target, forbidden);
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
