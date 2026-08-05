import { dayNumber, letterCount } from './util.js';

// Hand-authored word bank. Writing the forbidden lists is the Taboo craft —
// each list blocks the most obvious clue routes for its word.
// The bank is weighted toward 5–6-letter words (the difficulty sweet spot:
// difficulty is neighborhood density — how many real same-length words live
// near the concept).
export const WORDS = [
  { word: 'morot', forbidden: ['grönsak', 'orange', 'kanin', 'rot', 'odla'] },
  { word: 'sommar', forbidden: ['årstid', 'sol', 'varm', 'semester', 'vinter'] },
  { word: 'strand', forbidden: ['sand', 'hav', 'bad', 'sol', 'semester'] },
  { word: 'äpple', forbidden: ['frukt', 'träd', 'rött', 'äta', 'paj'] },
  { word: 'fågel', forbidden: ['flyga', 'vinge', 'näbb', 'djur', 'kvittra'] },
  { word: 'skola', forbidden: ['elev', 'lärare', 'klass', 'lektion', 'undervisning'] },
  { word: 'vinter', forbidden: ['kall', 'snö', 'årstid', 'jul', 'is'] },
  { word: 'cykel', forbidden: ['hjul', 'trampa', 'åka', 'fordon', 'styre'] },
  { word: 'lampa', forbidden: ['ljus', 'lysa', 'tak', 'tända', 'el'] },
  { word: 'stjärna', forbidden: ['himmel', 'natt', 'lysa', 'kändis', 'rymden'] },
  { word: 'hjärta', forbidden: ['kärlek', 'pumpa', 'blod', 'organ', 'slå'] },
  { word: 'pengar', forbidden: ['betala', 'mynt', 'sedel', 'rik', 'valuta'] },
  { word: 'kaffe', forbidden: ['dryck', 'dricka', 'böna', 'kopp', 'koffein'] },
  { word: 'spegel', forbidden: ['glas', 'reflektera', 'bild', 'badrum', 'se'] },
  { word: 'nyckel', forbidden: ['lås', 'dörr', 'öppna', 'knippa', 'hänglås'] },
  { word: 'telefon', forbidden: ['ringa', 'samtal', 'mobil', 'prata', 'nummer'] },
  { word: 'blomma', forbidden: ['växt', 'doft', 'kronblad', 'vas', 'trädgård'] },
  { word: 'gitarr', forbidden: ['sträng', 'spela', 'musik', 'instrument', 'ackord'] },
  { word: 'soffa', forbidden: ['sitta', 'möbel', 'vardagsrum', 'ligga', 'kudde'] },
  { word: 'glass', forbidden: ['kall', 'äta', 'strut', 'sommar', 'smak'] },
  { word: 'regn', forbidden: ['väder', 'vatten', 'paraply', 'blöt', 'moln'] },
  { word: 'hund', forbidden: ['djur', 'skälla', 'koppel', 'husdjur', 'valp'] },
  { word: 'klocka', forbidden: ['tid', 'visare', 'armband', 'ringa', 'timme'] },
  { word: 'fönster', forbidden: ['glas', 'öppna', 'hus', 'utsikt', 'karm'] },
  { word: 'kudde', forbidden: ['sova', 'säng', 'mjuk', 'huvud', 'fjäder'] },
  { word: 'banan', forbidden: ['frukt', 'gul', 'skal', 'apa', 'böjd'] },
  { word: 'socker', forbidden: ['söt', 'baka', 'vit', 'bit', 'kaffe'] },
  { word: 'vante', forbidden: ['hand', 'vinter', 'kall', 'sticka', 'par'] },
  { word: 'brasa', forbidden: ['eld', 'ved', 'värme', 'spis', 'mysig'] },
  { word: 'hylla', forbidden: ['bok', 'vägg', 'förvara', 'plank', 'ställa'] },
  { word: 'öken', forbidden: ['sand', 'torr', 'varm', 'kamel', 'sahara'] },
  { word: 'sjukhus', forbidden: ['läkare', 'vård', 'patient', 'sjuk', 'operation'] },
  { word: 'piano', forbidden: ['tangent', 'spela', 'musik', 'instrument', 'flygel'] },
  { word: 'raket', forbidden: ['rymd', 'flyga', 'nyår', 'fart', 'uppskjutning'] },
  { word: 'segel', forbidden: ['båt', 'vind', 'mast', 'hav', 'duk'] },
  { word: 'krona', forbidden: ['kung', 'huvud', 'pengar', 'valuta', 'guld'] },
  { word: 'dimma', forbidden: ['sikt', 'grå', 'väder', 'moln', 'morgon'] },
  { word: 'kamera', forbidden: ['foto', 'bild', 'lins', 'filma', 'knäppa'] },
  { word: 'tavla', forbidden: ['konst', 'vägg', 'måla', 'ram', 'klassrum'] },
  { word: 'boll', forbidden: ['rund', 'kasta', 'spela', 'studsa', 'fotboll'] },
];

/** Deterministic daily rotation: same date → same word for everyone. */
export function wordForDate(dateStr) {
  const idx = dayNumber(dateStr) % WORDS.length;
  const entry = WORDS[idx];
  return { index: idx, word: entry.word, forbidden: entry.forbidden, letterCount: letterCount(entry.word) };
}
