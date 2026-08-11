// Everything the player reads that the server decides.
//
// checkClueCode returns a language-neutral `code`; the words come from here, so
// the rule engine carries no text and a second language supplies this file
// rather than a second copy of the rules.
//
// Pure — the browser imports it too, because the client runs the same
// deterministic checks to refuse an obviously illegal clue without a round trip.

export const clueMessages = {
  empty: () => 'The clue is empty.',
  too_long: ({ maxLength }) => `A clue may be at most ${maxLength} characters (spaces are free).`,
  emoji: () => 'Emoji are not allowed in a clue.',
  fragment: () => 'A clue may not be half a compound to fill in. Describe the word instead.',
  contains_target: () => 'The clue contains the secret word.',
  contains_inflection: () => 'The clue contains an inflected form of the secret word.',
  contains_compound: () => 'The clue is built on the secret word.',
  contains_forbidden: ({ word }) => `The clue contains the forbidden word “${word}”.`,
};

/** Shown when the guesser refuses a clue but gives no reason of its own. */
export const FALLBACK_REFUSAL = 'The clue breaks the rules.';

/** Server-side errors the player sees. */
export const errors = {
  noClue: 'No clue given.',
  clueTooLong: 'That clue is too long.',
  rateLimited: 'Too many tries in a short time. Wait a moment.',
  outOfAttempts: 'You have no tries left today. A new word tomorrow.',
  practiceOff: 'Practice mode is switched off.',
  unknownPracticeWord: 'Unknown practice word.',
  practiceOnToday: "Today's word cannot be practised on. Draw a different one.",
  aiUnavailable: 'The AI is not responding right now. Try again in a moment.',
  aiUnavailableNoCost: 'The AI is not responding right now. Try again in a moment — that cost you no try.',
  generic: 'Something went wrong.',
  genericNoCost: 'Something went wrong. That cost you no try.',
  badName: 'That name cannot be used. Try another.',
};
