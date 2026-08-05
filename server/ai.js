import { GoogleGenAI } from '@google/genai';

// The three AI roles. Everything Swedish lives in these prompts (plus the word
// bank) — shipping another language means translating the three prompts and
// supplying a word list; nothing structural changes.
//
// The API key never leaves this server.
//
// Model choice is a cost decision. The workload is tiny per call (the biggest
// prompt is ~320 tokens) and the clue cache dedupes repeats, so the cheapest
// capable model wins. Default: Gemini 3.1 Flash-Lite. Note that
// gemini-2.5-flash-lite is cheaper still but retires 2026-10-16 — not worth
// building on. Override with ORDKNAPP_MODEL to try a stronger model if the
// referee's Swedish judgment proves too loose.
//
// Thinking level is deliberately left unset: 3.1 Flash-Lite already defaults
// to "minimal", which is what these three classification-shaped tasks want.
// Set it explicitly only after verifying the field against a live key —
// a rejected config would make every call fail, and the referee fails OPEN.

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

/** Parse the referee's JSON verdict. Exported for tests. Null = unparseable. */
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
    const guess = JSON.parse(match[0]).guess;
    if (typeof guess !== 'string' || !guess.trim()) return null;
    return { legal: true, guess };
  } catch {
    return null;
  }
}

function generate({ system, contents, maxOutputTokens = MAX_TOKENS, json = false }) {
  return client().models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: system,
      maxOutputTokens,
      temperature: 0, // same clue should tend to the same verdict
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
  });
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
export async function guardedGuesser({ clue, letterCount, feedback = [] }) {
  const system = `Du är gissaren i ordspelet Ordknapp. En spelare har skrivit en ledtråd till ett hemligt svenskt ord. Du får aldrig se ordet. Gör två saker, i ordning:

STEG 1 — bedöm ledtråden. Den är OTILLÅTEN om den:
1. Inte är svenska: ord från andra språk, eller icke-etablerade lånord och anglicismer som används i stället för etablerad svenska. Lånord som sedan länge är etablerade i svenskan (t.ex. paraply, jobb, tv) är tillåtna.
2. Innehåller förkortningar.
3. Bokstaverar eller rimmar sig fram, eller på annat sätt syftar på ordets stavning eller ljud i stället för dess betydelse (t.ex. "börjar på M", "rimmar på hot", uppräkning av bokstäver).

Var generös i övrigt. Påhittade svenska sammansättningar, ovanliga bilder och kreativa omskrivningar är TILLÅTNA så länge de är på svenska och beskriver betydelse. Avvisa bara det som klart bryter mot 1–3.

STEG 2 — om ledtråden är tillåten: gissa ordet. Exakt ETT riktigt, etablerat svenskt ord i grundform (obestämd form singular för substantiv, infinitiv för verb) med exakt ${letterCount} bokstäver. Hitta inte på ord.

Svara ENDAST med JSON:
{"legal": true, "guess": "ordet"}
eller
{"legal": false, "reason": "kort motivering på svenska"}`;

  const contents = [
    userTurn(`Ledtråd: "${clue}"\nOrdet har ${letterCount} bokstäver.`),
  ];
  for (const fb of feedback) {
    contents.push(modelTurn(JSON.stringify({ legal: true, guess: fb.guess })));
    contents.push(userTurn(guessCorrection(fb, letterCount)));
  }

  try {
    const response = await generate({ system, contents, maxOutputTokens: 150, json: true });
    return parseGuardedGuess(textOf(response));
  } catch (err) {
    console.error('guardedGuesser failed:', err.message);
    return null; // fail open
  }
}

function guessCorrection(fb, letterCount) {
  return fb.problem === 'length'
    ? `"${fb.guess}" har inte exakt ${letterCount} bokstäver. Gissa ett annat ord med exakt ${letterCount} bokstäver. Svara med samma JSON-format.`
    : `"${fb.guess}" är inte ett etablerat svenskt ord i grundform. Gissa ett riktigt svenskt ord med exakt ${letterCount} bokstäver. Svara med samma JSON-format.`;
}

/**
 * VERIFIER — second opinion on whether a right-length guess is a real,
 * established Swedish word (instructions alone fail; the guesser has
 * confabulated words like "morotsnäsa"). Returns true/false, or null on
 * failure (callers fail open).
 *
 * This is the role to delete first: a server-side dictionary lookup is
 * strictly better and removes up to a third of all model calls.
 */
export async function verifier(word) {
  try {
    const response = await generate({
      system:
        'Du avgör om ett ord är ett riktigt, etablerat svenskt ord i grundform. Svara ENDAST "JA" eller "NEJ".',
      contents: [userTurn(`Är "${word}" ett riktigt, etablerat svenskt ord i grundform?`)],
      maxOutputTokens: 10,
    });
    const text = (textOf(response) ?? '').trim().toUpperCase();
    if (text.startsWith('JA')) return true;
    if (text.startsWith('NEJ')) return false;
    return null;
  } catch (err) {
    console.error('verifier failed:', err.message);
    return null; // fail open
  }
}

export const MODEL_ID = MODEL;
