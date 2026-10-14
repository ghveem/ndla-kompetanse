# CLAUDE.md for ndla-kompetanse (grep-oversikt)

Statisk nettside på GitHub Pages som viser status på kompetansemål (KM), kompetansemålsett (KV), kjerneelement (KE), læreplanar og fagkodar frå Udir sitt Grep-register, avgrensa til faga NDLA dekker. Live: https://ghveem.github.io/ndla-kompetanse/. Sjå README.md for funksjonar og API-funn.

## Køyring

- Krev Node 18+ (innebygd `fetch`), ingen `npm install`
- `node scripts/fetch-grep-data.mjs` hentar Grep-data og skriv `data/grep-snapshot.json`, `changelog.json`, `erstatninger.json` og `siste-kjoring-endringar.json`
- `node scripts/fetch-artikkel-merking.mjs` skriv `data/artikkel-merking.json`. Må køyrast etter det fyrste, sidan det les `grep-snapshot.json`
- `node scripts/send-slack-varsel.mjs` krev `SLACK_WEBHOOK_URL` (berre som GitHub-secret)
- `.github/workflows/update-grep-data.yml` køyrer måndagar kl. 04:15 UTC, ved kvar push til `main` og manuelt, committar data som «Oppdater Grep-data [automatisk]» og deployar

## Struktur

- `index.html`: heile appen (oppslag, søk, endringslogg, artikkel-sjekk, fagoversikt, om). Fanene har eigne URL-ar (`#sok`, `#fag`, `#endringar`, `#artikkel`, `#om`)
- `scripts/`: dei tre skripta over
- `data/ndla-fagnavn.json` styrer kva NDLA-fag som blir henta. `data/ndla-laereplan-manuell.json` har manuelle rettingar når matchinga bommar
- Resten av `data/` er generert. Ikkje rediger for hand, med unntak av å fjerne falske hendingar etter feila oppslag (sjå `bd33efa`)

## Fallgruver

- Search-api brukar `grep-codes` (kebab-case), ikkje `grepCodes`. Feltet `grepCodes` i svaret er alltid tomt
- KV-kodar gir 0 treff i artikkel-sjekken, fordi artiklar berre blir merka med KM og KE
- Grep-URL-ar: `https://data.udir.no/kl06/v201906/{type-plural}` og `.../{kode}`. Versjonen kan overstyrast med miljøvariabelen `GREP_VERSJON`
- Eit feila detaljoppslag for ein ny kode får den gamle koden til å miste `erstattesAv`. Difor prøver `fetchJson` på nytt ved nettverksfeil og 5xx/429, og ei erstatning som forsvinn blir berre logga som åtvaring
- Dei automatiske data-commitane gjer at historikken er full av støy. Bruk `git log --invert-grep --grep=automatisk`
- Pull før du pushar, sidan workflowen committar til `main`

## Reglar

- Bruk git med små, tydelege commits, og aldri push direkte til `main`. Bruk eiga grein og PR
- Trygg .gitignore, ingen hemmelegheiter eller tokens i repoet
- Oppdater README.md når noko endrar seg
- Bruk /ndla-brand for UI
- Skriv nynorsk, utan tankestrek, bruk «me» og «K.I.»
- Gjer berre det som er bede om, kvar endra linje skal følgje av oppgåva
