# Ordknapp

Ett dagligt ordspel på svenska. Spelaren ser ett hemligt ord och en lista med
spärrade ord, och skriver en ledtråd (**par 10 tecken**, hårt tak 18) som ska
få en AI att gissa ordet. Poängen är antalet tecken i den kortaste lyckade ledtråden —
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

En AI-roll (bakom serverproxyn — API-nyckeln lämnar aldrig servern):

| Roll | Ser | Uppgift |
|---|---|---|
| **Gissaren** (`guardedGuesser`) | Endast ledtråden + antal bokstäver | Bedömer ledtråden mot de regler som bara handlar om ledtråden, och gissar sedan ordet — i **samma anrop**. Retry-loop (max 4 rundor) när AI:n själv bryter mot reglerna: fel längd fångas i kod, påhittade ord av ordlistan. |

Verifieraren är borta: en **ordlista i kod** (`server/dictionary.js`) avgör om
en felaktig gissning ändå är ett riktigt svenskt ord. Gratis, deterministiskt
och mer träffsäkert än att fråga en modell.

### Ett anrop per gissning

Domaren är inte längre ett eget anrop. Regelboken delar sig efter vad den
behöver se:

- *Innehåller målordet / ett spärrat ord* kräver facit — och är redan en
  deterministisk delsträngskontroll i `util.js`. Ingen modell behövs.
- *Bara svenska, inga bokstaverings- eller rimtrick, ingen ifyllnadsledtråd* är
  egenskaper hos **enbart ledtråden**.

Därför kan den andra gruppen åka med i gissarens prompt utan att målordet
någonsin hamnar i modellens kontext. Blindheten är exakt lika intakt — prompten
innehåller ledtråden och antalet bokstäver, inget annat. Det finns ett test som
misslyckas om målordet eller ett spärrat ord läcker in i anropet.

**Normalfallet kostar ett modellanrop.** En rätt gissning behöver ingen
kontroll alls (målordet är per definition ett riktigt ord), en felaktig
gissning avgörs av ordlistan i kod, och en olaglig ledtråd stoppas i samma
svar.

Extra anrop uppstår bara när **AI:n** bryter mot sina egna regler — fel antal
bokstäver eller ett påhittat ord. Då promptas den om (max 4 rundor). Se
*Spelaren straffas aldrig för AI:ns fel* nedan.

Priset för detta: den gamla domaren såg facit och kunde peka på en *översättning*
direkt. Nu täcks det indirekt — en översättning till ett annat språk är inte ett
svenskt ord — vilket missar specialfallet där översättningen också är ett svenskt
ord ("chef" för kock). Det stängs bäst genom att lägga översättningar i ordbanken
och kontrollera dem i kod, gratis och deterministiskt.

Reglerna i prompten är medvetet generösa mot kreativitet: påhittade svenska
sammansättningar och ovanliga bilder är tillåtna. Det är bara uppenbara genvägar
(annat språk, stavningstrick, ifyllnadsledtråd) som stoppas.

### Kända exempel är tillåtna

”etna” löser *vulkan* på fyra tecken, och det ska det få göra. Skillnaden mot
sammansättningsledtråden är att det bygger på **betydelse**: ”skit” fungerar utan
att man vet vad en stövel är, medan ”etna” bara fungerar om man vet vad Etna är.
Det är precis den slutledningen spelet ber om, och det är klassiskt Taboo-drag.
Det är inte heller dominant — vulkaner och torn har kända exempel, men kudde och
hylla har det inte.

Fällan var att det fungerade **av misstag**: regel 1 förbjuder ”ord från andra
språk”, och Etna är ett italienskt egennamn. Modellen tillämpade inte regeln
strikt, men en omformulerad prompt eller en ny modell kunde börja avvisa
egennamn när som helst — och felet hade synts först när en spelare klagade.
Därför står tillåtelsen nu uttryckligen i prompten, och `check:ai` provar den.

### Förkortningar: regeln är borttagen

”jan” släpptes igenom men ”feb” avvisades som förkortning — samma drag, olika
dom. Orsaken är att ”jan” också är ett mansnamn, så modellen såg ett riktigt ord
i det ena fallet och en förkortning i det andra. Ingen kan veta vilket som
avsågs.

Regeln stred dessutom mot att kända exempel är tillåtna: ”feb” för **månad** är
exakt samma drag som ”etna” för **vulkan** — peka ut en instans och låt AI:n
generalisera. Att tillåta ”etna” men stoppa ”feb” är inkonsekvent.

Därför är regeln borta. En regel som inte kan tillämpas konsekvent är sämre än
ingen regel: hela cachen finns för att samma ledtråd ska få samma dom, och en
regel som slumpar bryter just det löftet. `check:ai` provar numera inte att
förkortningar stoppas, utan att ”jan” och ”feb” får **samma** svar.

### Sammansättningsledtrådar

”skit…” löser *stövel* utan att beskriva en stövel — det är en lucka att fylla i,
samma familj som rim- och stavningstrick. Skälet att stoppa det är inte att det
är fult utan att det är **dominant**: nästan varje svenskt substantiv är ett
sammansättningsled, så tillåtet blir det *enda* draget som behövs, varje dag, och
prefixen är korta nog att äga topplistan. Spelet skulle kollapsa till ”hitta
kortaste ordled som passar ihop med dagens ord”.

Gränsen: **beskriver ledtråden saken, eller pekar den bara ut ordet?**
”kaninmat” beskriver vad en morot är för en kanin — tillåtet. ”kaffe” beskriver
vad en kopp används till — tillåtet. ”skit” beskriver ingenting — otillåtet.

Varför inte en kodkontroll på *ledtråd + målord finns i ordlistan*? För att
svensk sammansättning är så produktiv att den kontrollen skulle underkänna
massor av bra ledtrådar: `vakthund`, `kaffekopp`, `solros` och `handduk` finns
alla i ordlistan, så ”kaffe” till **kopp** och ”sol” till **ros** skulle ryka.
Koden fångar därför bara den entydiga signalen (ellips, hängande bindestreck);
resten är omdöme och bor i prompten.

Alla AI-*kontroller* misslyckas öppet (fail open) — en flaky kontroll blockerar
aldrig spel.

### Spelaren straffas aldrig för AI:ns fel

Två utfall är spelarens ansvar och kostar ett försök: **rätt** och **fel
gissning**. Två är det inte, och kostar ingenting:

- **Avvisad ledtråd** — nådde aldrig gissaren.
- **AI-miss** (`ai_failure`) — modellen svarade med fel antal bokstäver eller
  ett påhittat ord, gång på gång, på en fullt laglig ledtråd.

En påhittad gissning promptas om tills modellen lyder (max 4 rundor). Först om
den aldrig lyckas blir det en `ai_failure`, som visas genomstruken med texten
*”kostade inget försök — prova igen”*. Reglerna bor i `costsAttempt()` och
`isCacheableVerdict()` i `server/game.js`, med tester.

`ai_failure` **cacheas inte**. Övriga utslag cacheas per dag så identiska
ledtrådar bedöms lika, men en AI-miss är inte ett utslag om ledtråden — cachead
skulle den frysa ledtråden som permanent misslyckad, och en ny inskickning
skulle aldrig kunna få ett nytt försök till en riktig gissning.

Deterministiska kontroller i kod (`server/util.js`):
- Högst 18 tecken, mellanslag oräknade (`MAX_CLUE_LENGTH` + `clueLength()` i
  `server/util.js` — enda stället; UI:t hämtar gränsen från `/api/state` och
  speglar räkningen enbart för att visa siffran).
- Emoji avvisas via Unicode property-regex före alla API-anrop.
- Uppenbara ifyllnadsledtrådar: ellips eller hängande bindestreck (”skit…”).
- Målord/förbjudna ord som (normaliserad) delsträng i ledtråden.

### Par och tak

Två tal, med olika jobb:

- **`PAR_CLUE_LENGTH` = 10** är målet — siffran spelet handlar om, utmärkt på
  längdmätaren under inmatningen.
- **`MAX_CLUE_LENGTH` = 18** är bara ett tak. Det finns för att begränsa kostnad
  och hindra inklistrade uppsatser, inte för att skapa svårighet.

Golfpoängen ger redan pressen att vara kort, så taket kan vara generöst utan att
göra topplistan mjuk: en lösning på 18 tecken *är* en lösning, och den hamnar
längst ner på listan där den hör hemma. Ett hårt tak på 10 gjorde i praktiken
vissa ord olösbara — vilket är en sämre upplevelse än en lång ledtråd med dåligt
resultat.

Mätaren visar tre saker: hur långt du kommit, **par**, och **dagens snitt** bland
dem som klarat ordet (`dayAverage` från `/api/state`). Du tävlar mot fältet och
målet, inte mot taket.

### Rättvisa & kostnad

- **Ledtråds-cache på servern**: identiska (normaliserade) ledtrådar får
  identiska utslag — den första inskickningen låser domen för alla den dagen.
  Samma cache är kostnadskontrollen (typiskt **1** modellanrop per inskickning,
  se ovan; upprepade ledtrådar kostar noll).
- **Servern räknar all poäng själv** — klienten rapporterar bara ledtrådstexten.
- **5 försök per dag** per spelare (anonym httpOnly-cookie).
- Rate limiting per spelare på ledtråds-endpointen.
- **Inga konton, inga namn.** Topplistan listar *ledtrådar*, inte spelare. Alla
  som skrivit samma ledtråd (normaliserat, så versaler och mellanslag inte
  splittrar raden) delar en rad med antal: *”3 spelare”*. Den enda identiteten
  som finns är en anonym httpOnly-cookie, och den används bara för att räkna
  försök, hålla ditt bästa resultat och märka din egen rad.
- **Radens poäng härleds ur ledtråden** (`clueLength`), inte ur ett separat
  lagrat tal — ordningen kommer från ledtråden, så siffran måste göra det med,
  annars kan listan se felsorterad ut fast sorteringen var rätt.
- **Ordningen** (`compareClues()` i `util.js`): färre tecken → färre mellanslag
  → ovanligare bokstäver → alfabetiskt för stabil sortering. `standing()` rankar
  på exakt samma kedja, annars skulle en spelares angivna placering motsäga
  raden hen står på — det finns ett test för just det.
- **Bokstavsrariteten** bygger på faktisk svensk bokstavsfrekvens
  (`LETTER_FREQUENCY`, procent). `letterRarity()` summerar frekvenserna och
  **lägre summa = ovanligare = bättre**. Att jämföra summor är rättvist just
  här: steget körs bara mellan ledtrådar av samma längd, så båda summorna har
  lika många termer. Obekanta tecken (é, à) får ungefär medelfrekvensen, så att
  slå i ett exotiskt tecken inte blir ett gratis sätt att vinna en utslagning.
- **Vinnarledtrådarna är facit.** Topplistan visar ledtråden som det viktiga och
  namnet som fotnot — men servern skickar dem först när spelaren är klar för
  dagen (löst ordet eller slut på försök). Annars skulle vem som helst kunna
  kopiera den bästa ledtråden. Gatingen sitter i `handlers.js` (`reveal`), inte i
  klienten.

### Ordlistan

`server/data/sv-words-<längd>.txt`: 529 454 svenska ord, genererade från
**@cspell/dict-sv** med `npm run build:dictionary`.

Listan används **endast på AI:ns gissning, aldrig på spelarens ledtråd**. Att
kräva ordboksord av spelaren skulle förbjuda just den kreativitet spelet finns
för — påhittade sammansättningar som ”kaninglass” ska vara tillåtna. Gissaren
däremot är uttryckligen instruerad att svara med ett etablerat ord, så där är
en ordbok exakt rätt regel.

Två designval värda att känna till:

- **Delad per ordlängd.** En gissning längdkontrolleras innan ordlistan
  konsulteras, och ett dygn har exakt en målordslängd — så en instans laddar en
  skärva, inte hela listan. Kallstart: ~35 ms i stället för ~950 ms, 6 MB i
  stället för 72 MB.
- **Källan är GPL-3.0-or-later.** Den mindre `dictionary-sv` (LGPL-3.0) är en
  hunspell-stamlista, och stammar ensamma tappar vanliga grundformer som råkar
  vara avledda: *lärare*, *källare*, *stege*, *kulle*, *pengar* saknades alla.
  De hade rapporterats som AI-påhitt, vilket är värre än licensskillnaden. Båda
  paketen ligger kvar i devDependencies om valet ska omprövas.

### Kurering av ordbanken

Ordvalet är det som avgör om spelet är roligt, och det är den enda delen som
inte kan lösas med en regel. Två verktyg, som mäter olika saker:

**`npm run review:words`** — statisk granskning, ingen API-nyckel, några sekunder.
För varje målord letar den upp alla ord i ordlistan som har målordet som för-
eller efterled (`rid|vante`, `morots|sås`), plockar ut det andra ledet och visar
vilka av dem spärrlistan faktiskt blockerar. Den listar de svagaste orden, de
spärrlistor som täcker minst, och de starkaste orden.

Vad den *inte* kan säga: om vägen fungerar. Gissaren är blind — får den ”rid”
och ”5 bokstäver” kan den lika gärna svara *sadel* som *vante*. Verktyget hittar
alltså **kandidater**, inte lösningar.

**`npm run probe -- <ord>`** — empirisk mätning, kräver nyckel, kostar några ören.
Den gör det som spec:en föreskrev från början: *spelar* gissaren mot ordet. En
modell får se facit och spärrlistan (precis vad en spelare ser) och skriver sina
tolv kortaste ledtrådar; var och en körs sedan genom hela den riktiga pipelinen
med den blinda gissaren. Resultatet är ordets **empiriska par** — den kortaste
ledtråd som faktiskt löste det.

Lägg nyckeln i `.env` en gång, sedan räcker ordet:

```
npm run probe -- stövel                 ett ord ur banken
npm run probe -- stövel vulkan morot    flera på en gång
npm run probe -- --bank 20              slumpat urval
npm run probe -- --dry --bank 20        vad skulle det kosta? (inga anrop)
```

Ett ord som *inte* finns i banken än kan vettas innan det läggs in — det är
poängen med att kunna skriva spärrlistan efteråt:

```
npm run probe -- --new "kikare:lins,titta,långt,glas,fjärran"
npm run probe -- --new "kikare:"        utan spärrlista, för att se vad som vinner
```

Fler flaggor: `--clues <n>` (antal kandidatledtrådar, default 12),
`--out <mapp>` (var resultaten hamnar) och `--no-save`.

**Resultaten sparas automatiskt** i `probe-results/`, en fil per ord med en post
per körning. Det är själva poängen med kurering: kör, spärra en väg, kör igen,
och se om ordet faktiskt blev svårare. Andra körningen av ett ord skriver ut
skillnaden mot den förra:

```
  JÄMFÖRT MED FÖRRA KÖRNINGEN (2026-08-05 14:34)
    kortaste      5 (oförändrat)
    lösningsgrad  50 → 33 (-17) %
    spärrlista    +plagg
```

Är spärrlistan oförändrad mellan två körningar säger utskriften det också —
skillnader i siffrorna är då modellens spridning, inte en effekt av något du
gjorde. Mappen är inte gitignorerad; checka in den om du vill ha kureringen i
historiken.

Kör alltid `--dry` först på ett större urval. Den skriver ut hur många anrop
körningen blir — ett förslagsanrop per ord plus ett bedömningsanrop per ledtråd,
med utrymme för omtag när AI:n svarar med fel längd.

Så här läser man utfallet:

| Kortaste lösning | Betyder |
|---|---|
| 2–4 tecken | **För lätt** — en billig ledtråd kommer äga topplistan |
| 5–9 tecken | **Bra** — det finns utrymme att tävla under par |
| inget löser | **För svår**, eller så är spärrlistan för hårt dragen |
| 90 %+ löser | **För lätt på annat sätt** — allt fungerar, så poängen blir bara vem som skriver kortast |

Under varje ord skriver den också ut **vägar in**: de led som återkommer i de
lösningar som faktiskt gick igenom, sorterade med den billigaste först. Löses
ordet av både *vinterplagg* och *snöplagg* är det `plagg` som är vägen, inte
ledtråden — och `plagg` är då kandidaten till spärrlistan. Led som redan är
spärrade filtreras bort, så det som listas är arbete som återstår.

Spärra en väg i taget och kör om. Spärrar man alla blir ordet olösligt, inte
svårt, och ett olösligt ord är en sämre dag än ett lätt.

**Arbetsgången för ett nytt ord**

1. Välj ett konkret substantiv, helst 5–6 bokstäver. Abstrakta ord (*lycka*,
   *frihet*) ger vaga ledtrådar och godtyckliga gissningar.
2. Skriv spärrlistan sist, inte först — kör `probe -- --new "ordet:"` **utan**
   spärrlista och se vilka ledtrådar modellen faktiskt vinner med. Listan över
   vägar in är då förslaget till spärrlista. Det är mer träffsäkert än att gissa
   vilka de uppenbara orden är.
3. Kör `review:words` och titta på de korta oblockerade sammansättningsleden.
   Spärra dem som också är uppenbara *beskrivningar*; låt de andra vara.
4. Kör `probe` igen. Sikta på kortaste lösning 5–9 och lösningsgrad 40–80 %.
5. Har ordet ett känt exempel (*vulkan* → Etna, *månad* → januari, *torn* →
   Eiffel)? Då är det billigt löst och kommer alltid att vara det. Antingen
   spärra exemplet uttryckligen, eller acceptera att ordet är ett lätt ord.

**Vad som gör ett ord bra**: många olika sätt att beskriva det (så kreativitet
lönar sig), inget enskilt kort ord som pekar rakt på det, och en konkret
betydelse som en blind modell kan träffa på rätt antal bokstäver.

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

Domaren och verifieraren är redan borttagna som separata anrop (se *Ett anrop
per gissning* och *Ordlistan*), så varje inskickning kostar ett anrop.

## Kalibreringsrisker (kända)

- **Lånordsregeln** kan överpolisa naturaliserade lånord (paraply, jobb) —
  formuleringen "i stället för etablerad svenska" i domarprompten är avsiktligt
  skydd. Produktionsprocessen är adversariell speltestning: varje nytt exploit
  blir en promptrad plus, där det går, en kodkontroll.
- **Verifieraren** bör ersättas av ordboksuppslagning server-side (strikt bättre).
- **Svårighetsgrad** = grannskapstäthet (antal riktiga ord med samma längd nära
  konceptet). Kan mätas före lansering genom att spela gissaren mot kandidatord.
