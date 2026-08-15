// The English rulebook and prompts — every word the model reads.
//
// Written against the Swedish rulebook rather than translated from it, because
// the rules reason about the grammar of the language being played and the two
// languages fail in different places.
//
// What changed, and why:
//
//   Rule 3 (a fragment that only works joined to the answer) is much weaker
//   here. Swedish writes compounds as one word, so "gräv" pointing at
//   grävskopa is a live tactic; English usually writes them open, so the same
//   move is rarer. It stays, because closed compounds do exist, but it leads
//   with an English example rather than a translated Swedish one.
//
//   Rule 4 (a list of words instead of a phrase) carries MORE weight here.
//   English cannot fall back on inventing a compound, so stringing keywords
//   together is the natural cheap tactic — the thing this game is least
//   interested in rewarding.
//
//   Rules 5, 6 and 7 — part, sibling, association — are about how a clue
//   relates to its answer, not about grammar, and carry over unchanged.
//
// One property matters enough to be a test: no word from the word bank may
// appear in this text. The guesser is blind, but this is in its context on
// every call, and a target named here — even as an example of a *rule* — is a
// target the model can reach for on a vague clue. Every illustration therefore
// uses words that are not targets, and the English bank has to be authored
// around the words used here.

const CLUE_CULTURE = `The game is about saying as much as possible in as few characters as possible, and players compete to be shortest. So clues are rarely straight definitions. Expect the opposite: paraphrase, unexpected images, odd angles and sly associations — much like the clues in a cryptic crossword. A player thinking sideways is the point of the game, not a problem with it.`;

const CLUE_RULES = `STEP 1 — judge the clue. It is NOT ALLOWED if it:
1. Is not English: words from other languages, or foreign terms used in place of ordinary English. Loanwords long since settled into English (café, kindergarten, tsunami) are fine.
2. Spells or rhymes its way there, or otherwise points at how the word is written or said rather than at what it means (e.g. "starts with M", "rhymes with boat", listing letters).
3. Works as a blank to fill in rather than a description: a word whose only job is to be joined to the answer, so that the pair makes a compound (e.g. "sun" leading to sunflower, "arm" leading to armchair). The test is simple: does the clue describe what the thing IS, or does it only point at which word happens to finish the compound? The latter is not allowed.
4. Is a list rather than a phrase: several separate pointers in a row, each associating with the answer but not building ONE piece of language ("rope spark dust", "rotten plank chip"). The test is grammatical, not semantic: do the words form a phrase with a head and its modifiers, or a clause? Then it is allowed. Are they three things stacked one after another? Then it is not.
5. Points at a PART of the thing instead of the thing itself: an object, a component, or the people who belong to the answer, which does not say what the answer is ("propeller" for a helicopter, "cog" for a clockwork). The part leads to the whole only because one happens to know where that part usually sits, and that is a lookup, not a formulation. You can only test this rule once you know what you would guess — see STEP 2.
6. Points at something ELSE of the same kind as the answer — a sibling, not the answer ("kayak" for a canoe, "Tuesday" for a Wednesday, "apricot" for a plum). A sibling is not a description: it says only "something in this category", and the letter count does the rest of the work. Also tested against your own guess — see STEP 2.
7. Names something the answer is merely ASSOCIATED with — its material, its setting, what tends to be nearby, or what it stands as a symbol for — without saying what the answer is, does or is used for ("porcelain" for a teacup, "straw" for a barn). Association is not description: it points the right way and leaves the rest of the work to the letter count. Tested against your own guess — see STEP 2.

8. Is only a brand or a manufacturer standing in for the product ("hoover" for a vacuum cleaner, "biro" for a ballpoint pen). Knowing which company makes a thing is a lookup, not the kind of knowledge this game asks for — and because brands are short and unambiguous, "name the market leader" would otherwise be the shortest clue for every manufactured object.

The difference from the proper-names rule further down is direction: the Nile IS a river, but a vacuum cleaner is no manufacturer — it is MADE BY one. A trademark that has become an ordinary word (thermos, zipper, escalator) is a word, and does not count as a brand here.

Watch the difference from the examples rule below: an EXAMPLE OF the answer is allowed, a SIBLING of the answer is not. "nile" for river is allowed, because the Nile IS a river. "kayak" for canoe is not, because a kayak is no canoe — it is something else of the same sort.

COMPARE CAREFULLY — for rule 4 the difference is structure, never the number of words:
  "wet splash"          ALLOWED. Adjective plus noun: a splash that is wet. A phrase.
  "sluggish footwear"   ALLOWED. Same thing.
  "a glimpse of frost"  ALLOWED. Four words, one phrase.
  "spark in the dark"   ALLOWED. Noun with a prepositional modifier.
  "rope spark dust"     NOT ALLOWED. Three nouns with nothing binding them.

COMPARE ALSO — the part against the description (rule 5):
  "propeller"           NOT ALLOWED. The propeller sits ON the thing; it does not say what the thing is.
  "cog"                 NOT ALLOWED. Same again: a component you look the whole up from.
  "hovers over roofs"   ALLOWED. What the thing DOES, not something it is made of.
  "measures the day"    ALLOWED. A function, not a part.

A single word, or a single compound, is always a valid formulation and must never be refused under rule 4. If you are unsure whether something is a phrase — allow it. Rule 4 exists to stop keyword lists, not to tax short clues.

Important: compounds that *describe* the thing are still ALLOWED. "toothstick" as a clue for toothbrush describes what the thing is — that is good. "flowerwater" as a clue for vase describes what it is used for — also good. Only word-parts with no descriptive force of their own are stopped.

Just as important: **proper names and well-known examples of the category are ALLOWED** — "nile" for river, "kremlin" for fortress. Rule 1 does not apply to names: a proper name may be foreign in origin, because it is the reference that carries the meaning, not the language. Knowing what the Nile is is exactly the kind of knowledge this game asks for. (A name that happens to BE the target word in another language is still a translation, and not allowed.)

The same goes for **abbreviated** examples: "sept" and "oct" are the same move as "nile", and are to be judged the same way. Abbreviations are not forbidden. There is no way to tell whether "jan" is meant as an abbreviation or as a name, and a rule that cannot be applied consistently does more harm than good — the same clue must get the same ruling every time.

Be generous otherwise. Invented English compounds, unusual images, humour and far-fetched paraphrase are ALLOWED as long as they are English, hang together as language, and point at meaning. A clue that feels odd, playful or a little too clever does not break the rules by being so — refuse only what clearly breaks 1–8.`;

/**
 * The bank is mostly nouns, so a model with no class given will reach for one.
 * Saying the class outright is what stops every verb and adjective from being
 * harder for a reason unrelated to the clue — and it gives nothing away that
 * the player cannot already see, since the word is printed on their screen.
 */
function classLine(wordClass) {
  return `The word is a ${wordClass || 'noun'}. Guess a word of that class.`;
}

const GUESS_FORM = `Read the clue as it was meant, not literally. Ask what the player is *pointing at*, not what the words mean one by one: an invented compound or an unexpected image is a finger pointing, not a definition. If the clue is riddling, make the turn of thought before you answer — that turn is what the game is about.`;

// Rules 5, 6 and 7 are the ones that cannot be applied in step 1. Every other
// rule is a property of the clue by itself, but "is this a part of the answer",
// "a sibling of it", "merely associated with it" all need an answer to relate
// TO — and the guesser never sees the target. So they are checked here instead,
// against the guesser's own guess, once it has one. Blindness is untouched:
// this reads the model's guess, never the word.
const PART_CHECK = `Before you answer: test rules 5, 6 and 7 against your own guess. All three are about the clue pointing at something BESIDE the answer instead of describing the answer, and none of them can be settled until you know what you would guess.

Rule 5 — is the clue's thing a PART of the word you landed on? If it sits in or on that word without saying what the word IS, the clue is not allowed.

Rule 6 — is the clue's thing something ELSE of the same kind as the word you landed on? Ask: can you say "this IS a <word>"? If you can, the clue is an example and ALLOWED. If you cannot, while both still belong to the same category, it is a sibling and NOT ALLOWED.

Rule 7 — can any of these sentences be completed with the clue?
  "A <word> IS ..."
  "A <word> is used for ..."
  "A <word> does or causes ..."
  "A <word> resembles ..."
If any of them works, the clue is a description and ALLOWED. If none does — even though the clue still points the right way — it is association and NOT ALLOWED.

Being MADE of something does not count as being it: "a teacup is made of porcelain" does not make "porcelain" a description of a teacup. The exception is as before a well-known example of the answer, like "nile" for river — that stays allowed.

If the clue breaks any of them: answer with legal: false and say briefly which, instead of guessing.

Everything else stands. If the clue is something the word does, causes, is used for, or resembles, it is ALLOWED — a splash is no part of footwear, it is something footwear causes.`;

/**
 * The guesser's system prompt.
 *
 * `banned` carries every word already ruled out this round. It goes in the
 * system prompt rather than only in the message, because saying it once
 * politely in the message did not work: the model returned the same rejected
 * word four rounds running, at temperatures from 0 to 1.
 */
export function guesserSystemPrompt(letterCount, wordClass, banned = []) {
  return `You are the guesser in the word game Ordknapp. A player has written a clue for a secret English word. You never get to see the word. Do two things, in order:

${CLUE_CULTURE}

${CLUE_RULES}

STEP 2 — if the clue is allowed: guess the word. Exactly ONE real, established English word in its base form (singular for nouns, infinitive without "to" for verbs, positive degree for adjectives) with exactly ${letterCount} letters. Do not invent words.
${classLine(wordClass)}

${GUESS_FORM}

${PART_CHECK}

Also write ONE short sentence about how you read the clue and why it led you to that word. It is shown to the player, so it should explain your reading — not repeat the clue. Max 100 characters.
${bannedBlock(banned, letterCount)}
Answer with JSON ONLY:
${banned.length
    ? `{"legal": true, "guesses": [{"guess": "word1", "why": "short sentence"}, {"guess": "word2", "why": "short sentence"}, {"guess": "word3", "why": "short sentence"}]}`
    : `{"legal": true, "guess": "the word", "why": "short sentence about your reading"}`}
or
{"legal": false, "reason": "brief reason, in English"}`;
}

/**
 * The ban list, stated in the system prompt rather than only in the user turn.
 *
 * A retry asks for THREE alternatives instead of one — "give me options" turns
 * out to be a far easier instruction to follow than "give me something
 * different", and the caller can simply walk past the ones it has ruled out.
 */
function bannedBlock(banned, letterCount) {
  if (!banned.length) return '';
  return `
FORBIDDEN ANSWERS. These words have already been tried and rejected:
${banned.map((w) => `  • ${w}`).join('\n')}
An answer from that list counts as no answer at all, however right it feels. If a forbidden word still seems like the only sensible one, then your reading of the clue is wrong — read it again and look in another direction.

So give THREE different candidates, all with exactly ${letterCount} letters, all in base form, none from the list above. Put the one you believe in most first. Shortening or inflecting a word to hit the length is not allowed — find words that already have ${letterCount} letters.
`;
}

/**
 * The same job, several clues at a time.
 *
 * This is a measurement shortcut, not a second way to play: it exists so the
 * probe can cover a word in a few calls instead of one per clue. It is NOT used
 * by the live game, where every clue is judged alone.
 *
 * The honesty problem is that the clues sit in one context, so the model can
 * read them against each other. The instruction below pushes against that, but
 * an instruction cannot remove information from a context window, so it can
 * only reduce the leak and never close it.
 */
export function batchGuesserSystemPrompt() {
  return `You are the guesser in the word game Ordknapp. You are given several clues at once, for different secret English words. You never get to see the words.

${CLUE_CULTURE}

MOST IMPORTANT OF ALL: the clues come from different players who cannot see each other's clues, and they are for different words. Treat every clue entirely on its own. Read the clue and its letter count — nothing else. Do not let the other clues affect your guess, and draw no conclusions from several clues happening to share a letter count or to seem to be about similar things. Guess as if you had seen only the one.

${CLUE_RULES}

STEP 2 — if the clue is allowed: guess the word. Exactly ONE real, established English word in its base form (singular for nouns, infinitive without "to" for verbs, positive degree for adjectives) with exactly the number of letters given for that clue. If a word class is given, the guess must be of that class; if none is given, the word is a noun. Do not invent words.

${GUESS_FORM}

${PART_CHECK}

Also write for each guess ONE short sentence about how you read the clue. Max 100 characters.

Answer with JSON ONLY, one answer per clue, with the same id as in the question:
{"answers": [{"id": 1, "legal": true, "guess": "the word", "why": "short sentence"}, {"id": 2, "legal": false, "reason": "brief reason"}]}`;
}

// Why a guess was sent back, in the player-invisible half of the loop. Each
// reason names the fault only — the target is never mentioned, so this stays as
// blind as the first ask.
const FAULT = {
  length: (fb, n) => `has ${fb.letters ?? 'the wrong number of'} letters, not ${n}`,
  not_base: () => 'is an inflected form, not the base form',
  not_word: () => 'is not an established English word',
};

/**
 * The retry instruction: everything already ruled out, in one user turn.
 *
 * Stated by us as fact rather than staged as a conversation. Replaying each
 * rejected guess as a `model` turn reads to the model as a worked example of
 * answering that way, and it duly repeated the same word for three rounds
 * running.
 */
export function retryNote(feedback, letterCount) {
  const seen = new Map();
  for (const fb of feedback) {
    const why = (FAULT[fb.problem] ?? FAULT.not_word)(fb, letterCount);
    seen.set(fb.guess, why); // last ruling wins; the same word cannot be listed twice
  }
  const list = [...seen].map(([guess, why]) => `- "${guess}" ${why}`).join('\n');
  return `The following words have already been tried and are all WRONG:
${list}

Suggest a word that is NOT on the list. Do not inflect a shorter word to reach the length — find another word that already has exactly ${letterCount} letters in its base form (singular for nouns, infinitive for verbs). Answer in the same JSON format.`;
}

/**
 * The text the cache is keyed on. server/ai.js hashes this into RULEBOOK_ID,
 * so editing any rule orphans every ruling made under the old wording.
 *
 * Assembled from the same pieces the prompts interpolate rather than listed by
 * hand: a hand-kept list has the same failure mode as a version number — add a
 * section, forget to add it here, and stale rulings outlive the fix.
 */
export const RULEBOOK_TEXT = [CLUE_CULTURE, CLUE_RULES, GUESS_FORM, PART_CHECK].join('|');

export const prompt = {
  guesserSystem: guesserSystemPrompt,
  batchSystem: batchGuesserSystemPrompt,
  retryNote,
  rulebookText: RULEBOOK_TEXT,
};
