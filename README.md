# Kodeoversikt — kompetansemål, KM-kodar og læreplanar

MVP for ei statisk nettside (GitHub Pages) som gjev redaktørar oversikt over
status på kompetansemål, kompetansemålsett, læreplanar og fagkodar frå Udir
sitt Grep-register — og varslar når kodar vert utgåtte eller erstatta.

## Slik heng det saman

```
.github/workflows/update-grep-data.yml   ← kjører nattleg, hentar data + varslar Slack + deployar
scripts/fetch-grep-data.mjs              ← hentar frå Grep REST-API, diff mot forrige uttrekk
scripts/send-slack-varsel.mjs            ← postar Slack-melding om nye erstatningar (valfritt)
data/grep-snapshot.json                  ← siste uttrekk (kodar, status, gyldighet, erstatning)
data/changelog.json                      ← historikk over endringar (nye/utgåtte/erstatta kodar)
data/erstatninger.json                   ← varig oppslagsverk: gammal kode → (endeleg) ny kode
data/siste-kjoring-endringar.json        ← berre denne kjøringas nye hendingar (til Slack-steget)
data/artikkel-merking.json               ← kva NDLA-artiklar som er merka med kva KM-kodar
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
3. **Juster kva typar som vert henta** i toppen av
   `scripts/fetch-grep-data.mjs` (`TYPES`) og kor mange som får full
   detalj-henting (`FULL_DETAIL_TYPES` / miljøvariabelen
   `GREP_FULL_DETAIL_TYPES`). Kompetansemål er svært mange — start smalt
   (t.d. berre for dei faga de faktisk dekker) og utvid etter kvart.

## Artikkel-sjekk (fase 2 i praksis)

`data/artikkel-merking.json` er i MVP-en fylt med døme-data. I ei ordentleg
løysing bør denne genererast automatisk, t.d. via eit eige steg som spør
`api.ndla.no` etter artiklar og deira `grepCodes`/kompetansemål-metadata, og
skriv dei ut i same format:

```json
{
  "merking": [
    { "artikkelId": "8214", "tittel": "…", "url": "https://ndla.no/article/8214", "kmKoder": ["KM9002-3"] }
  ]
}
```

Så snart den fila vert oppdatert automatisk (eige steg i same eller eige
workflow), vil "Artikkel-sjekk"-fana i appen automatisk flagge artiklar som
er merka med utgåtte/erstatta kodar — utan andre endringar i appen.

## Oppslagsverk: gammal kode → ny kode

`data/erstatninger.json` er eit flatt, varig oppslagsverk som blir bygd på nytt
kvar natt frå både det ferske Grep-uttrekket og historikken i
`changelog.json`. Det held oppslaget i live sjølv om den gamle koden seinare
forsvinn heilt frå Grep sine lister, og følgjer heile kjeda viss ein kode er
erstatta fleire gonger etter kvarandre:

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

- [ ] Automatisk uttrekk av artikkel→KM-kode-merking frå api.ndla.no
- [x] Slack-varsel når nye erstatningar/utgåtte kodar dukkar opp
- [x] Varig oppslagsverk gammal→ny kode (`data/erstatninger.json`)
- [x] Historikkvisning per kode (klikk "Historikk" på eit kodekort i appen)
- [x] Direkte søkelenke til ndla.no for ein gitt KM-kode ("Søk på ndla.no ↗" —
      **verifiser at `NDLA_SEARCH_URL` i `index.html` faktisk er rett
      spørjeparameter før de stolar fullt på han**, sjå merknad i koden)
- [ ] Utvide `FULL_DETAIL_TYPES` til å dekke fleire/alle typar etter kvart
      som ein har sett rate-grenser og køyretid an
