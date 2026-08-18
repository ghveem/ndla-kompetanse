#!/usr/bin/env node
/**
 * fetch-grep-data.mjs
 *
 * Hentar data frå Utdanningsdirektoratet sitt Grep REST-API, AVGRENSAR det
 * til berre dei faga NDLA faktisk dekker (sjå data/ndla-fagnavn.json),
 * normaliserer resten til eit enkelt format, og samanliknar med førre
 * snapshot for å byggje ein endringslogg.
 *
 * Grep REST-API (sjå https://github.com/Utdanningsdirektoratet/KL06-LK20-public/wiki):
 *   Liste:    https://data.udir.no/kl06/v{versjon}/{type-plural}
 *   Element:  https://data.udir.no/kl06/v{versjon}/{type-plural}/{kode}
 *
 * NDLA-filteret fungerer i tre steg:
 *  1. Match Grep sine fagkode- og læreplan-titlar mot data/ndla-fagnavn.json
 *     (enkel, robust tekst-matching — sjå normaliserFagnavn/normaliserLaereplanTittel)
 *  2. Bruk data/ndla-laereplan-manuell.json til å rette opp kodar matchinga
 *     bomma på (legg til eller fjern manuelt)
 *  3. Kompetansemålsett og kompetansemål vert filtrert via feltet
 *     "tilhoerer_laereplan" som ALT finst i listeoppslaget (ingen ekstra
 *     API-kall nødvendig for sjølve filtreringa)
 *
 * Berre dei filtrerte kodane vert henta i full detalj (for status/gyldighet/
 * erstatning) — dette gjer skriptet mykje raskare og gir eit mykje mindre
 * (og meir relevant) datasett enn å hente heile Grep.
 *
 * Køyr lokalt:
 *   node scripts/fetch-grep-data.mjs
 *
 * I produksjon vert dette køyrt av GitHub Actions, sjå
 * .github/workflows/update-grep-data.yml
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const GREP_VERSJON = process.env.GREP_VERSJON || "v201906";
const BASE_URL = `https://data.udir.no/kl06/${GREP_VERSJON}`;

const CONCURRENCY = Number(process.env.GREP_CONCURRENCY || 6);
const SNAPSHOT_PATH = new URL("../data/grep-snapshot.json", import.meta.url);
const CHANGELOG_PATH = new URL("../data/changelog.json", import.meta.url);
const ERSTATNINGER_PATH = new URL("../data/erstatninger.json", import.meta.url);
const SISTE_KJORING_PATH = new URL("../data/siste-kjoring-endringar.json", import.meta.url);
const NDLA_FAGNAVN_PATH = new URL("../data/ndla-fagnavn.json", import.meta.url);
const MANUELL_PATH = new URL("../data/ndla-laereplan-manuell.json", import.meta.url);
const MAX_CHANGELOG_ENTRIES = 500;

// ---------------------------------------------------------------------------
// Grunnleggande hjelpefunksjonar
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

async function hentRåListe(endpoint) {
  const url = `${BASE_URL}/${endpoint}`;
  console.log(`Hentar liste: ${url}`);
  return fetchJson(url);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function extractCodes(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((el) => el.kode).filter(Boolean);
}

/**
 * Grep returnerer "tittel" som anten ein enkel tekststreng (i listeoppslag),
 * eller som eit array med språkvariantar i detaljoppslag, t.d.:
 *   [{ "spraak": "nob", "verdi": "..." }, { "spraak": "nno", "verdi": "..." }, ...]
 * Denne hentar ut norsk bokmål, med fornuftige fallbackar.
 */
function extractTittel(source) {
  const rå = source?.tittel;
  if (typeof rå === "string") return rå;
  // To ulike former finst i Grep: eit flatt array (listeoppslag), eller eit
  // objekt { tekst: [...], forskrift: bool } (detaljoppslag via url-data).
  let arr = null;
  if (Array.isArray(rå)) arr = rå;
  else if (rå && Array.isArray(rå.tekst)) arr = rå.tekst;
  if (arr) {
    const prioritet = ["nob", "default", "nno", "eng"];
    for (const spraak of prioritet) {
      const treff = arr.find((v) => v.spraak === spraak);
      if (treff?.verdi) return treff.verdi;
    }
    return arr[0]?.verdi ?? null;
  }
  return null;
}

/** Hentar gyldig-fra/gyldig-til frå anten "gyldighet"-objekt eller flate felt, med fallback mellom detalj og listeelement. */
function extractGyldigDato(nokkel, ...kjelder) {
  for (const kjelde of kjelder) {
    if (!kjelde) continue;
    if (kjelde.gyldighet && kjelde.gyldighet[nokkel] !== undefined) return kjelde.gyldighet[nokkel];
    if (kjelde[nokkel] !== undefined) return kjelde[nokkel];
  }
  return null;
}

function normalizeElement(type, listItem, detail) {
  const source = detail || listItem;
  // Detaljoppslaget manglar heilt "gyldighet" for kompetansemål, og
  // tittel-strukturen skil seg frå listeoppslaget for kompetansemål(sett) —
  // difor sjekkar vi begge kjeldene, med detalj først.
  return {
    type,
    kode: source.kode,
    tittel: extractTittel(detail) ?? extractTittel(listItem),
    status: source.status ? source.status.split("/").pop().replace("status_", "") : null,
    gyldigFra: extractGyldigDato("gyldig-fra", detail, listItem),
    gyldigTil: extractGyldigDato("gyldig-til", detail, listItem),
    erstatter: extractCodes(source["erstatter"]),
    erstattesAv: extractCodes(source["erstattes-av"]),
  };
}

/** Henta detaljar (status/gyldighet/erstatning) for ei liste med Grep-listeelement. */
async function hentDetaljar(type, elementer) {
  return mapWithConcurrency(elementer, CONCURRENCY, async (item) => {
    try {
      const detail = await fetchJson(item["url-data"]);
      return normalizeElement(type, item, detail);
    } catch (err) {
      console.warn(`  Klarte ikkje hente detalj for ${item.kode}: ${err.message}`);
      return normalizeElement(type, item, null);
    }
  });
}

// ---------------------------------------------------------------------------
// NDLA-filter: matching av fagnavn mot Grep sine fagkode-/læreplan-titlar
// ---------------------------------------------------------------------------

function normaliserFagnavn(raw) {
  let s = raw.toLowerCase().trim();
  s = s.replace(/\s*\([^)]*\)\s*$/g, ""); // fjern parentetisk hale, t.d. "(SF vg1)"
  s = s.replace(/\s*-\s*(ressurssamling|beta)\s*$/i, ""); // fjern "- Ressurssamling" / "- BETA"
  s = s.replace(/\s-\s[a-zæøå]{2,5}$/i, ""); // fjern programkode-hale, t.d. " - BA"
  return s.trim();
}

function normaliserLaereplanTittel(raw) {
  let s = raw.toLowerCase().trim();
  s = s.replace(/^læreplan\s+(i|for)\s+/i, "");
  s = s.replace(/^felles\s+programfag\s+i\s+/i, "");
  return s.trim();
}

function erSammeFag(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a));
}

async function lastNdlaFagnavn() {
  const data = JSON.parse(await readFile(NDLA_FAGNAVN_PATH, "utf-8"));
  return (data.fagnavn || []).map(normaliserFagnavn).filter(Boolean);
}

async function lastManuelleOverstyringar() {
  if (!existsSync(MANUELL_PATH)) return { leggTilLaereplaner: [], fjernLaereplaner: [] };
  try {
    const data = JSON.parse(await readFile(MANUELL_PATH, "utf-8"));
    return {
      leggTilLaereplaner: data.leggTilLaereplaner || [],
      fjernLaereplaner: data.fjernLaereplaner || [],
    };
  } catch {
    return { leggTilLaereplaner: [], fjernLaereplaner: [] };
  }
}

// ---------------------------------------------------------------------------
// Snapshot/endringslogg-historikk
// ---------------------------------------------------------------------------

async function lastGammaltSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(await readFile(SNAPSHOT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

async function lastGammalEndringslogg() {
  if (!existsSync(CHANGELOG_PATH)) return { endringar: [] };
  try {
    return JSON.parse(await readFile(CHANGELOG_PATH, "utf-8"));
  } catch {
    return { endringar: [] };
  }
}

/** Samanliknar to snapshot og returnerer ei liste med endringshendingar. */
function diffSnapshots(gammalt, nytt, tidspunkt) {
  const gammalMap = new Map((gammalt?.elementer || []).map((e) => [e.kode, e]));
  const nyMap = new Map(nytt.elementer.map((e) => [e.kode, e]));
  const hendingar = [];

  for (const [kode, ny] of nyMap) {
    const gammal = gammalMap.get(kode);
    if (!gammal) {
      hendingar.push({
        dato: tidspunkt,
        kode,
        tittel: ny.tittel,
        type: ny.type,
        hendelse: "ny",
        detalj: "Ny kode oppdaga i Grep",
        nyKode: null,
      });
      continue;
    }
    if (gammal.status !== ny.status) {
      const erErstatta = ny.erstattesAv.length > 0;
      hendingar.push({
        dato: tidspunkt,
        kode,
        tittel: ny.tittel,
        type: ny.type,
        hendelse: erErstatta ? "erstattet" : (ny.status || "status_endra"),
        detalj: erErstatta
          ? `Erstatta av ${ny.erstattesAv.join(", ")}`
          : `Status endra frå "${gammal.status}" til "${ny.status}"`,
        nyKode: erErstatta ? ny.erstattesAv[0] : null,
      });
    } else if (JSON.stringify(gammal.erstattesAv) !== JSON.stringify(ny.erstattesAv)) {
      hendingar.push({
        dato: tidspunkt,
        kode,
        tittel: ny.tittel,
        type: ny.type,
        hendelse: "erstattet",
        detalj: `Erstatta av ${ny.erstattesAv.join(", ")}`,
        nyKode: ny.erstattesAv[0] || null,
      });
    }
  }

  for (const [kode, gammal] of gammalMap) {
    if (!nyMap.has(kode)) {
      hendingar.push({
        dato: tidspunkt,
        kode,
        tittel: gammal.tittel,
        type: gammal.type,
        hendelse: "fjerna",
        detalj: "Koden finst ikkje lenger i det filtrerte NDLA-uttrekket",
        nyKode: null,
      });
    }
  }

  return hendingar;
}

/**
 * Byggjer eit varig oppslagsverk: gammal kode -> (endeleg) ny kode, med heile
 * kjeda viss ein kode er erstatta fleire gonger etter kvarandre.
 */
function byggErstatningsOppslag(snapshot, endringslogg) {
  const direkte = new Map();

  for (const h of [...(endringslogg.endringar || [])].reverse()) {
    if (h.hendelse === "erstattet" && h.nyKode) {
      direkte.set(h.kode, h.nyKode);
    }
  }
  for (const e of snapshot.elementer) {
    if ((e.erstattesAv || []).length > 0) {
      direkte.set(e.kode, e.erstattesAv[0]);
    }
  }

  const oppslag = {};
  for (const gammalKode of direkte.keys()) {
    const kjede = [gammalKode];
    const besokt = new Set([gammalKode]);
    let noverande = gammalKode;
    while (direkte.has(noverande)) {
      const neste = direkte.get(noverande);
      if (besokt.has(neste)) break;
      kjede.push(neste);
      besokt.add(neste);
      noverande = neste;
    }
    oppslag[gammalKode] = { erstattaAv: kjede[kjede.length - 1], kjede };
  }
  return oppslag;
}

// ---------------------------------------------------------------------------
// Hovudflyt
// ---------------------------------------------------------------------------

async function main() {
  const tidspunkt = new Date().toISOString();
  const gammaltSnapshot = await lastGammaltSnapshot();

  const ndlaFagnavn = await lastNdlaFagnavn();
  const manuell = await lastManuelleOverstyringar();

  // Steg 1: hent rå-lister (utan full detalj) for fagkodar og læreplanar
  const [fagkoderRaa, laereplanerRaa, laereplanerLk20Raa] = await Promise.all([
    hentRåListe("fagkoder"),
    hentRåListe("laereplaner"),
    hentRåListe("laereplaner-lk20"),
  ]);

  // Steg 2: match mot NDLA sine fagnavn
  const fagkoderMatcha = fagkoderRaa.filter((f) => {
    const tittel = extractTittel(f);
    return tittel && ndlaFagnavn.some((n) => erSammeFag(normaliserFagnavn(tittel), n));
  });

  const laereplanKodeSetLk06 = new Set(laereplanerRaa.map((l) => l.kode));
  const alleLaereplanar = [...laereplanerRaa, ...laereplanerLk20Raa];
  const laereplanerMatcha = alleLaereplanar.filter((l) => {
    const tittel = extractTittel(l);
    return tittel && ndlaFagnavn.some((n) => erSammeFag(normaliserLaereplanTittel(tittel), n));
  });

  const allowedLaereplanKoder = new Set([
    ...laereplanerMatcha.map((l) => l.kode),
    ...manuell.leggTilLaereplaner,
  ]);
  for (const kode of manuell.fjernLaereplaner) allowedLaereplanKoder.delete(kode);

  const laereplanerFiltrert = alleLaereplanar.filter((l) => allowedLaereplanKoder.has(l.kode));

  console.log(
    `NDLA-filter: ${fagkoderMatcha.length} fagkodar, ${laereplanerFiltrert.length} læreplanar matcha mot ${ndlaFagnavn.length} fagnavn.`
  );

  // Steg 3: hent full detalj (status/gyldighet/erstatning) for det filtrerte settet
  const fagkodeElementer = await hentDetaljar("fagkode", fagkoderMatcha);
  // Læreplanar treng ulik "type" avhengig av om dei er LK06 eller LK20
  const laereplanElementerLk06 = await hentDetaljar(
    "laereplan",
    laereplanerFiltrert.filter((l) => laereplanKodeSetLk06.has(l.kode))
  );
  const laereplanElementerLk20 = await hentDetaljar(
    "laereplan_lk20",
    laereplanerFiltrert.filter((l) => !laereplanKodeSetLk06.has(l.kode))
  );

  // Steg 4: kompetansemålsett og kompetansemål — filtrer på tilhoerer_laereplan
  // (feltet finst alt i listeoppslaget, ingen ekstra kall nødvendig for filtreringa)
  const kompetansemaalsettRaa = await hentRåListe("kompetansemaalsett-lk20");
  const kompetansemaalsettMatcha = kompetansemaalsettRaa.filter(
    (k) => k.tilhoerer_laereplan && allowedLaereplanKoder.has(k.tilhoerer_laereplan.kode)
  );
  const kompetansemaalsettElementer = await hentDetaljar(
    "kompetansemaalsett_lk20",
    kompetansemaalsettMatcha
  );

  const kompetansemaalRaa = await hentRåListe("kompetansemaal-lk20");
  const kompetansemaalMatcha = kompetansemaalRaa.filter(
    (k) => k.tilhoerer_laereplan && allowedLaereplanKoder.has(k.tilhoerer_laereplan.kode)
  );
  const kompetansemaalElementer = await hentDetaljar("kompetansemaal_lk20", kompetansemaalMatcha);

  console.log(
    `NDLA-filter: ${kompetansemaalsettElementer.length} kompetansemålsett, ${kompetansemaalElementer.length} kompetansemål matcha.`
  );

  const elementer = [
    ...fagkodeElementer,
    ...laereplanElementerLk06,
    ...laereplanElementerLk20,
    ...kompetansemaalsettElementer,
    ...kompetansemaalElementer,
  ].filter((e) => e && e.kode);

  const nyttSnapshot = {
    generert: tidspunkt,
    grepVersjon: GREP_VERSJON,
    kilde: `${BASE_URL}/`,
    ndlaFilter: {
      fagnavnKjelde: "data/ndla-fagnavn.json",
      antalFagnavn: ndlaFagnavn.length,
    },
    elementer,
  };

  const nyeHendingar = diffSnapshots(gammaltSnapshot, nyttSnapshot, tidspunkt);
  const gammalEndringslogg = await lastGammalEndringslogg();
  const endringslogg = {
    generert: tidspunkt,
    forrigeKjoring: gammaltSnapshot?.generert || null,
    endringar: [...nyeHendingar, ...(gammalEndringslogg.endringar || [])].slice(0, MAX_CHANGELOG_ENTRIES),
  };

  await writeFile(SNAPSHOT_PATH, JSON.stringify(nyttSnapshot, null, 2) + "\n", "utf-8");
  await writeFile(CHANGELOG_PATH, JSON.stringify(endringslogg, null, 2) + "\n", "utf-8");

  const oppslag = byggErstatningsOppslag(nyttSnapshot, endringslogg);
  await writeFile(
    ERSTATNINGER_PATH,
    JSON.stringify({ generert: tidspunkt, oppslag }, null, 2) + "\n",
    "utf-8"
  );

  await writeFile(
    SISTE_KJORING_PATH,
    JSON.stringify({ generert: tidspunkt, endringar: nyeHendingar }, null, 2) + "\n",
    "utf-8"
  );

  console.log(`\nFerdig. ${elementer.length} element henta (NDLA-filtrert).`);
  console.log(`${nyeHendingar.length} nye endringar registrert.`);
  console.log(`${Object.keys(oppslag).length} kodar i erstatnings-oppslaget.`);
  if (nyeHendingar.length > 0 && nyeHendingar.length <= 50) {
    for (const h of nyeHendingar) {
      console.log(`  [${h.hendelse}] ${h.kode} – ${h.detalj}`);
    }
  } else if (nyeHendingar.length > 50) {
    console.log(`  (for mange til å liste ut enkeltvis — sjå data/changelog.json)`);
  }
}

main().catch((err) => {
  console.error("Feil under henting av Grep-data:", err);
  process.exit(1);
});
