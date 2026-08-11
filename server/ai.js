import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';

import { LOCALE } from './locale.js';

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
 * Returns { legal: false, reason } | { legal: true, candidates, guess, why } | null.
 * Null means "unusable answer" and is treated as an unavailable check.
 *
 * A retry asks for several alternatives at once, so the reply may carry either
 * one `guess` or a list of `guesses`. Both shapes normalise to `candidates`,
 * and the caller walks them in order — asking for options turned out to be a
 * far easier instruction to follow than asking for something different.
 */
export function parseGuardedGuess(text) {
  const ruling = parseRuling(text);
  if (!ruling) return null;
  if (!ruling.legal) return { legal: false, reason: ruling.reason };
  const match = String(text).match(/\{[\s\S]*\}/);
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const candidates = [];
  const add = (guess, why) => {
    // The reasoning is a nicety. A missing or malformed one must never turn a
    // perfectly good guess into a failure, so it is read separately and
    // defaulted to null rather than validated alongside the guess.
    if (typeof guess === 'string' && guess.trim()) candidates.push({ guess, why: cleanReason(why) });
  };
  add(parsed.guess, parsed.why);
  if (Array.isArray(parsed.guesses)) {
    for (const g of parsed.guesses) {
      if (typeof g === 'string') add(g, parsed.why);
      else add(g?.guess, g?.why ?? parsed.why);
    }
  }
  if (!candidates.length) return null;
  return { legal: true, candidates, guess: candidates[0].guess, why: candidates[0].why };
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

async function generate({ system, contents, maxOutputTokens = MAX_TOKENS, json = false, temperature = 0, onFailure }) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await client().models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: system,
          maxOutputTokens,
          temperature,
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
  // Every word already ruled out, in the order it was tried.
  const banned = [];
  for (const fb of feedback) if (!banned.includes(fb.guess)) banned.push(fb.guess);
  const system = guesserSystemPrompt(letterCount, wordClass, banned);

  // One user turn, never a replayed dialogue. Pushing the rejected guesses
  // back as `model` turns built a transcript that demonstrated the wrong
  // lesson — three rounds of "when asked this, answer klock", each followed by
  // an identical complaint. That is few-shot priming for exactly the word we
  // are asking it to avoid, and no temperature setting beats a pattern the
  // context is teaching. Rejected guesses are now stated as fact, by us.
  const ask = `Ledtråd: "${clue}"\nOrdet har ${letterCount} bokstäver.${wordClass ? `\nOrdklass: ${wordClass}.` : ''}`;
  const contents = [userTurn(feedback.length ? `${ask}\n\n${retryNote(feedback, letterCount)}` : ask)];

  try {
    const response = await generate({
      system, contents, json: true,
      // A retry asks for three candidates with a sentence each. Truncation
      // loses the whole round, so the ceiling moves with what was asked for.
      maxOutputTokens: banned.length ? 600 : 260,
      temperature: retryTemperature(feedback.length), onFailure,
    });
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
 *
 * The locale code is part of it too. The two editions share a KV database, and
 * a clue can be legal in one language and refused in the other.
 */
export const RULEBOOK_ID = createHash('sha1')
  .update(`${LOCALE.code}|${LOCALE.prompt.rulebookText}`)
  .digest('hex')
  .slice(0, 8);

// Re-exported so tests and scripts can assert against the active language's
// prompts without knowing which locale is loaded.
export const guesserSystemPrompt = LOCALE.prompt.guesserSystem;
export const batchGuesserSystemPrompt = LOCALE.prompt.batchSystem;
export const retryNote = LOCALE.prompt.retryNote;

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
 * How much to let the model wander, given how many corrections it has had.
 * Exported for tests.
 *
 * The first answer to a clue stays deterministic: identical clues should tend
 * to identical verdicts, and that answer is the one that gets cached. But a
 * retry exists precisely to produce a DIFFERENT word, and asking a
 * temperature-0 model again is asking it to repeat itself. It obliged — four
 * rounds, four times "klock".
 */
export function retryTemperature(corrections) {
  if (corrections === 0) return 0;
  // Rounded, because 0.4 + 0.2 * 1 is 0.6000000000000001 in binary floating
  // point and that goes into an API request body.
  return Math.round(Math.min(0.4 + 0.2 * corrections, 1) * 10) / 10;
}

export const MODEL_ID = MODEL;
