# Kodeoversikt — kompetansemål, KM-kodar og læreplanar

MVP for ei statisk nettside (GitHub Pages) som gjev redaktørar oversikt over
status på kompetansemål, kompetansemålsett, kjerneelement, læreplanar og
fagkodar frå Udir sitt Grep-register — og varslar når kodar vert utgåtte
eller erstatta.

## Slik heng det saman

```
.github/workflows/update-grep-data.yml   ← kjører vekentleg, hentar data + varslar Slack + deployar
scripts/fetch-grep-data.mjs              ← hentar frå Grep REST-API, diff mot forrige uttrekk
scripts/fetch-artikkel-merking.mjs       ← søker NDLA-artiklar merka med utgåtte kompetansemål
scripts/send-slack-varsel.mjs            ← postar Slack-melding om nye erstatningar (valfritt)
data/grep-snapshot.json                  ← siste uttrekk (kodar, status, gyldighet, erstatning)
data/changelog.json                      ← historikk over endringar (nye/utgåtte/erstatta kodar)
data/erstatninger.json                   ← varig oppslagsverk: gammal kode → (endeleg) ny kode
data/siste-kjoring-endringar.json        ← berre denne kjøringas nye hendingar (til Slack-steget)
data/artikkel-merking.json               ← NDLA-artiklar merka med utgåtte/erstatta KM/KE-kodar (ekte data)
index.html                               ← sjølve appen (oppslag, søk, endringslogg, artikkel-sjekk)
```

Grep sitt REST-API (sjå [Udir sin wiki](https://github.com/Utdanningsdirektoratet/KL06-LK20-public/wiki))
har fast URL-mønster:

- Liste: `https://data.udir.no/kl06/v201906/{type-plural}`
- Element: `https://data.udir.no/kl06/v201906/{type-plural}/{kode}`

Kvart element kan ha `status`, `gyldighet` (gyldig-fra/gyldig-til), og
`erstatter` / `erstattes-av` som peikar til andre kodar. Det er desse felta
skriptet sporar.

## Kom i gang

1. **Push til eit GitHub-repo** og slå på GitHub Pages via "GitHub Actions"
   som kjelde (Settings → Pages → Build and deployment → Source: GitHub
   Actions). Workflowen `update-grep-data.yml` byggjer og deployar sida.
2. **Køyr skriptet manuelt** for å teste lokalt:
   ```bash
   node scripts/fetch-grep-data.mjs
   ```
   Det krev Node 18+ (bruker innebygd `fetch`). Skriv over
   `data/grep-snapshot.json` og `data/changelog.json`.
3. **Juster kva fag som vert henta** ved å redigere `data/ndla-fagnavn.json`
   (kva NDLA-fag skriptet skal matche mot) og `data/ndla-laereplan-manuell.json`
   (manuelle rettingar viss matchinga bommar) — sjå eige avsnitt om
   NDLA-filteret under.

## Artikkel-sjekk

`data/artikkel-merking.json` vert generert automatisk av `scripts/fetch-artikkel-merking.mjs`,
som søker mot NDLA sitt eige [search-api](https://api.ndla.no/search-api/api-docs).

**Nøkkelfunn frå API-utforskinga (2026-08-18):**
- Parameteren heiter `grep-codes` (kebab-case) i sjølve REST-kallet — IKKJE
  `grepCodes` (camelCase), sjølv om ndla.no sin eigen søke-URL bruker
  camelCase (`ndla.no/search?grepCodes=...`). Nettsida oversett truleg dette
  til kebab-case bak kulissane før ho kallar search-api.
- Filtreringa fungerer korrekt (verifisert manuelt med fleire kodar), men
  feltet `grepCodes` i sjølve svaret er alltid tomt — det er ikkje eit
  problem, sidan vi alt veit kva kode vi søkte på.
- `context.url` i kvart treff er den rette relative artikkel-adressa, prefiks
  med `https://ndla.no` for full lenke.
- Det finst også eit `/search-api/v1/search/grep/replacements`-endepunkt,
  men det returnerte berre identitetsmapping (ingen reell erstatning) for
  fagkode-nivå-kodar i testinga vår — vi bruker difor vårt eige
  `data/erstatninger.json` i staden.

**Slik fungerer skriptet:**
1. Filtrerer `data/grep-snapshot.json` til berre kompetansemål (KM),
   kompetansemålsett (KV) OG kjerneelement (KE) med status ulik `publisert`
   (dei einaste kodane det er nyttig å varsle redaktørar om)
2. For kvar av desse, søker `grep-codes=<kode>` mot search-api
3. Slår saman treff per artikkel (ein artikkel kan vere merka med fleire
   utgåtte kodar, av fleire typar) og skriv til `data/artikkel-merking.json`

Kvar kode i `koder`-lista er eit objekt `{kode, type}`, slik at appen alltid
kan vise KM/KV/KE-merke tydeleg (2026-08-24). Eldre data som brukte flate
`kmKoder`-strengar vert framleis lese korrekt via fallback i appen.

**Verifisert (2026-08-24): KV-kodar gir 0 treff, sjølv for gyldige/publiserte
kodar.** NDLA-artiklar vert tydelegvis aldri merka med heile kompetansemålsett
(for grovkorna til innhaldstagging) — berre med individuelle KM- og
KE-kodar. Sjølve søkemekanismen fungerer, det finst berre ingen data å finne
for KV. Koden er likevel verande i skriptet i tilfelle praksisen endrar seg.

Med ca. 2400 utgåtte kompetansemål/kompetansemålsett/kjerneelement i det
NDLA-filtrerte datasettet tek dette under eitt minutt (moderat samtidigheit,
8 parallelle kall).

"Artikkel-sjekk"-fana i appen viser tre separate seksjonar (KM, KV, KE), sidan
KE-treff er mykje breiare/mindre presserande enn KM/KV-treff — sjå
forklaringstekst per seksjon i appen.

## NDLA-filter (avgrensar datasettet til berre NDLA sine fag)

Grep har over 24 000 kodar totalt (alle fag, alle trinn, alle yrkesfag i heile
landet). Skriptet avgrensar datasettet til berre dei faga NDLA faktisk
dekker, via `data/ndla-fagnavn.json` — ei liste med NDLA sine fagnamn henta
frå [ndla.no/subjects](https://ndla.no/subjects).

**Slik fungerer filteret:**
1. Grep sine fagkode- og læreplan-titlar vert normaliserte (fjernar
   parentetiske halar som `(SF vg1)`, programkode-halar som `- BA`, o.l.) og
   samanlikna mot dei normaliserte NDLA-fagnamna. Fagkodar som ser ut som
   grunnskulekodar (t.d. "Norsk, 3. årstrinn") vert ekskludert sjølv om dei
   tekstleg matchar eit fagnamn, sidan NDLA berre dekker Vg1–Vg3.
2. **Djupare matching via kompetansemålsett sitt `kortform`-felt.** Mange
   NDLA-fag (særleg yrkesfag-modular, t.d. "Energi- og styresystemer") er
   eitt kompetansemålsett inni ei DELT paraply-læreplan (t.d. "Læreplan i
   Vg1 elektro og datateknologi"), ikkje ein eigen læreplan med eige namn —
   då hjelper ikkje tittel-matching mot sjølve læreplanen. Skriptet hentar
   difor full detalj for **heile** kompetansemålsett-datasettet (kortform er
   berre tilgjengeleg i detaljoppslaget, ikkje listeoppslaget) og matchar
   kortform mot NDLA-fagnamna. Finn kortform-matchinga ein treff, vert heile
   paraply-læreplanen (og alle kompetansemålsett/-mål under han) teken med —
   dette kan i nokre tilfelle dra med seg naboemne under same paraply som
   ikkje er eit eige NDLA-fag, ein akseptert avveging for enkelheit.
3. Kompetansemålsett, kompetansemål og kjerneelement vert filtrert via feltet
   `tilhoerer_laereplan`, som alt finst i Grep sitt listeoppslag.
4. Berre det filtrerte settet vert henta i full detalj for fagkodar/
   læreplanar/kompetansemål/kjerneelement (status/gyldighet/erstatning) —
   kompetansemålsett er alt henta i steg 2.

**Kjende avgrensingar (2026-08-19):**
- Substring-matching bommar når Grep sin offisielle tittel set ord mellom
  fagnamnet og nivået (t.d. "matematikk **fellesfag** 2P", "norsk **for
  språklege minoritetar med** kort botid"). Retta manuelt etter kvart via
  `ndla-laereplan-manuell.json` når dei vert oppdaga.
- Kinesisk/Spansk og andre mindre framandspråk deler generiske
  "Læreplan i fremmedspråk"-kodar i Grep (ingen eigen kode per språk) —
  lagt til manuelt.

### Tverrfaglege tema (TT1/TT2/TT3)

"Tverrfaglige temaer" er **ikkje** eit fag/ein læreplan å matche — det er tre
faste, tverrgåande tema (TT1 Folkehelse og livsmestring, TT2 Demokrati og
medborgarskap, TT3 Bærekraftig utvikling) som Udir tagger enkeltkompetansemål
med, via feltet `tilknyttede-tverrfaglige-temaer` i detaljoppslaget. Sidan
skriptet alt hentar full detalj for kvart NDLA-relevante kompetansemål, vert
dette feltet lest ut gratis (ingen ekstra API-kall) og lagt på kvart
kompetansemål som `tverrfagligeTemaer: [{kode, tittel}]`. Vises som mårke på
kodekortet i appen, og er søkbart (t.d. søk «bærekraftig»).

**Viss matchinga bommar** (t.d. eit NDLA-fag ikkje finn sin læreplan, eller
eit irrelevant fag lek gjennom), bruk `data/ndla-laereplan-manuell.json`:

```json
{
  "leggTilLaereplaner": ["NOR01-06"],
  "fjernLaereplaner": ["SNE03-02"]
}
```

**Oppdater fagnamn-lista** ved å besøke ndla.no/subjects og oppdatere
`data/ndla-fagnavn.json` viss NDLA legg til eller fjernar fag — dette skjer
sjeldan, så det treng ikkje automatiserast.

## Oppslagsverk: gammal kode → ny kode

`data/erstatninger.json` er eit flatt, varig oppslagsverk som blir bygd på nytt
kvar veke frå både det ferske Grep-uttrekket og historikken i
`changelog.json`. Det held oppslaget i live sjølv om den gamle koden seinare
forsvinn heilt frå Grep sine lister, og følgjer heile kjeda viss ein kode er
erstatta fleire gonger etter kvarandre.

**Kompetansemål-nivå (2026-08-19):** Grep sitt REST-API manglar "erstatter"/
"erstattes-av" heilt for kompetansemål — men kvart kompetansemål har eit
`gjenbruk-av`-felt i detaljoppslaget som peikar BAKOVER til koden det vart
bygd på (t.d. KM14212 sitt `gjenbruk-av` peikar til KM12074). Ved å snu denne
relasjonen (`berikKompetansemaalMedErstatning` i `fetch-grep-data.mjs`) får
vi fram den faktiske erstatningskjeda for kompetansemål heilt gratis, sidan
vi alt hentar full detalj for kvart kompetansemål. Verifisert manuelt via
SPARQL-endepunktet <https://sparql-data.udir.no/repositories/201906> (3422
`gjenbruk-av`-koplingar totalt, 2800 reine gammal→ny-erstatningar) og
stadfesta at same data ligg i det vanlege REST-detaljoppslaget.

```json
{
  "oppslag": {
    "KM12074": { "erstattaAv": "KM12074B", "kjede": ["KM12074", "KM12074B"] }
  }
}
```

I appen ligg dette som eit eige felt øvst på "Søk & status"-fana — lim inn
ein gammal kode og få svaret direkte, utan å måtte søke rundt.

Fila er også tilgjengeleg direkte for andre system som `https://ghveem.github.io/ndla-kompetanse/data/erstatninger.json`,
viss det er nyttig andre stader enn i denne appen.

## Slack-varsel

`scripts/send-slack-varsel.mjs` postar ei melding til Slack når nye kodar
vert erstatta eller sett til utgått. For å slå det på:

1. Lag ein Slack-app på <https://api.slack.com/apps> → **"From scratch"**
2. Under **Incoming Webhooks**, slå det på og **"Add New Webhook to Workspace"**,
   vel kanalen de vil varsle i (t.d. `#ndla-kompetanse`)
3. Kopier webhook-URL-en (`https://hooks.slack.com/services/...`)
4. I GitHub-repoet: **Settings → Secrets and variables → Actions → New
   repository secret**, namn `SLACK_WEBHOOK_URL`, lim inn URL-en
5. Neste gong workflowen køyrer (eller trigg han manuelt), vil de få ei
   Slack-melding automatisk dersom det er nye erstatningar

Ingen webhook sett opp → steget hoppar stille over, resten av jobben går
som normalt.



## Vidare arbeid

- [x] Automatisk uttrekk av artikkel→KM-kode-merking frå api.ndla.no
      (`scripts/fetch-artikkel-merking.mjs`, via search-api sin `grep-codes`-
      parameter — sjå avsnittet om Artikkel-sjekk for detaljar)
- [x] Slack-varsel når nye erstatningar/utgåtte kodar dukkar opp
- [x] Varig oppslagsverk gammal→ny kode (`data/erstatninger.json`)
- [x] Historikkvisning per kode (klikk "Historikk" på eit kodekort i appen)
- [x] Direkte søkelenke til ndla.no for ein gitt KM-kode ("Søk på ndla.no ↗" —
      **verifisert 2026-08-18**: `?query=<kode>` gir reelle tref, t.d. 193
      treff for NOR01-06)
- [x] Avgrens datasettet til berre NDLA sine fag (NDLA-filter via
      `data/ndla-fagnavn.json`), i staden for heile Grep sine ~24 000 kodar
- [x] Djupare NDLA-matching via kompetansemålsett sitt `kortform`-felt (fangar
      opp yrkesfag-modular som ligg inni delte paraply-læreplanar)
- [x] Ekskluder grunnskulekodar ("N. årstrinn") frå fagkode-matchinga
- [x] Finpuss `data/ndla-laereplan-manuell.json`: lagt til fremmedspråk-kodar
      (Kinesisk/Spansk) og "Norsk kort botid" (2026-08-19)
- [x] Tverrfaglege tema (TT1/TT2/TT3) — vist seg å vere eit tag-felt på
      kompetansemål, ikkje ein eigen læreplan; lagt til som `tverrfagligeTemaer`
      og synt som mårke i appen (2026-08-19)
- [x] Erstatningssporing på kompetansemål-nivå via `gjenbruk-av`-feltet i
      detaljoppslaget (2026-08-19)
- [x] Kjerneelement (KE-kodar) lagt til som eigen type, filtrert via
      `tilhoerer_laereplan` som kompetansemål(sett). Ingen kjend
      erstatningsmekanisme funnen for kjerneelement (2026-08-19)
