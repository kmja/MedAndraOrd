import Anthropic from '@anthropic-ai/sdk';

// The three AI roles. Everything Swedish lives in these prompts (plus the word
// bank) — shipping another language means translating the three prompts and
// supplying a word list; nothing structural changes.
//
// The API key never leaves this server. A small model suffices for these roles
// (the handover spec's explicit cost call); override with LEDTRADEN_MODEL.

const MODEL = process.env.LEDTRADEN_MODEL || 'claude-haiku-4-5';
const MAX_TOKENS = 300;

let _client = null;
function client() {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return _client;
}

function firstText(response) {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

/**
 * REFEREE — runs before the guesser and, unlike it, sees everything: target,
 * forbidden list, clue. Its prompt is the rulebook, grown from playtested
 * exploits. Returns { legal, reason } or null on failure (callers fail open:
 * a flaky check never blocks play).
 */
export async function referee({ target, forbidden, clue }) {
  const system = `Du är domare i ordspelet Ledtråden. En spelare skriver en ledtråd för att få en AI att gissa ett hemligt ord. Din uppgift är att avgöra om ledtråden är tillåten enligt reglerna.

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
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = firstText(response);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.legal !== 'boolean') return null;
    return { legal: parsed.legal, reason: parsed.reason || null };
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
  const system = `Du är gissaren i ordspelet Ledtråden. Du får en ledtråd och ska gissa ett hemligt svenskt ord.

Krav på din gissning:
- Exakt ETT ord.
- Ett riktigt, etablerat svenskt ord i grundform (obestämd form singular för substantiv, infinitiv för verb).
- Ordet har exakt ${letterCount} bokstäver.
- Hitta inte på ord. Om du är osäker, välj det vanligaste ordet som passar.

Svara ENDAST med ordet, inget annat.`;

  const messages = [
    { role: 'user', content: `Ledtråd: "${clue}"\nOrdet har ${letterCount} bokstäver. Vad är ordet?` },
  ];
  for (const fb of feedback) {
    messages.push({ role: 'assistant', content: fb.guess });
    if (fb.problem === 'length') {
      messages.push({
        role: 'user',
        content: `"${fb.guess}" har inte exakt ${letterCount} bokstäver. Gissa ett annat ord med exakt ${letterCount} bokstäver.`,
      });
    } else {
      messages.push({
        role: 'user',
        content: `"${fb.guess}" är inte ett etablerat svenskt ord i grundform. Gissa ett riktigt svenskt ord med exakt ${letterCount} bokstäver.`,
      });
    }
  }

  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 50,
      system,
      messages,
    });
    return firstText(response);
  } catch (err) {
    console.error('guesser failed:', err.message);
    return null;
  }
}

/**
 * VERIFIER — second opinion on whether a right-length guess is a real,
 * established Swedish word (instructions alone fail; the guesser has
 * confabulated words like "morotsnäsa"). Returns true/false, or null on
 * failure (callers fail open — and this whole role can be replaced by a
 * server-side dictionary lookup, which is strictly better).
 */
export async function verifier(word) {
  try {
    const response = await client().messages.create({
      model: MODEL,
      max_tokens: 10,
      system:
        'Du avgör om ett ord är ett riktigt, etablerat svenskt ord i grundform. Svara ENDAST "JA" eller "NEJ".',
      messages: [{ role: 'user', content: `Är "${word}" ett riktigt, etablerat svenskt ord i grundform?` }],
    });
    const text = firstText(response).trim().toUpperCase();
    if (text.startsWith('JA')) return true;
    if (text.startsWith('NEJ')) return false;
    return null;
  } catch (err) {
    console.error('verifier failed:', err.message);
    return null; // fail open
  }
}
