import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

// The single AI role. Everything Swedish lives in this prompt, the word bank
// and the dictionary — shipping another language means translating the prompt
// and supplying a word list; nothing structural changes.
//
// The API key never leaves this server.
//
// Model choice is a cost decision. The workload is tiny per call (the biggest
// prompt is ~320 tokens) and the clue cache dedupes repeats, so the cheapest
// capable model wins. Default: Gemini 3.1 Flash-Lite. Note that
// gemini-2.5-flash-lite is cheaper still but retires 2026-10-16 — not worth
// building on. Override with ORDKNAPP_MODEL to try a stronger model if the
// clue judgment proves too loose.
//
// Thinking level is deliberately left unset: 3.1 Flash-Lite already defaults
// to "minimal", which is what this classification-shaped task wants.
// Set it explicitly only after verifying the field against a live key —
// a rejected config would make every call fail, and the rule check fails OPEN.

const MODEL = process.env.ORDKNAPP_MODEL || 'gemini-3.1-flash-lite';
const MAX_TOKENS = 300;

let _client = null;
function client() {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

/**
 * Pull plain text out of a Gemini response. Exported for tests: this is the
 * one piece of provider-shaped glue, and it must never throw — every caller
 * treats null as "check unavailable" and fails open.
 */
export function textOf(response) {
  if (!response) return null;
  if (typeof response.text === 'string' && response.text.trim()) return response.text;
  const parts = response.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const joined = parts.map((p) => p?.text ?? '').join('').trim();
    if (joined) return joined;
  }
  return null;
}

/** Parse the JSON legality verdict. Exported for tests. Null = unparseable. */
export function parseRuling(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.legal !== 'boolean') return null;
    return { legal: parsed.legal, reason: parsed.reason || null };
  } catch {
    return null;
  }
}

/**
 * Parse the combined judge-and-guess reply. Exported for tests.
 * Returns { legal: false, reason } | { legal: true, guess } | null.
 * Null means "unusable answer" and is treated as an unavailable check.
 */
export function parseGuardedGuess(text) {
  const ruling = parseRuling(text);
  if (!ruling) return null;
  if (!ruling.legal) return { legal: false, reason: ruling.reason };
  const match = String(text).match(/\{[\s\S]*\}/);
  try {
    const { guess, why } = JSON.parse(match[0]);
    if (typeof guess !== 'string' || !guess.trim()) return null;
    // The reasoning is a nicety. A missing or malformed one must never turn a
    // perfectly good guess into a failure, so it is read separately and
    // defaulted to null rather than validated alongside the guess.
    return { legal: true, guess, why: cleanReason(why) };
  } catch {
    return null;
  }
}

/**
 * Tidy a model-written sentence for display. Exported for tests.
 *
 * Length is capped here rather than trusted to the prompt: the card has room
 * for a sentence, and a model that ignores "max 100 tecken" should cost a
 * clipped line, not a broken layout.
 */
export function cleanReason(text) {
  if (typeof text !== 'string') return null;
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > 120 ? `${one.slice(0, 119).trimEnd()}…` : one;
}

/**
 * What kind of failure was that? Exported because the caller's right response
 * differs completely: a quota error means wait, a key error means stop, and
 * anything else means carry on and treat the check as unavailable.
 *
 * Deliberately sloppy about where it looks. The SDK builds its errors on more
 * than one path, and `status` is sometimes the numeric code and sometimes the
 * status text, so matching the message too is what makes this reliable.
 */
export function classifyApiError(err) {
  const status = err?.status;
  const text = `${err?.message ?? ''} ${typeof status === 'string' ? status : ''}`;

  if (status === 429 || /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|\bquota\b/i.test(text)) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403 ||
      /\b401\b|\b403\b|UNAUTHENTICATED|PERMISSION_DENIED|API key not valid|default credentials/i.test(text)) {
    return 'auth'; // retrying cannot help — the key is wrong or missing
  }
  if (status === 500 || status === 503 || /\b50[023]\b|UNAVAILABLE|overloaded/i.test(text)) {
    return 'transient';
  }
  return 'other';
}

/**
 * How long the API asked us to wait, in ms, if it said so. Gemini attaches a
 * RetryInfo to quota errors, and honouring it beats guessing — a per-minute
 * quota wants the rest of that minute, not an exponential ramp.
 */
export function retryDelayMs(err) {
  const m = /"?retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i.exec(err?.message ?? '');
  if (!m) return null;
  const ms = Number(m[1]) * 1000;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 60_000) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries are bounded and short. A quota blip should not cost a player their
// round, but a player is also waiting on this call — so two quick attempts,
// not a patient backoff. The probe, which has time, layers its own retry on
// top via the `ai` seam in judgeClue.
const RETRIES = 2;
const BACKOFF_MS = [700, 1800];

// A quota error can carry retryDelay: "59s". Honouring that literally is right
// for the probe, which has all day — but this same function serves a player
// watching a loading animation, and it made the reels spin for minutes. The
// live path fails fast instead; the probe layers its own patient retry on top
// through judgeClue's `ai` seam, so nothing is lost by capping here.
const MAX_RETRY_WAIT_MS = 1200;

async function generate({ system, contents, maxOutputTokens = MAX_TOKENS, json = false, onFailure }) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await client().models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: system,
          maxOutputTokens,
          temperature: 0, // same clue should tend to the same verdict
          ...(json ? { responseMimeType: 'application/json' } : {}),
        },
      });
    } catch (err) {
      lastErr = err;
      const kind = classifyApiError(err);
      onFailure?.(kind, err);
      // A bad key fails identically on every attempt; waiting just makes the
      // player wait too.
      if (kind === 'auth' || kind === 'other' || attempt === RETRIES) throw err;
      // Never less than our own backoff — a quota error can say retryDelay:
      // "0s", which is not an invitation to retry immediately since the
      // per-minute window has not moved. And never more than the cap, because
      // a player is waiting.
      await sleep(Math.min(Math.max(retryDelayMs(err) ?? 0, BACKOFF_MS[attempt]), MAX_RETRY_WAIT_MS));
    }
  }
  throw lastErr;
}

const userTurn = (text) => ({ role: 'user', parts: [{ text }] });
const modelTurn = (text) => ({ role: 'model', parts: [{ text }] });

/**
 * GUARDED GUESSER — judge and guess in a single call, still blind.
 *
 * The rulebook splits cleanly by what it needs to see:
 *   - "contains the target / a forbidden word" needs the answer, and is
 *     already a deterministic substring check in util.js. No model needed.
 *   - "Swedish only", "no abbreviations", "no spelling or rhyme tricks" are
 *     properties of the CLUE ALONE.
 * So the second group can ride along in the guesser's prompt without the
 * target ever entering the context. Blindness is preserved exactly: this
 * prompt contains the clue and the letter count, nothing else.
 *
 * Returns { legal: false, reason } | { legal: true, guess } | null.
 * Null means the check was unavailable — callers fail open.
 *
 * Known tradeoff: the old separate referee could see the target and so could
 * spot a translation of it directly. Here that is covered indirectly — a
 * translation into another language is not a Swedish word — which misses the
 * rare case where the foreign translation is also a Swedish word ("chef" for
 * kock). Closing that properly means putting translations in the word bank
 * and checking them in code, which is free and deterministic.
 */
export async function guardedGuesser({ clue, letterCount, wordClass, feedback = [], onFailure }) {
  const system = guesserSystemPrompt(letterCount, wordClass);

  const contents = [
    userTurn(`Ledtråd: "${clue}"\nOrdet har ${letterCount} bokstäver.${wordClass ? `\nOrdklass: ${wordClass}.` : ''}`),
  ];
  for (const fb of feedback) {
    contents.push(modelTurn(JSON.stringify({ legal: true, guess: fb.guess })));
    contents.push(userTurn(guessCorrection(fb, letterCount)));
  }

  try {
    const response = await generate({ system, contents, maxOutputTokens: 260, json: true, onFailure });
    return parseGuardedGuess(textOf(response));
  } catch (err) {
    console.error(`guardedGuesser failed (${classifyApiError(err)}):`, err.message);
    return null; // fail open
  }
}

/**
 * The guesser's system prompt. Exported so it can be asserted against.
 *
 * One property matters enough to be a test: no word from the bank may appear
 * here. The guesser is blind, but this text is in its context on every call,
 * and a target named here — even as an example of a *rule* — is a target the
 * model can reach for on a vague clue. That would make those words quietly
 * easier than the rest of the bank, for a reason with nothing to do with the
 * clue. Every illustration below therefore uses words that are not targets.
 */
// The rulebook, written once. The single and batched guessers must judge a
// clue identically — the batched one exists to measure the same game more
// cheaply, and two prompts that drifted apart would measure two different
// games. So both are built from these pieces.

const CLUE_CULTURE = `Spelet går ut på att säga så mycket som möjligt med så få tecken som möjligt, och spelarna tävlar om att vara kortast. Därför är ledtrådarna sällan raka definitioner. Räkna med det motsatta: omskrivningar, oväntade bilder, egna påhittade sammansättningar, sneda infallsvinklar och kluriga associationer — ungefär som ledtrådarna i ett kryptiskt korsord. Att spelaren tänker utanför boxen är meningen med spelet, inte ett problem.`;

const CLUE_RULES = `STEG 1 — bedöm ledtråden. Den är OTILLÅTEN om den:
1. Inte är svenska: ord från andra språk, eller icke-etablerade lånord och anglicismer som används i stället för etablerad svenska. Lånord som sedan länge är etablerade i svenskan (t.ex. kex, jobb, tv) är tillåtna.
2. Bokstaverar eller rimmar sig fram, eller på annat sätt syftar på ordets stavning eller uttal i stället för dess betydelse (t.ex. "börjar på M", "rimmar på hot", uppräkning av bokstäver).
3. Fungerar som en lucka att fylla i i stället för en beskrivning: ett ordled som bara är tänkt att sättas ihop med det sökta ordet till en sammansättning (t.ex. "gräv" för att leda till grävskopa). Testet är enkelt: beskriver ledtråden vad saken ÄR, eller pekar den bara ut vilket ord som råkar sluta sammansättningen? Det senare är otillåtet.
4. Är en uppräkning i stället för en formulering: flera fristående utpekanden på rad, som var för sig associerar till svaret men inte bygger EN språklig enhet ("rep gnista damm", "murken planka flis"). Testet är grammatiskt, inte semantiskt: bildar orden en fras med ett huvudord och dess bestämningar, eller en sats? Då är den tillåten. Är det tre saker uppradade efter varandra är den det inte.
5. Pekar ut en DEL av saken i stället för saken själv: ett föremål, en beståndsdel eller de människor som hör till svaret, men som inte säger vad svaret är ("propeller" för en helikopter, "kugge" för ett urverk). Delen leder till helheten bara genom att man råkar veta var delen brukar sitta, och det är en uppslagning, inte en formulering. Den här regeln kan du först pröva när du vet vad du skulle gissa — se STEG 2.

JÄMFÖR NOGA — skillnaden är strukturen, aldrig antalet ord:
  "blött plask"        TILLÅTEN. Adjektiv + substantiv som kongruerar: ett plask som är blött. En fras.
  "trögt skodon"       TILLÅTEN. Samma sak.
  "en glimt av frost"  TILLÅTEN. Fyra ord, en fras.
  "gnista i mörkret"   TILLÅTEN. Substantiv med prepositionsbestämning.
  "rep gnista damm"    OTILLÅTEN. Tre substantiv utan något som binder dem.

JÄMFÖR OCKSÅ — delen mot beskrivningen (regel 5):
  "propeller"          OTILLÅTEN. Propellern sitter PÅ saken; den säger inte vad saken är.
  "kugge"              OTILLÅTEN. Samma sak: en beståndsdel man slår upp helheten ur.
  "sväva över taken"   TILLÅTEN. Vad saken GÖR, inte något den består av.
  "mäter dygnet"       TILLÅTEN. En funktion, inte en del.

Ett ensamt ord eller en ensam sammansättning är alltid en giltig formulering och ska aldrig avvisas enligt regel 4. Är du osäker på om något är en fras — tillåt den. Regel 4 finns för att stoppa sökordslistor, inte för att beskatta korta ledtrådar.

Viktigt: sammansättningar som *beskriver* saken är fortfarande TILLÅTNA. "tandpinne" som ledtråd till tandborste beskriver vad saken är — det är bra. "blomvatten" som ledtråd till vas beskriver vad den används till — också bra. Det är bara ordled utan egen beskrivande kraft som stoppas.

Lika viktigt: **egennamn och kända exempel på kategorin är TILLÅTNA** — "nilen" för flod, "kreml" för fästning. Regel 1 gäller inte namn: ett egennamn får ha utländskt ursprung, för det är referensen som bär betydelsen, inte språket. Att veta vad Nilen är är just den sortens kunskap spelet efterfrågar. (Ett namn som råkar *vara* målordet på ett annat språk är däremot fortfarande en översättning och otillåtet.)

Detsamma gäller **förkortade** exempel: "sept" och "okt" är samma drag som "nilen", och ska bedömas lika. Förkortningar är inte förbjudna. Det går ändå inte att veta om "jan" är tänkt som en förkortning eller som ett namn, och en regel som inte går att tillämpa konsekvent gör mer skada än nytta — samma ledtråd måste få samma dom varje gång.

Var generös i övrigt. Påhittade svenska sammansättningar, ovanliga bilder, humor och långsökta omskrivningar är TILLÅTNA så länge de är på svenska, hänger ihop språkligt och pekar på betydelse. En ledtråd som känns udda, lekfull eller väl fyndig bryter inte mot reglerna för det — avvisa bara det som klart bryter mot 1–5.`;

/**
 * The bank is mostly nouns, so a model with no class given will reach for one.
 * Saying the class outright is what stops every verb and adjective from being
 * harder for a reason unrelated to the clue — and it gives nothing away that
 * the player cannot already see, since the word is printed on their screen.
 */
function classLine(wordClass) {
  return `Ordet är ett ${wordClass || 'substantiv'}. Gissa ett ord av den ordklassen.`;
}

const GUESS_FORM = `Läs ledtråden som den är tänkt, inte bokstavligt. Fråga dig vad spelaren *pekar mot*, inte vad orden betyder var för sig: en egen sammansättning eller en oväntad bild är ett utsträckt finger, inte en definition. Är ledtråden gåtfull, gör tankevändan innan du svarar — det är den vändan spelet handlar om.`;

// Rule 5 is the one rule that cannot be applied in step 1. Every other rule is
// a property of the clue by itself, but "is this a part of the answer?" needs
// an answer to be a part OF — and the guesser never sees the target. So it is
// checked here instead, against the guesser's own guess, once it has one.
// Blindness is untouched: this reads the model's guess, never the word.
const PART_CHECK = `Innan du svarar: pröva regel 5 mot din egen gissning. Sitter ledtrådens sak i eller på det ord du landat i, utan att säga vad ordet ÄR? Då är ledtråden otillåten — svara med legal: false och nämn att ledtråden pekar ut en del, i stället för att gissa.

Är ledtråden i stället något ordet gör, orsakar, används till, eller påminner om, är den TILLÅTEN. Ett plask är ingen del av ett skodon — det är något skodonet orsakar. Den skillnaden är hela regeln: en del sitter i saken, en beskrivning säger något om den.`;

/**
 * A fingerprint of the rulebook, used to scope the verdict cache.
 *
 * A ruling is only true of the rules that produced it. Cached rulings live as
 * long as the puzzle does, so before this existed, fixing a rule could not
 * reach any clue already judged under the old one: "blött plask" was refused,
 * the refusal was cached for the puzzle's lifetime, and the fix that made it
 * legal was invisible to the one clue it was written for.
 *
 * Derived rather than declared on purpose. A hand-maintained version number is
 * a step someone has to remember during the edit where they are least likely
 * to — mid-fix, focused on the wording. Hashing the text means editing a rule
 * IS bumping the version, and stale rulings cannot outlive the rules.
 */
export const RULEBOOK_ID = createHash('sha1')
  .update([CLUE_CULTURE, CLUE_RULES, GUESS_FORM, PART_CHECK].join('|'))
  .digest('hex')
  .slice(0, 8);

/**
 * The guesser's system prompt. Exported so it can be asserted against.
 *
 * One property matters enough to be a test: no word from the bank may appear
 * here. The guesser is blind, but this text is in its context on every call,
 * and a target named here — even as an example of a *rule* — is a target the
 * model can reach for on a vague clue. That would make those words quietly
 * easier than the rest of the bank, for a reason with nothing to do with the
 * clue. Every illustration therefore uses words that are not targets.
 */
export function guesserSystemPrompt(letterCount, wordClass) {
  return `Du är gissaren i ordspelet Ordknapp. En spelare har skrivit en ledtråd till ett hemligt svenskt ord. Du får aldrig se ordet. Gör två saker, i ordning:

${CLUE_CULTURE}

${CLUE_RULES}

STEG 2 — om ledtråden är tillåten: gissa ordet. Exakt ETT riktigt, etablerat svenskt ord i grundform (obestämd form singular för substantiv, infinitiv för verb, grundform för adjektiv) med exakt ${letterCount} bokstäver. Hitta inte på ord.
${classLine(wordClass)}

${GUESS_FORM}

${PART_CHECK}

Skriv också EN kort mening om hur du läste ledtråden och varför den ledde dig till just det ordet. Den visas för spelaren, så den ska förklara din tolkning — inte upprepa ledtråden. Max 100 tecken.

Svara ENDAST med JSON:
{"legal": true, "guess": "ordet", "why": "kort mening om din tolkning"}
eller
{"legal": false, "reason": "kort motivering på svenska"}`;
}

/**
 * Parse the batched reply into a Map of id -> ruling. Exported for tests.
 *
 * A missing or malformed entry is simply absent from the map, and the caller
 * re-asks for those one at a time. Batching is an optimisation; it must never
 * be able to turn a clue into a wrong answer, only into a slower one.
 */
export function parseBatchGuesses(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  let answers;
  try {
    answers = JSON.parse(match[0]).answers;
  } catch {
    return null;
  }
  if (!Array.isArray(answers)) return null;

  const out = new Map();
  for (const a of answers) {
    const id = Number(a?.id);
    if (!Number.isInteger(id) || typeof a?.legal !== 'boolean') continue;
    if (a.legal === false) {
      out.set(id, { legal: false, reason: a.reason || null });
    } else if (typeof a.guess === 'string' && a.guess.trim()) {
      out.set(id, { legal: true, guess: a.guess, why: cleanReason(a.why) });
    }
  }
  return out;
}

/**
 * Judge and guess several clues in one call.
 *
 * `items` is [{ id, clue, letterCount }]. Returns a Map of id -> ruling, or
 * null if the call itself failed. Ids missing from the map got no usable
 * answer and must be re-asked individually.
 */
export async function batchedGuesser({ items, onFailure }) {
  if (!items?.length) return new Map();
  const lines = items.map((it) =>
    `${it.id}. Ledtråd: "${it.clue}" — ${it.letterCount} bokstäver${it.wordClass ? `, ${it.wordClass}` : ''}`);

  try {
    const response = await generate({
      system: batchGuesserSystemPrompt(),
      contents: [userTurn(lines.join('\n'))],
      // Each answer is short, but a truncated reply loses the whole batch.
      maxOutputTokens: 190 * items.length + 200,
      json: true,
      onFailure,
    });
    return parseBatchGuesses(textOf(response));
  } catch (err) {
    console.error(`batchedGuesser failed (${classifyApiError(err)}):`, err.message);
    return null;
  }
}

/**
 * The same job, several clues at a time. Exported for tests.
 *
 * This is a measurement shortcut, not a second way to play: it exists so the
 * probe can cover a word in a few calls instead of one per clue. It is NOT
 * used by the live game, where every clue is judged alone.
 *
 * The honesty problem is that the clues sit in one context, so the model can
 * read them against each other — several clues circling the same idea give
 * away far more together than any of them does alone. The instruction below
 * pushes against that, but an instruction cannot remove information from a
 * context window, so it can only reduce the leak and never close it. That is
 * why the probe can measure the difference (--batch-check) rather than
 * assuming it away.
 */
export function batchGuesserSystemPrompt() {
  return `Du är gissaren i ordspelet Ordknapp. Du får flera ledtrådar på en gång, till olika hemliga svenska ord. Du får aldrig se orden.

${CLUE_CULTURE}

VIKTIGAST AV ALLT: ledtrådarna kommer från olika spelare som inte kan se varandras ledtrådar, och de gäller olika ord. Behandla varje ledtråd helt för sig. Läs ledtråden och dess bokstavsantal — inget annat. Låt inte de andra ledtrådarna påverka din gissning, och dra inga slutsatser av att flera ledtrådar råkar ha samma bokstavsantal eller verka handla om liknande saker. Gissa som om du bara hade sett den ena.

${CLUE_RULES}

STEG 2 — om ledtråden är tillåten: gissa ordet. Exakt ETT riktigt, etablerat svenskt ord i grundform (obestämd form singular för substantiv, infinitiv för verb, grundform för adjektiv) med exakt det antal bokstäver som anges för just den ledtråden. Anges en ordklass ska gissningen vara av den ordklassen; anges ingen är ordet ett substantiv. Hitta inte på ord.

${GUESS_FORM}

${PART_CHECK}

Skriv också för varje gissning EN kort mening om hur du läste ledtråden. Max 100 tecken.

Svara ENDAST med JSON, ett svar per ledtråd, med samma id som i frågan:
{"answers": [{"id": 1, "legal": true, "guess": "ordet", "why": "kort mening"}, {"id": 2, "legal": false, "reason": "kort motivering"}]}`;
}

// Two corrections, both about the guess breaking its own rules: wrong length
// (caught in code) and not a real word (caught by the dictionary). Either way
// the player wrote a legal clue, so the AI is re-prompted until it complies.
function guessCorrection(fb, letterCount) {
  return fb.problem === 'length'
    ? `"${fb.guess}" har inte exakt ${letterCount} bokstäver. Gissa ett annat ord med exakt ${letterCount} bokstäver. Svara med samma JSON-format.`
    : `"${fb.guess}" är inte ett etablerat svenskt ord. Gissa ett riktigt svenskt ord i grundform med exakt ${letterCount} bokstäver. Svara med samma JSON-format.`;
}

export const MODEL_ID = MODEL;
