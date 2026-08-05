# Ordknapp

Ett dagligt ordspel på svenska. Spelaren ser ett hemligt ord och en lista med
spärrade ord, och skriver en ledtråd (**max 10 tecken**) som ska få en AI att
gissa ordet. Poängen är antalet tecken i den kortaste lyckade ledtråden —
golfregler, lägre är bättre — med en topplista per ord. **Mellanslag räknas
inte**, varken mot gränsen eller i poängen, så läsbar formatering är gratis och
ingen tvingas skriva ihopskrivna ledtrådar för att spara ett tecken.

**AI:n ser aldrig ordet.** Gissaren får bara ledtråden och antalet bokstäver.
Det är spelets integritetsgaranti, och UI:t säger det rakt ut: en rätt gissning
är bara imponerande om spelarna litar på att gissaren är blind.

> **Designen är ett omvänt korsord.** I ett korsord skriver konstruktören
> ledtråden och du löser den; här är rollerna ombytta — du skriver ledtråden och
> AI:n löser. Därför visas ordet som en rad korsordsrutor, och varje gissning
> landar i en egen rad under: rätt och fel blir två rader att jämföra i stället
> för löptext. Temat styr formen men berättas aldrig — ingen story i copyn, bara
> rutnätet, tidningstypografin och rak svenska. ”Ledtråd” är dessutom redan det
> svenska korsordsordet för clue, så namnet behövde inte ändras.

## Arkitektur

Kärnprincip: **prompta för omdöme, koda för begränsningar.** Varje regel som kan
kontrolleras deterministiskt kontrolleras i kod, inte av en modell.

Två AI-roller (båda bakom serverproxyn — API-nyckeln lämnar aldrig servern):

| Roll | Ser | Uppgift |
|---|---|---|
| **Gissaren** (`guardedGuesser`) | Endast ledtråden + antal bokstäver | Bedömer ledtråden mot de regler som bara handlar om ledtråden, och gissar sedan ordet — i **samma anrop**. Retry-loop (max 4 rundor): fel längd fångas i kod och åter-promptas. |
| **Verifieraren** (`verifier`) | Endast gissningen | Avgör om en *felaktig* gissning ändå är ett riktigt svenskt ord. Kan (och bör) ersättas av en ordboksuppslagning. |

### Ett anrop per gissning

Domaren är inte längre ett eget anrop. Regelboken delar sig efter vad den
behöver se:

- *Innehåller målordet / ett spärrat ord* kräver facit — och är redan en
  deterministisk delsträngskontroll i `util.js`. Ingen modell behövs.
- *Bara svenska, inga förkortningar, inga bokstaverings- eller rimtrick* är
  egenskaper hos **enbart ledtråden**.

Därför kan den andra gruppen åka med i gissarens prompt utan att målordet
någonsin hamnar i modellens kontext. Blindheten är exakt lika intakt — prompten
innehåller ledtråden och antalet bokstäver, inget annat. Det finns ett test som
misslyckas om målordet eller ett spärrat ord läcker in i anropet.

En lyckad inskickning kostar därmed **ett modellanrop**: en rätt gissning
behöver ingen verifiering, eftersom målordet per definition är ett riktigt ord.
En felaktig gissning kostar två (gissning + verifiering), en olaglig ledtråd ett.

Priset för detta: den gamla domaren såg facit och kunde peka på en *översättning*
direkt. Nu täcks det indirekt — en översättning till ett annat språk är inte ett
svenskt ord — vilket missar specialfallet där översättningen också är ett svenskt
ord ("chef" för kock). Det stängs bäst genom att lägga översättningar i ordbanken
och kontrollera dem i kod, gratis och deterministiskt.

Reglerna i prompten är medvetet generösa mot kreativitet: påhittade svenska
sammansättningar och ovanliga bilder är tillåtna. Det är bara uppenbara genvägar
(annat språk, förkortning, stavningstrick) som stoppas.

Alla AI-*kontroller* misslyckas öppet (fail open) — en flaky kontroll blockerar
aldrig spel. Om gissar-loopen tar slut visas gissningen genomstruken och
**räknas som miss** — en regelbrytande gissning presenteras aldrig som giltig.

Deterministiska kontroller i kod (`server/util.js`):
- Max 10 tecken, mellanslag oräknade (`MAX_CLUE_LENGTH` + `clueLength()` i
  `server/util.js` — enda stället; UI:t hämtar gränsen från `/api/state` och
  speglar räkningen enbart för att visa siffran).
- Emoji avvisas via Unicode property-regex före alla API-anrop.
- Målord/förbjudna ord som (normaliserad) delsträng i ledtråden.

### Rättvisa & kostnad

- **Ledtråds-cache på servern**: identiska (normaliserade) ledtrådar får
  identiska utslag — den första inskickningen låser domen för alla den dagen.
  Samma cache är kostnadskontrollen (typiskt **1** modellanrop per inskickning,
  se ovan; upprepade ledtrådar kostar noll).
- **Servern räknar all poäng själv** — klienten rapporterar bara ledtrådstexten.
- **5 försök per dag** per spelare (anonym httpOnly-cookie).
- Rate limiting per spelare på ledtråds-endpointen.
- Namn på topplistan modereras i kod (sanering + blocklista).

### Ordbank & rotation

`server/words.js`: **376 ord** med handförfattade spärrlistor (Taboo-hantverket),
64 % är 5–6 bokstäver. Ett ord per dag: rotationen är deterministisk från datumet
(Europe/Stockholm) — alla spelare får samma ord samma dag, och banken räcker
drygt ett år innan något ord återkommer.

Rotationen *stegar* genom banken (`STRIDE = 97`) i stället för att gå i ordning,
eftersom banken är författad i temablock — utan steget skulle en hel vecka bli
"natur". Steget måste vara relativt primt med bankens storlek, annars täcker
rotationen bara en del av banken; det finns ett test för det.

### Övningsläge (”Slumpa ord”)

En testknapp som slumpar fram ett annat ord, kört genom exakt samma pipeline men
**registrerat ingenstans**: inga poäng, inga förbrukade försök, ingen topplista.

Två spärrar gör att knappen inte blir ett kryphål: övningsläget vägrar spela
**dagens** ord (annars kunde man testa ledtrådar gratis och sedan skicka den
vinnande på riktigt — hela dygnsgränsen vore verkningslös), och `wordIndex`
valideras mot banken. Övningsdomar cacheas bara i minnet (bunden storlek) och
samma rate limiting gäller. Sätt `ORDKNAPP_PRACTICE=0` för att ta bort läget
helt ur en publik deploy.

Mekaniken är språkagnostisk: allt svenskt bor i prompterna
(`server/ai.js`) och ordbanken. Ett nytt språk = översätt prompterna + ny ordlista.

## Kom igång

```bash
npm install
export GEMINI_API_KEY=...
npm run build     # bygger frontend till web/dist
npm start         # http://localhost:3000
```

Utveckling: `npm run dev:server` + `npm run dev:web` (vite-proxy mot :3000).

Tester (ren logik, inga API-anrop): `npm test`

Röktest mot riktiga modellen (kostar någon tiondels öre): `npm run check:ai`.
Kör det efter byte av modell, leverantör eller prompt — enhetstesterna mockar
modellen, så inget annat bevisar att API-formen stämmer. Särskilt viktigt för
domaren: den *failar öppet*, så en trasig domare ser likadan ut som en fungerande
från UI:t. `check:ai` provar därför både en laglig och en olaglig ledtråd.

## Deploy

Spelet är en **server + frontend**, inte en statisk sajt: hela poängen är att
API-nyckeln och poängräkningen bor på servern. Två vägar:

Produktionsdomänen är **ordknapp.se**. Den är hårdkodad på ett enda ställe —
`og:url`, `og:image` och `canonical` i `web/index.html` — eftersom scrapers
kräver absoluta URL:er. Byter domänen måste de fyra raderna följa med.

### Vercel (serverless)

`api/*.js` är tunna omslag runt samma handlers som Express använder, och
`vercel.json` bygger frontend med Vite till `web/dist`. Viktigt: välj **inte**
Vite-presetet i Vercels import-dialog — det publicerar bara statiska filer och
då finns inga `/api`-rutter. Låt `vercel.json` styra (preset: *Other*).

Sätt sedan i Vercel → Settings → Environment Variables:

- `GEMINI_API_KEY` — krävs.
- KV-uppgifter, se nedan.

**Lagring är inte valfri på Vercel.** Serverless har inget skrivbart filsystem
som överlever, så utan databas hamnar topplista och försöksgräns i minnet och
nollställs vid varje kallstart (spelare får obegränsat med försök). Lägg till en
Redis-integration — Vercel Marketplace → Upstash Redis räcker — så injiceras
`KV_REST_API_URL` och `KV_REST_API_TOKEN` automatiskt och `KvStore` tar över.
`UPSTASH_REDIS_REST_URL`/`_TOKEN` fungerar likvärdigt. UI:t visar en varning så
länge lagringen är flyktig.

### Vanlig Node-host (Railway, Render, Fly, VPS)

Enklare: `npm install && npm run build && npm start`. Då kör Express med
`FileStore` (JSON-fil med atomisk skrivning) och ingen extern databas behövs.

### Miljövariabler

| Variabel | Default | Beskrivning |
|---|---|---|
| `GEMINI_API_KEY` | — | Krävs. Hålls på servern. (`GOOGLE_API_KEY` fungerar också.) |
| `ORDKNAPP_MODEL` | `gemini-3.1-flash-lite` | Modell för båda rollerna. Se Modellval nedan. |
| `PORT` | `3000` | |
| `ORDKNAPP_DATA` | `data/store.json` | Lagringsfil (atomisk skrivning; byt ut `Store` mot en riktig databas i skala). |
| `ORDKNAPP_PRACTICE` | på | Sätt till `0` för att stänga av övningsläget (”Slumpa ord”). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Redis över Upstash REST. Krävs för serverless; utan dem används minneslagring. |

## API

| Endpoint | Beskrivning |
|---|---|
| `GET /api/state` | Dagens ord, spärrade ord, försök kvar, topplista, bankens storlek. |
| `GET /api/random` | Ett slumpat övningsord (aldrig dagens). |
| `POST /api/clue {clue}` | Kör hela pipelinen. Svar: `rejected` (kostar inget) / `correct` / `wrong` / `ai_failure` (räknas som miss). |
| `POST /api/clue {clue, practice, wordIndex}` | Övningsläge: samma bedömning, men inget registreras. Vägrar dagens ord. |
| `POST /api/name {name}` | Sätter modererat topplistenamn. |

## Modellval

Båda rollerna kör samma modell: **Gemini 3.1 Flash-Lite** — vald för att den har en gratisnivå och är den billigaste dugliga modellen.

Arbetet per anrop är litet — den största prompten är ~400 tokens, och
ledtråds-cachen tar bort upprepningar — så billigaste dugliga modell vinner.
Ungefärlig kostnad efter att domaren slogs ihop med gissaren: ~1 000 in-tokens
per spelare och dag, alltså långt under **1 USD per 1 000 spelardagar**. Claude
Haiku 4.5, som projektet startade på, är ungefär 4× dyrare per token.

Gratisnivån räcker för lansering: gränsen som biter först är requests/minut, inte
requests/dag, eftersom ett dagligt spel spelas i en morgontopp. Ett anrop per
inskickning i stället för tre tredubblar hur många samtidiga spelare som ryms.

Två saker att veta:

- `gemini-2.5-flash-lite` är billigare på pappret men **avvecklas 2026-10-16** —
  inte värt att bygga på.
- Thinking-nivån sätts inte explicit i koden. 3.1 Flash-Lite defaultar till
  `minimal`, vilket är rätt för de här tre klassificeringsuppgifterna. Sätt den
  explicit först efter att fältnamnet verifierats mot en riktig nyckel: en
  avvisad config gör att *alla* anrop failar, och domaren failar öppet.

Den största besparingen är inte modellen utan att ta bort **verifieraren** och
ersätta den med en ordboksuppslagning — det tar bort upp till en tredjedel av
alla anrop och är dessutom mer träffsäkert.

## Kalibreringsrisker (kända)

- **Lånordsregeln** kan överpolisa naturaliserade lånord (paraply, jobb) —
  formuleringen "i stället för etablerad svenska" i domarprompten är avsiktligt
  skydd. Produktionsprocessen är adversariell speltestning: varje nytt exploit
  blir en promptrad plus, där det går, en kodkontroll.
- **Verifieraren** bör ersättas av ordboksuppslagning server-side (strikt bättre).
- **Svårighetsgrad** = grannskapstäthet (antal riktiga ord med samma längd nära
  konceptet). Kan mätas före lansering genom att spela gissaren mot kandidatord.
