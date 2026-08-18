#!/usr/bin/env node
/**
 * fetch-grep-data.mjs
 *
 * Hentar data frå Utdanningsdirektoratet sitt Grep REST-API, normaliserer det
 * til eit enkelt format appen kan bruke, og samanliknar med førre snapshot
 * for å byggje ein endringslogg (nye kodar, utgåtte kodar, erstatningar).
 *
 * Grep REST-API (sjå https://github.com/Utdanningsdirektoratet/KL06-LK20-public/wiki):
 *   Liste:    https://data.udir.no/kl06/v{versjon}/{type-plural}
 *   Element:  https://data.udir.no/kl06/v{versjon}/{type-plural}/{kode}
 *
 * Listene er IKKJE uttømmande – dei inneheld berre referansar ("url-data")
 * til det fulle elementet. Denne skripten hentar difor lista, og deretter
 * (for typane i FULL_DETAIL_TYPES) kvart enkelt element via url-data for å
 * få med "status", "gyldighet" og "erstattes-av"/"erstatter".
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

// Kva Grep-typar vi hentar, og kva vårt interne "type"-namn vert.
// Sjå "Liste over alle typene i Grep" i Udir-wikien viss du treng å
// leggje til fleire typar (t.d. tverrfaglige-temaer, grunnleggende-ferdigheter).
const TYPES = [
  { endpoint: "fagkoder", type: "fagkode" },
  { endpoint: "laereplaner", type: "laereplan" },
  { endpoint: "laereplaner-lk20", type: "laereplan_lk20" },
  { endpoint: "kompetansemaalsett-lk20", type: "kompetansemaalsett_lk20" },
  { endpoint: "kompetansemaal-lk20", type: "kompetansemaal_lk20" },
];

// Full detalj-henting (status/gyldighet/erstatning) er tyngre – kompetansemål
// er svært mange, så avgrens gjerne dette settet i starten og utvid seinare.
const FULL_DETAIL_TYPES = new Set(
  (process.env.GREP_FULL_DETAIL_TYPES || "fagkode,laereplan,laereplan_lk20,kompetansemaalsett_lk20")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const CONCURRENCY = Number(process.env.GREP_CONCURRENCY || 5);
const SNAPSHOT_PATH = new URL("../data/grep-snapshot.json", import.meta.url);
const CHANGELOG_PATH = new URL("../data/changelog.json", import.meta.url);
const MAX_CHANGELOG_ENTRIES = 500;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
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

function normalizeElement(type, listItem, detail) {
  const source = detail || listItem;
  return {
    type,
    kode: source.kode,
    tittel: source.tittel || source["tittel"] || null,
    status: source.status ? source.status.split("/").pop().replace("status_", "") : null,
    gyldigFra: source.gyldighet?.["gyldig-fra"] ?? null,
    gyldigTil: source.gyldighet?.["gyldig-til"] ?? null,
    erstatter: extractCodes(source["erstatter"]),
    erstattesAv: extractCodes(source["erstattes-av"]),
  };
}

async function hentType({ endpoint, type }) {
  const listUrl = `${BASE_URL}/${endpoint}`;
  console.log(`Hentar liste: ${listUrl}`);
  const liste = await fetchJson(listUrl);

  if (!FULL_DETAIL_TYPES.has(type)) {
    return liste.map((item) => normalizeElement(type, item, null));
  }

  return mapWithConcurrency(liste, CONCURRENCY, async (item) => {
    const detailUrl = item["url-data"] || `${BASE_URL}/${endpoint}/${item.kode}`;
    try {
      const detail = await fetchJson(detailUrl);
      return normalizeElement(type, item, detail);
    } catch (err) {
      console.warn(`  Klarte ikkje hente detalj for ${item.kode}: ${err.message}`);
      return normalizeElement(type, item, null);
    }
  });
}

async function lastGammaltSnapshot() {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function lastGammalEndringslogg() {
  if (!existsSync(CHANGELOG_PATH)) return { endringar: [] };
  try {
    const raw = await readFile(CHANGELOG_PATH, "utf-8");
    return JSON.parse(raw);
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
    } else if (
      JSON.stringify(gammal.erstattesAv) !== JSON.stringify(ny.erstattesAv)
    ) {
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
        detalj: "Koden finst ikkje lenger i Grep-lista",
        nyKode: null,
      });
    }
  }

  return hendingar;
}

async function main() {
  const tidspunkt = new Date().toISOString();
  const gammaltSnapshot = await lastGammaltSnapshot();

  const alleLister = await Promise.all(TYPES.map(hentType));
  const elementer = alleLister.flat();

  const nyttSnapshot = {
    generert: tidspunkt,
    grepVersjon: GREP_VERSJON,
    kilde: `${BASE_URL}/`,
    elementer,
  };

  const nyeHendingar = diffSnapshots(gammaltSnapshot, nyttSnapshot, tidspunkt);
  const gammalEndringslogg = await lastGammalEndringslogg();
  const endringslogg = {
    generert: tidspunkt,
    forrigeKjoring: gammaltSnapshot?.generert || null,
    endringar: [...nyeHendingar, ...(gammalEndringslogg.endringar || [])].slice(
      0,
      MAX_CHANGELOG_ENTRIES
    ),
  };

  await writeFile(SNAPSHOT_PATH, JSON.stringify(nyttSnapshot, null, 2) + "\n", "utf-8");
  await writeFile(CHANGELOG_PATH, JSON.stringify(endringslogg, null, 2) + "\n", "utf-8");

  console.log(`\nFerdig. ${elementer.length} element henta.`);
  console.log(`${nyeHendingar.length} nye endringar registrert.`);
  if (nyeHendingar.length > 0) {
    for (const h of nyeHendingar) {
      console.log(`  [${h.hendelse}] ${h.kode} – ${h.detalj}`);
    }
  }
}

main().catch((err) => {
  console.error("Feil under henting av Grep-data:", err);
  process.exit(1);
});
