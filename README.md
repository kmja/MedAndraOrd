# Ledtråden

Ett dagligt ordspel på svenska. Spelaren ser ett hemligt ord och en lista med
spärrade ord, och telegraferar en ledtråd (**max 10 tecken**) till en mottagare
i fjärran som aldrig sett ordet. Poängen är antalet tecken i det kortaste
lyckade telegrammet — golfregler, lägre är bättre — med en topplista per ord.

**Mottagaren har aldrig sett ordet.** Gissaren får bara ledtråden och antalet
bokstäver. Det är spelets integritetsgaranti.

> Temat är ren presentation: telegramtaxan (varje tecken kostar) är samma
> mekanik som golfpoängen, och telegrafisten som vägrar sända otillåtna
> meddelanden är domaren — avvisat telegram = aldrig sänt = ingen taxa = inget
> förbrukat försök. UI:t säger ärligt i finstilten att mottagaren spelas av en
> AI — en rätt gissning är bara imponerande om spelarna litar på att gissaren
> är blind.

## Arkitektur

Kärnprincip: **prompta för omdöme, koda för begränsningar.** Varje regel som kan
kontrolleras deterministiskt kontrolleras i kod, inte av en modell.

Tre AI-roller (alla bakom serverproxyn — API-nyckeln lämnar aldrig servern):

| Roll | Ser | Uppgift |
|---|---|---|
| **Domaren** (`referee`) | Allt: målord, förbjudna ord, ledtråd | Avvisar otillåtna ledtrådar med motivering. Kostar inget försök. |
| **Gissaren** (`guesser`) | Endast ledtråden + antal bokstäver | Gissar ordet. Körs i en retry-loop (max 4 rundor): fel längd fångas i kod och åter-promptas; rätt längd verifieras. |
| **Verifieraren** (`verifier`) | Endast gissningen | Avgör om gissningen är ett riktigt svenskt ord. Kan (och bör i produktion) ersättas av en ordboksuppslagning på servern. |

Alla AI-*kontroller* misslyckas öppet (fail open) — en flaky kontroll blockerar
aldrig spel. Om gissar-loopen tar slut visas gissningen genomstruken och
**räknas som miss** — en regelbrytande gissning presenteras aldrig som giltig.

Deterministiska kontroller i kod (`server/util.js`):
- Max 10 tecken (`MAX_CLUE_LENGTH` i `server/util.js` — enda stället; UI:t hämtar
  gränsen från `/api/state`).
- Emoji avvisas via Unicode property-regex före alla API-anrop.
- Målord/förbjudna ord som (normaliserad) delsträng i ledtråden.

### Rättvisa & kostnad

- **Ledtråds-cache på servern**: identiska (normaliserade) ledtrådar får
  identiska utslag — den första inskickningen låser domen för alla den dagen.
  Samma cache är kostnadskontrollen (värsta fall 4 modellanrop per inskickning,
  typiskt 2).
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
**registrerat ingenstans**: ingen taxa, inga förbrukade försök, ingen topplista.

Två spärrar gör att knappen inte blir ett kryphål: övningsläget vägrar spela
**dagens** ord (annars kunde man testa ledtrådar gratis och sedan skicka den
vinnande på riktigt — hela dygnsgränsen vore verkningslös), och `wordIndex`
valideras mot banken. Övningsdomar cacheas bara i minnet (bunden storlek) och
samma rate limiting gäller. Sätt `LEDTRADEN_PRACTICE=0` för att ta bort läget
helt ur en publik deploy.

Mekaniken är språkagnostisk: allt svenskt bor i de tre prompterna
(`server/ai.js`) och ordbanken. Ett nytt språk = översätt prompterna + ny ordlista.

## Kom igång

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
npm run build     # bygger frontend till web/dist
npm start         # http://localhost:3000
```

Utveckling: `npm run dev:server` + `npm run dev:web` (vite-proxy mot :3000).

Tester (ren logik, inga API-anrop): `npm test`

## Deploy

Spelet är en **server + frontend**, inte en statisk sajt: hela poängen är att
API-nyckeln och poängräkningen bor på servern. Två vägar:

### Vercel (serverless)

`api/*.js` är tunna omslag runt samma handlers som Express använder, och
`vercel.json` bygger frontend med Vite till `web/dist`. Viktigt: välj **inte**
Vite-presetet i Vercels import-dialog — det publicerar bara statiska filer och
då finns inga `/api`-rutter. Låt `vercel.json` styra (preset: *Other*).

Sätt sedan i Vercel → Settings → Environment Variables:

- `ANTHROPIC_API_KEY` — krävs.
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
| `ANTHROPIC_API_KEY` | — | Krävs. Hålls på servern. |
| `LEDTRADEN_MODEL` | `claude-haiku-4-5` | Modell för alla tre rollerna (spec: "a small model suffices"). |
| `PORT` | `3000` | |
| `LEDTRADEN_DATA` | `data/store.json` | Lagringsfil (atomisk skrivning; byt ut `Store` mot en riktig databas i skala). |
| `LEDTRADEN_PRACTICE` | på | Sätt till `0` för att stänga av övningsläget (”Slumpa ord”). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | — | Redis över Upstash REST. Krävs för serverless; utan dem används minneslagring. |

## API

| Endpoint | Beskrivning |
|---|---|
| `GET /api/state` | Dagens ord, spärrade ord, försök kvar, topplista, bankens storlek. |
| `GET /api/random` | Ett slumpat övningsord (aldrig dagens). |
| `POST /api/clue {clue}` | Kör hela pipelinen. Svar: `rejected` (kostar inget) / `correct` / `wrong` / `ai_failure` (räknas som miss). |
| `POST /api/clue {clue, practice, wordIndex}` | Övningsläge: samma bedömning, men inget registreras. Vägrar dagens ord. |
| `POST /api/name {name}` | Sätter modererat topplistenamn. |

## Kalibreringsrisker (kända)

- **Lånordsregeln** kan överpolisa naturaliserade lånord (paraply, jobb) —
  formuleringen "i stället för etablerad svenska" i domarprompten är avsiktligt
  skydd. Produktionsprocessen är adversariell speltestning: varje nytt exploit
  blir en promptrad plus, där det går, en kodkontroll.
- **Verifieraren** bör ersättas av ordboksuppslagning server-side (strikt bättre).
- **Svårighetsgrad** = grannskapstäthet (antal riktiga ord med samma längd nära
  konceptet). Kan mätas före lansering genom att spela gissaren mot kandidatord.
