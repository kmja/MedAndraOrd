import { morphology as sv } from '../../server/locales/sv/morphology.js';
import { morphology as en } from '../../server/locales/en/morphology.js';
import { clueMessages as svMessages } from '../../server/locales/sv/messages.js';
import { clueMessages as enMessages } from '../../server/locales/en/messages.js';

// Which language this build is for. Set VITE_LOCALE alongside ORDKNAPP_LOCALE
// on the deployment — the two must agree, or the client would wave through a
// clue the server then refuses.
//
// Every locale's morphology is bundled and one is selected, rather than aliased
// at build time. These modules are a few hundred lines of pure string handling
// with no word bank in them, so the cost is negligible and the build stays a
// plain `vite build` with no resolver plumbing. The word bank must never be
// imported here — there is a test asserting no target word reaches the client.
const LANGUAGES = {
  sv: { morphology: sv, clueMessages: svMessages },
  en: { morphology: en, clueMessages: enMessages },
};

const code = import.meta.env?.VITE_LOCALE || 'sv';

export const LOCALE_CODE = LANGUAGES[code] ? code : 'sv';

// The shape checkClueCode wants: how words are formed, and what to tell the
// player. The same object the server passes, so a clue the client refuses and
// one the server refuses carry identical text.
export const language = LANGUAGES[LOCALE_CODE];
