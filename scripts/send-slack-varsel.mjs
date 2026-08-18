#!/usr/bin/env node
/**
 * send-slack-varsel.mjs
 *
 * Les data/siste-kjoring-endringar.json (skrive av fetch-grep-data.mjs) og
 * postar ei melding til Slack via ein Incoming Webhook, viss det er nye
 * hendingar av typen "erstattet" (eller "utgatt").
 *
 * Krev miljøvariabelen SLACK_WEBHOOK_URL – sjå README for korleis du lagar
 * ein Slack-app med Incoming Webhook og legg URL-en inn som GitHub secret.
 *
 * Gjer ingenting (avsluttar stille) viss:
 *  - SLACK_WEBHOOK_URL ikkje er sett, eller
 *  - det ikkje er nokon relevante hendingar denne kjøringa
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SISTE_KJORING_PATH = new URL("../data/siste-kjoring-endringar.json", import.meta.url);
const NETTSIDE_URL = process.env.NETTSIDE_URL || "";

const RELEVANTE_HENDELSER = new Set(["erstattet", "utgatt", "erstattes_status"]);

function formaterHending(h) {
  if (h.hendelse === "erstattet" && h.nyKode) {
    return `• \`${h.kode}\` → *erstatta av* \`${h.nyKode}\`  _(${h.tittel || ""})_`;
  }
  if (h.hendelse === "utgatt") {
    return `• \`${h.kode}\` → *sett til utgått* — ${h.detalj}`;
  }
  if (h.hendelse === "ny") {
    return `• \`${h.kode}\` → *ny kode publisert i Grep*  _(${h.tittel || ""})_`;
  }
  return `• \`${h.kode}\` → ${h.hendelse}: ${h.detalj}`;
}

async function main() {
  if (!WEBHOOK_URL) {
    console.log("SLACK_WEBHOOK_URL er ikkje sett – hoppar over Slack-varsel.");
    return;
  }
  if (!existsSync(SISTE_KJORING_PATH)) {
    console.log("Fann ikkje data/siste-kjoring-endringar.json – ingenting å varsle om.");
    return;
  }

  const { endringar } = JSON.parse(await readFile(SISTE_KJORING_PATH, "utf-8"));
  const relevante = (endringar || []).filter((h) => RELEVANTE_HENDELSER.has(h.hendelse));

  if (relevante.length === 0) {
    console.log("Ingen erstatningar/utgåtte kodar denne kjøringa – sender ikkje Slack-varsel.");
    return;
  }

  const lenkeLinje = NETTSIDE_URL ? `\n<${NETTSIDE_URL}|Sjå full oversikt →>` : "";
  const tekst =
    `*Grep-oppdatering: ${relevante.length} kode(r) endra*\n` +
    relevante.map(formaterHending).join("\n") +
    lenkeLinje;

  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: tekst }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Slack-webhook feila: ${res.status} ${res.statusText} – ${body}`);
  }

  console.log(`Sendte Slack-varsel om ${relevante.length} endring(ar).`);
}

main().catch((err) => {
  console.error("Feil under sending av Slack-varsel:", err);
  process.exit(1);
});