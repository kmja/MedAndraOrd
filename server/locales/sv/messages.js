// Everything the player reads that the server decides.
//
// checkClueCode returns a language-neutral `code`; the words come from here, so
// the rule engine carries no text and a second language supplies this file
// rather than a second copy of the rules.
//
// Pure — the browser imports it too, because the client runs the same
// deterministic checks to refuse an obviously illegal clue without a round trip.

export const clueMessages = {
  empty: () => 'Ledtråden är tom.',
  too_long: ({ maxLength }) => `Ledtråden får vara högst ${maxLength} tecken (mellanslag räknas inte).`,
  emoji: () => 'Emoji är inte tillåtna i ledtråden.',
  fragment: () => 'Ledtråden får inte vara en halv sammansättning att fylla i. Beskriv ordet i stället.',
  contains_target: () => 'Ledtråden innehåller det hemliga ordet.',
  contains_inflection: () => 'Ledtråden innehåller en böjning av det hemliga ordet.',
  contains_compound: () => 'Ledtråden bygger på det hemliga ordet i en sammansättning.',
  contains_forbidden: ({ word }) => `Ledtråden innehåller det förbjudna ordet ”${word}”.`,
};

/** Shown when the guesser refuses a clue but gives no reason of its own. */
export const FALLBACK_REFUSAL = 'Ledtråden bryter mot reglerna.';

/** Server-side errors the player sees. */
export const errors = {
  noClue: 'Ingen ledtråd angiven.',
  clueTooLong: 'Ledtråden är för lång.',
  rateLimited: 'För många försök på kort tid. Vänta en stund.',
  outOfAttempts: 'Du har inga försök kvar idag. Nytt ord imorgon.',
  practiceOff: 'Övningsläget är avstängt.',
  unknownPracticeWord: 'Okänt övningsord.',
  practiceOnToday: 'Dagens ord kan inte övas på. Slumpa ett annat ord.',
  aiUnavailable: 'AI:n svarar inte just nu. Försök igen om en stund.',
  aiUnavailableNoCost: 'AI:n svarar inte just nu. Försök igen om en stund — inget försök förbrukades.',
  generic: 'Något gick fel.',
  genericNoCost: 'Något gick fel. Inget försök förbrukades.',
  badName: 'Det namnet går inte att använda. Prova ett annat.',
};
