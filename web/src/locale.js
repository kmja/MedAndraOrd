import { morphology as sv } from '../../server/locales/sv/morphology.js';
import { morphology as en } from '../../server/locales/en/morphology.js';

// Which language this build is for. Set VITE_LOCALE alongside ORDKNAPP_LOCALE
// on the deployment — the two must agree, or the client would wave through a
// clue the server then refuses.
//
// Every locale's morphology is bundled and one is selected, rather than aliased
// at build time. These modules are a few hundred lines of pure string handling
// with no word bank in them, so the cost is negligible and the build stays a
// plain `vite build` with no resolver plumbing. The word bank must never be
// imported here — there is a test asserting no target word reaches the client.
const MORPHOLOGIES = { sv, en };

const code = import.meta.env?.VITE_LOCALE || 'sv';

export const LOCALE_CODE = MORPHOLOGIES[code] ? code : 'sv';
export const morphology = MORPHOLOGIES[LOCALE_CODE];
