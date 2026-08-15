// The Swedish rulebook and prompts — every word the model reads.
//
// This is the other half of what a language consists of, alongside morphology.
// server/ai.js keeps the parts that are the same in any language: the client,
// retries, temperature, parsing, error classification. Nothing here is
// translated from anywhere; a second language rewrites these rather than
// mirroring them, because the rules reason about the grammar of the language
// being played.
//
// One property matters enough to be a test: no word from the word bank may
// appear in any of this text. The guesser is blind, but this is in its context
// on every call, and a target named here — even as an example of a *rule* — is
// a target the model can reach for on a vague clue. That would make those words
// quietly easier than the rest of the bank, for a reason that has nothing to do
// with the player's clue. Every illustration therefore uses words that are not
// targets.

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
6. Pekar ut något ANNAT av samma slag som svaret — en syskonsak, inte svaret ("kajak" för en kanot, "tisdag" för en onsdag, "aprikos" för ett plommon). En syskonsak är inte en beskrivning: den säger bara "något i den här kategorin", och resten av jobbet gör bokstavsantalet. Den här regeln prövas också mot din egen gissning — se STEG 2.

7. Namnger något som svaret bara FÖRKNIPPAS med — dess material, dess sammanhang, vad som brukar finnas i närheten, eller vad det står som symbol för — utan att säga vad svaret är, gör eller används till ("porslin" för en tekopp, "halm" för en ladugård). Association är inte beskrivning: den pekar åt rätt håll och överlåter resten av arbetet åt bokstavsantalet. Prövas mot din egen gissning — se STEG 2.

8. Är bara ett varumärke eller en tillverkare som får stå för produkten ("zippo" för en cigarettändare, "electrolux" för en dammsugare). Att veta vem som tillverkar en sak är en uppslagning, inte den sortens kunskap spelet frågar efter — och eftersom varumärken är korta och entydiga skulle "namnge marknadsledaren" annars bli den kortaste ledtråden för varje tillverkad sak.

Skillnaden mot regeln om egennamn längre ned är riktningen: Nilen ÄR en flod, men en dammsugare är ingen tillverkare — den är TILLVERKAD AV en. Ett varumärke som blivit ett vanligt ord (jeep, dynamit) är däremot ett ord, och räknas inte som varumärke här.

Se noga upp med skillnaden mot exempel-regeln nedan: ett EXEMPEL PÅ svaret är tillåtet, en SYSKONSAK till svaret är det inte. "nilen" för flod är tillåtet, för Nilen ÄR en flod. "kajak" för kanot är det inte, för en kajak är ingen kanot — den är något annat av samma sort.

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

Var generös i övrigt. Påhittade svenska sammansättningar, ovanliga bilder, humor och långsökta omskrivningar är TILLÅTNA så länge de är på svenska, hänger ihop språkligt och pekar på betydelse. En ledtråd som känns udda, lekfull eller väl fyndig bryter inte mot reglerna för det — avvisa bara det som klart bryter mot 1–8.`;

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
const PART_CHECK = `Innan du svarar: pröva regel 5, 6 och 7 mot din egen gissning. Båda handlar om att ledtråden pekar på något BREDVID svaret i stället för att beskriva svaret, och båda går först att avgöra när du vet vad du skulle gissa.

Regel 5 — är ledtrådens sak en DEL av ordet du landat i? Sitter den i eller på ordet utan att säga vad ordet ÄR, är ledtråden otillåten.

Regel 6 — är ledtrådens sak något ANNAT av samma slag som ordet du landat i? Fråga: kan man säga "det här ÄR ett/en <ordet>"? Går det, är ledtråden ett exempel och TILLÅTEN. Går det inte, fast sakerna hör till samma kategori, är den en syskonsak och OTILLÅTEN.

Regel 7 — går det att fylla i någon av de här meningarna med ledtråden?
  "Ett/en <ordet> ÄR ..."
  "Ett/en <ordet> används till ..."
  "Ett/en <ordet> gör eller orsakar ..."
  "Ett/en <ordet> liknar ..."
Går någon av dem, är ledtråden en beskrivning och TILLÅTEN. Går ingen — fast ledtråden ändå pekar åt rätt håll — är det association och OTILLÅTEN.

Att svaret är GJORT av något räknas inte som att vara det: "en tekopp är av porslin" gör inte "porslin" till en beskrivning av en tekopp. Undantaget är som förut ett känt exempel på svaret, som "nilen" för flod — det förblir tillåtet.

Bryter ledtråden mot någon av dem: svara med legal: false och säg kort vilken, i stället för att gissa.

Allt annat står kvar. Är ledtråden något ordet gör, orsakar, används till, eller påminner om, är den TILLÅTEN — ett plask är ingen del av ett skodon, det är något skodonet orsakar. Och ett exempel på kategorin är fortfarande tillåtet.`;



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
export function guesserSystemPrompt(letterCount, wordClass, banned = []) {
  return `Du är gissaren i ordspelet Ordknapp. En spelare har skrivit en ledtråd till ett hemligt svenskt ord. Du får aldrig se ordet. Gör två saker, i ordning:

${CLUE_CULTURE}

${CLUE_RULES}

STEG 2 — om ledtråden är tillåten: gissa ordet. Exakt ETT riktigt, etablerat svenskt ord i grundform (obestämd form singular för substantiv, infinitiv för verb, grundform för adjektiv) med exakt ${letterCount} bokstäver. Hitta inte på ord.
${classLine(wordClass)}

${GUESS_FORM}

${PART_CHECK}

Skriv också EN kort mening om hur du läste ledtråden och varför den ledde dig till just det ordet. Den visas för spelaren, så den ska förklara din tolkning — inte upprepa ledtråden. Max 100 tecken.

${bannedBlock(banned, letterCount)}
Svara ENDAST med JSON:
${banned.length
    ? `{"legal": true, "guesses": [{"guess": "ord1", "why": "kort mening"}, {"guess": "ord2", "why": "kort mening"}, {"guess": "ord3", "why": "kort mening"}]}`
    : `{"legal": true, "guess": "ordet", "why": "kort mening om din tolkning"}`}
eller
{"legal": false, "reason": "kort motivering på svenska"}`;
}

/**
 * The ban list, stated in the system prompt rather than only in the user turn.
 *
 * Saying it once, politely, in the message did not work: the model returned
 * "klock" four rounds running at temperatures from 0 to 1, because the same
 * rejected word was still the best answer it could see. Two things changed.
 * The ban moved to the instruction the model is most bound by, and the retry
 * asks for THREE alternatives instead of one — "give me options" turns out to
 * be a far easier instruction to follow than "give me something different",
 * and the caller can simply walk past the ones it has already ruled out.
 */
function bannedBlock(banned, letterCount) {
  if (!banned.length) return '';
  return `
FÖRBJUDNA SVAR. Dessa ord är redan prövade och avvisade:
${banned.map((w) => `  • ${w}`).join('\n')}
Ett svar ur den listan räknas som inget svar alls, hur rätt det än känns. Känns ett förbjudet ord fortfarande som det enda rimliga, så är din tolkning av ledtråden fel — läs om den och leta i en annan riktning.

Ge därför TRE olika kandidater, alla med exakt ${letterCount} bokstäver, alla i grundform, ingen ur listan ovan. Sätt den du tror mest på först. Att korta eller böja ett ord för att träffa längden är inte tillåtet — hitta ord som redan har ${letterCount} bokstäver.
`;
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

// Why a guess was sent back, in the player-invisible half of the loop. Each
// reason names the fault only — the target is never mentioned, so this stays
// as blind as the first ask.
const FAULT = {
  length: (fb, n) => `har ${fb.letters ?? 'fel antal'} bokstäver, inte ${n}`,
  not_base: () => 'är en böjd form, inte grundform',
  not_word: () => 'är inget etablerat svenskt ord',
};

/**
 * The retry instruction: everything already ruled out, in one user turn.
 * Exported for tests.
 *
 * Stated by us as fact rather than staged as a conversation. The previous
 * version replayed each rejected guess as a `model` turn followed by a
 * correction, which reads to the model as a worked example of answering that
 * way — and it duly repeated the same word for three rounds running.
 */
export function retryNote(feedback, letterCount) {
  const seen = new Map();
  for (const fb of feedback) {
    const why = (FAULT[fb.problem] ?? FAULT.not_word)(fb, letterCount);
    seen.set(fb.guess, why); // last ruling wins; the same word cannot be listed twice
  }
  const list = [...seen].map(([guess, why]) => `- "${guess}" ${why}`).join('\n');
  return `Följande ord är redan prövade och alla FEL:
${list}

Föreslå ett ord som INTE står i listan. Böj inte ett kortare ord för att komma upp i längd — hitta ett annat ord som redan i grundform har exakt ${letterCount} bokstäver (obestämd form singular för substantiv, infinitiv för verb). Svara med samma JSON-format.`;
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
