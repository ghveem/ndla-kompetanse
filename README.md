# Kodeoversikt — kompetansemål, KM-kodar og læreplanar

MVP for ei statisk nettside (GitHub Pages) som gjev redaktørar oversikt over
status på kompetansemål, kompetansemålsett, læreplanar og fagkodar frå Udir
sitt Grep-register — og varslar når kodar vert utgåtte eller erstatta.

## Slik heng det saman

```
.github/workflows/update-grep-data.yml   ← kjører nattleg, hentar data + deployar
scripts/fetch-grep-data.mjs              ← hentar frå Grep REST-API, diff mot forrige uttrekk
data/grep-snapshot.json                  ← siste uttrekk (kodar, status, gyldighet, erstatning)
data/changelog.json                      ← historikk over endringar (nye/utgåtte/erstatta kodar)
data/artikkel-merking.json               ← kva NDLA-artiklar som er merka med kva KM-kodar
index.html                               ← sjølve appen (søk, endringslogg, artikkel-sjekk)
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

## Vidare arbeid

- [ ] Automatisk uttrekk av artikkel→KM-kode-merking frå api.ndla.no
- [ ] E-post/Slack-varsel når `changelog.json` får nye hendingar
- [ ] Historikkvisning per kode ("vis alle hendingar for KM9002-3")
- [ ] Utvide `FULL_DETAIL_TYPES` til å dekke fleire/alle typar etter kvart
      som ein har sett rate-grenser og køyretid an
- [ ] Direkte søkelenke til ndla.no for ein gitt KM-kode
