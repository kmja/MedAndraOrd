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
 * REFEREE — runs before the guesser and, unlike it, sees everything: target,
 * forbidden list, clue. Its prompt is the rulebook, grown from playtested
 * exploits. Returns { legal, reason } or null on failure (callers fail open:
 * a flaky check never blocks play).
 */
export async function referee({ target, forbidden, clue }) {
  const system = `Du är domare i ordspelet Ordknapp. En spelare skriver en ledtråd för att få en AI att gissa ett hemligt ord. Din uppgift är att avgöra om ledtråden är tillåten enligt reglerna.

REGLER — ledtråden är OTILLÅTEN om den:
1. Innehåller målordet, en böjning eller avledning av det (t.ex. plural, bestämd form, sammansättning).
2. Innehåller något av de förbjudna orden eller böjningar av dem.
3. Är eller innehåller en översättning av målordet till något annat språk (engelska, tyska, franska, spanska, eller något annat språk).
4. Inte är svenska: icke-etablerade lånord eller anglicismer som används i stället för etablerad svenska är otillåtna. Lånord som sedan länge är etablerade i svenskan (t.ex. paraply, jobb, tv) är tillåtna.
5. Innehåller förkortningar.
6. Använder bokstaveringstrick eller rimtrick (t.ex. "börjar på M", "rimmar på hot", uppräkning av bokstäver).

Var inte onödigt sträng: en vanlig svensk ledtråd som beskriver ordet utan att bryta mot reglerna ovan ska godkännas.

Svara ENDAST med JSON på exakt denna form:
{"legal": true} eller {"legal": false, "reason": "kort motivering på svenska"}`;

  const user = `Målord: ${target}
Förbjudna ord: ${forbidden.join(', ')}
Ledtråd: "${clue}"`;

  try {
    const response = await generate({ system, contents: [userTurn(user)], json: true });
    return parseRuling(textOf(response));
  } catch (err) {
    console.error('referee failed:', err.message);
    return null; // fail open
  }
}

/**
 * GUESSER — blind: the prompt contains only the clue and the target's letter
 * count, never the answer. This blindness is the game's integrity guarantee.
 * `feedback` carries corrections from earlier rounds of the retry loop.
 * Returns raw response text, or null on API failure.
 */
export async function guesser({ clue, letterCount, feedback = [] }) {
  const system = `Du är gissaren i ordspelet Ordknapp. Du får en ledtråd och ska gissa ett hemligt svenskt ord.

Krav på din gissning:
- Exakt ETT ord.
- Ett riktigt, etablerat svenskt ord i grundform (obestämd form singular för substantiv, infinitiv för verb).
- Ordet har exakt ${letterCount} bokstäver.
- Hitta inte på ord. Om du är osäker, välj det vanligaste ordet som passar.

Svara ENDAST med ordet, inget annat.`;

  const contents = [
    userTurn(`Ledtråd: "${clue}"\nOrdet har ${letterCount} bokstäver. Vad är ordet?`),
  ];
  for (const fb of feedback) {
    contents.push(modelTurn(fb.guess));
    if (fb.problem === 'length') {
      contents.push(
        userTurn(
          `"${fb.guess}" har inte exakt ${letterCount} bokstäver. Gissa ett annat ord med exakt ${letterCount} bokstäver.`,
        ),
      );
    } else {
      contents.push(
        userTurn(
          `"${fb.guess}" är inte ett etablerat svenskt ord i grundform. Gissa ett riktigt svenskt ord med exakt ${letterCount} bokstäver.`,
        ),
      );
    }
  }

  try {
    const response = await generate({ system, contents, maxOutputTokens: 50 });
    return textOf(response);
  } catch (err) {
    console.error('guesser failed:', err.message);
    return null;
  }
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
