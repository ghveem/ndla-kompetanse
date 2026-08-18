#!/usr/bin/env node
/**
 * fetch-artikkel-merking.mjs
 *
 * Søker opp NDLA-artiklar merka med utgåtte/erstatta kompetansemål-kodar,
 * via NDLA sitt eige search-api (https://api.ndla.no/search-api/api-docs).
 *
 * Nøkkelfunn (2026-08-18, verifisert manuelt):
 *  - Parameteren heiter "grep-codes" (kebab-case) i sjølve REST-kallet,
 *    IKKJE "grepCodes" (camelCase) — sjølv om nettsida sin URL bruker
 *    camelCase (ndla.no/search?grepCodes=...). Nettsida oversett truleg
 *    dette til kebab-case bak kulissane.
 *  - Filtreringa fungerer korrekt (verifisert med KM2755 -> 9 relevante
 *    treff), men feltet "grepCodes" i sjølve svaret er alltid tomt — det
 *    er ikkje eit problem for oss, sidan vi alt veit kva kode vi søkte på.
 *  - "context.url" i kvart treff er den rette relative artikkel-adressa
 *    (t.d. "/r/energi--og-styresystemer-el-ele-vg1/..."), prefiks med
 *    https://ndla.no for full lenke.
 *
 * Vi søker berre på kompetansemål som IKKJE er "publisert" i vårt eige
 * NDLA-filtrerte snapshot (data/grep-snapshot.json) — det er dei einaste
 * kodane det er nyttig å varsle redaktørar om.
 *
 * Køyr lokalt:
 *   node scripts/fetch-artikkel-merking.mjs
 */

import { readFile, writeFile } from "node:fs/promises";

const SNAPSHOT_PATH = new URL("../data/grep-snapshot.json", import.meta.url);
const OUTPUT_PATH = new URL("../data/artikkel-merking.json", import.meta.url);
const SEARCH_API = "https://api.ndla.no/search-api/v1/search";
const NDLA_BASE = "https://ndla.no";
const CONCURRENCY = Number(process.env.ARTIKKEL_CONCURRENCY || 8);
const PAGE_SIZE = 50;

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

async function sokArtiklarForKode(kode) {
  const url = `${SEARCH_API}?grep-codes=${encodeURIComponent(kode)}&page-size=${PAGE_SIZE}&fallback=true`;
  try {
    const data = await fetchJson(url);
    return (data.results || []).map((r) => ({
      artikkelId: String(r.id),
      tittel: r.title?.title || "(utan tittel)",
      url: r.context?.url ? `${NDLA_BASE}${r.context.url}` : null,
      kode,
    }));
  } catch (err) {
    console.warn(`  Klarte ikkje søke etter ${kode}: ${err.message}`);
    return [];
  }
}

async function main() {
  const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf-8"));
  const utgatteKompetansemaal = snapshot.elementer.filter(
    (e) => e.type === "kompetansemaal_lk20" && e.status !== "publisert"
  );

  console.log(
    `Søker NDLA-artiklar for ${utgatteKompetansemaal.length} utgåtte/erstatta kompetansemål-kodar...`
  );

  const alleTreff = await mapWithConcurrency(utgatteKompetansemaal, CONCURRENCY, (e) =>
    sokArtiklarForKode(e.kode)
  );

  // Slå saman treff per artikkel — éin artikkel kan vere merka med fleire utgåtte kodar
  const artiklarMap = new Map();
  for (const treffListe of alleTreff) {
    for (const treff of treffListe) {
      if (!treff.url) continue; // hopp over treff utan brukbar lenke
      const eksisterande = artiklarMap.get(treff.artikkelId);
      if (eksisterande) {
        if (!eksisterande.kmKoder.includes(treff.kode)) eksisterande.kmKoder.push(treff.kode);
      } else {
        artiklarMap.set(treff.artikkelId, {
          artikkelId: treff.artikkelId,
          tittel: treff.tittel,
          url: treff.url,
          kmKoder: [treff.kode],
        });
      }
    }
  }

  const merking = [...artiklarMap.values()].sort((a, b) => a.tittel.localeCompare(b.tittel, "nb"));

  await writeFile(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generert: new Date().toISOString(),
        kjelde: "NDLA search-api (grep-codes), filtrert på utgåtte/erstatta kompetansemål",
        merking,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );

  console.log(`\nFerdig. ${merking.length} artiklar merka med utgåtte/erstatta kompetansemål-kodar.`);
}

main().catch((err) => {
  console.error("Feil under henting av artikkel-merking:", err);
  process.exit(1);
});
