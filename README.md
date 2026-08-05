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

`server/words.js`: handförfattade förbjudna listor (Taboo-hantverket), viktad
mot 5–6-bokstavsord. Daglig rotation är deterministisk från datumet
(Europe/Stockholm) — alla spelare får samma ord samma dag.

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

### Miljövariabler

| Variabel | Default | Beskrivning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Krävs. Hålls på servern. |
| `LEDTRADEN_MODEL` | `claude-haiku-4-5` | Modell för alla tre rollerna (spec: "a small model suffices"). |
| `PORT` | `3000` | |
| `LEDTRADEN_DATA` | `data/store.json` | Lagringsfil (atomisk skrivning; byt ut `Store` mot en riktig databas i skala). |

## API

| Endpoint | Beskrivning |
|---|---|
| `GET /api/state` | Dagens ord, förbjudna ord, försök kvar, topplista. |
| `POST /api/clue {clue}` | Kör hela pipelinen. Svar: `rejected` (kostar inget) / `correct` / `wrong` / `ai_failure` (räknas som miss). |
| `POST /api/name {name}` | Sätter modererat topplistenamn. |

## Kalibreringsrisker (kända)

- **Lånordsregeln** kan överpolisa naturaliserade lånord (paraply, jobb) —
  formuleringen "i stället för etablerad svenska" i domarprompten är avsiktligt
  skydd. Produktionsprocessen är adversariell speltestning: varje nytt exploit
  blir en promptrad plus, där det går, en kodkontroll.
- **Verifieraren** bör ersättas av ordboksuppslagning server-side (strikt bättre).
- **Svårighetsgrad** = grannskapstäthet (antal riktiga ord med samma längd nära
  konceptet). Kan mätas före lansering genom att spela gissaren mot kandidatord.
