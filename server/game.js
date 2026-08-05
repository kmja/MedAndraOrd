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
 * Guesser retry loop: wrong-length guesses are caught in code (free — and
 * length feedback leaks nothing, the guesser already knows the length) and
 * re-prompted; right-length guesses go to the verifier, with failures fed
 * back. If the loop exhausts, the last guess is surfaced as an AI failure —
 * a rule-breaking guess is never presented as a legitimate outcome.
 */
export async function runGuesserLoop({ clue, targetLetterCount, ai }) {
  const feedback = [];
  let lastGuess = null;

  for (let round = 0; round < MAX_GUESS_ROUNDS; round++) {
    const raw = await ai.guesser({ clue, letterCount: targetLetterCount, feedback });
    if (raw == null) {
      if (lastGuess == null) throw new AiUnavailableError();
      break;
    }
    const guess = extractWord(raw);
    if (!guess) {
      feedback.push({ guess: raw.trim().slice(0, 30) || '?', problem: 'not_word' });
      continue;
    }
    lastGuess = guess;

    if (letterCount(guess) !== targetLetterCount) {
      feedback.push({ guess, problem: 'length' });
      continue;
    }

    const real = await ai.verifier(guess); // null → fail open
    if (real === false) {
      feedback.push({ guess, problem: 'not_word' });
      continue;
    }
    return { guess, valid: true };
  }

  return { guess: lastGuess, valid: false }; // "räknas som miss"
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

  // 2. Referee — sees everything; rejects illegal clues with a stated reason
  //    and no attempt cost. Fails open: a flaky check never blocks play.
  const ruling = await ai.referee({ target, forbidden, clue });
  if (ruling && ruling.legal === false) {
    return {
      type: 'rejected',
      reason: ruling.reason || 'Ledtråden bryter mot reglerna.',
      source: 'referee',
    };
  }

  // 3. Blind guesser with retry loop + verifier.
  const targetLetterCount = letterCount(target);
  const { guess, valid } = await runGuesserLoop({ clue, targetLetterCount, ai });

  if (!valid) {
    return { type: 'ai_failure', guess: guess ?? null };
  }
  if (normalize(guess) === normalize(target)) {
    return { type: 'correct', guess, score: clueLength(clue) };
  }
  return { type: 'wrong', guess };
}
