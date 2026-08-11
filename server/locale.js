import { morphology as svMorphology } from './locales/sv/morphology.js';
import { LETTER_FREQUENCY as svFrequency, UNLISTED_FREQUENCY as svUnlisted } from './locales/sv/frequency.js';
import { prompt as svPrompt } from './locales/sv/prompt.js';
import { morphology as enMorphology } from './locales/en/morphology.js';
import { LETTER_FREQUENCY as enFrequency, UNLISTED_FREQUENCY as enUnlisted } from './locales/en/frequency.js';
import { prompt as enPrompt } from './locales/en/prompt.js';

/**
 * Which language is being played, resolved once at startup.
 *
 * The game ships as one codebase and deploys as several sites: same rules, same
 * store, same guesser loop, a different language. Everything language-bound
 * lives under locales/<code>/ and is reached through here, so the engine never
 * names a language.
 *
 * Chosen by environment rather than by request, because a deployment IS one
 * language — one domain, one word of the day, one leaderboard. Reading it per
 * request would mean two games sharing a board, which is not a thing anyone
 * wants.
 *
 * Adding a language is: a morphology module, a letter-frequency table, a word
 * bank with its rotation, a prompt, and the UI strings. Nothing structural.
 */
const LOCALES = {
  sv: {
    code: 'sv',
    // The day boundary. A daily puzzle needs one, and it should be the one the
    // players live in rather than UTC.
    timeZone: 'Europe/Stockholm',
    // Passed to localeCompare for the final tiebreak, so å and ä sort where a
    // Swedish reader expects rather than next to a.
    collation: 'sv',
    morphology: svMorphology,
    frequency: svFrequency,
    unlistedFrequency: svUnlisted,
    prompt: svPrompt,
  },
  en: {
    code: 'en',
    // A guess, and the one setting here that is a product decision rather than
    // a fact about the language: an English edition has no single home time
    // zone. London keeps the two editions' days roughly in step, which makes
    // them easy to reason about together. Override with ORDKNAPP_TIMEZONE.
    timeZone: 'Europe/London',
    collation: 'en',
    morphology: enMorphology,
    frequency: enFrequency,
    unlistedFrequency: enUnlisted,
    prompt: enPrompt,
  },
};

const requested = process.env.ORDKNAPP_LOCALE || 'sv';

if (!LOCALES[requested]) {
  // Falling back silently would serve Swedish morphology to English players and
  // look like a hundred small rule bugs rather than one config mistake.
  throw new Error(
    `Unknown ORDKNAPP_LOCALE "${requested}". Available: ${Object.keys(LOCALES).join(', ')}`,
  );
}

export const LOCALE = {
  ...LOCALES[requested],
  // The day boundary is the one locale setting a deployment might reasonably
  // want to move without a code change — an English edition aimed at a US
  // audience should not turn over mid-afternoon.
  timeZone: process.env.ORDKNAPP_TIMEZONE || LOCALES[requested].timeZone,
};

/** The subset compareClues needs, so callers pass one thing rather than three. */
export const COLLATION = {
  frequency: LOCALE.frequency,
  unlisted: LOCALE.unlistedFrequency,
  collation: LOCALE.collation,
};

export const LOCALE_CODES = Object.keys(LOCALES);
