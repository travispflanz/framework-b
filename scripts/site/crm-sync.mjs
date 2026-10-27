#!/usr/bin/env node
// Copies a site's leads to its CRM mirror (packages/core/src/crm.js): the owner's Google Sheet (through the
// Apps Script mailer) and/or the site's webhook. Every row carries the lead id, which the Sheet and the webhook
// treat as the idempotency key, so this can run any number of times. It is how older leads get in when the
// mirror is switched on, and how a copy that failed at submit time is retried.
//
//   node scripts/site/crm-sync.mjs --site <site checkout> [--days 30]
//
// Inputs (environment): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and for the targets the site has on in
// site.config.json "crm": MAILER_URL and MAILER_SECRET (sheet), CRM_WEBHOOK_URL and CRM_WEBHOOK_SECRET (webhook).
// Status: untested end to end until the first site switches the mirror on.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, env, log } from "./lib/api.mjs";

const FRAMEWORK = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const { stripJsonc } = await import(join(FRAMEWORK, "starter/scripts/lib/jsonc.mjs"));
const { crmRow, toSheet, toWebhook } = await import(join(FRAMEWORK, "packages/core/src/crm.js"));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = resolve(arg("site", "."));
const days = Number(arg("days", "0")) || 0;
const config = JSON.parse(readFileSync(join(SITE, "site.config.json"), "utf8"));
const crm = { sheet: false, webhook: false, ...(config.crm || {}) };
if (!crm.sheet && !crm.webhook) throw new Error('This site has no CRM mirror: set "crm": { "sheet": true } and/or "webhook": true in site.config.json');
const wrangler = JSON.parse(stripJsonc(readFileSync(join(SITE, "wrangler.jsonc"), "utf8")));
const dbId = wrangler.d1_databases.find((d) => d.binding === "DB")?.database_id;
const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
const leads = (await cf(`${A}/d1/database/${dbId}/query`, {
  method: "POST",
  body: { sql: `SELECT * FROM leads WHERE site = ?${since ? " AND created_at >= ?" : ""} ORDER BY created_at`, params: since ? [config.site.id, since] : [config.site.id] },
}))[0]?.results || [];
const parse = (s) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};
const rows = leads.map((l) => crmRow(config, { id: l.id, form: l.form, email: l.email, createdAt: l.created_at, page: l.page, country: l.country, fields: parse(l.fields_json), attribution: parse(l.attribution_json) }));
const lines = [`- ${rows.length} lead(s)${days ? ` from the last ${days} days` : ""}`];
const runtimeEnv = { MAILER_URL: process.env.MAILER_URL?.trim(), MAILER_SECRET: process.env.MAILER_SECRET, CRM_WEBHOOK_URL: process.env.CRM_WEBHOOK_URL, CRM_WEBHOOK_SECRET: process.env.CRM_WEBHOOK_SECRET };
let failed = 0;
if (crm.sheet && rows.length) {
  let added = 0;
  let existing = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const r = await toSheet(runtimeEnv, config, rows.slice(i, i + 200));
    added += r?.added || 0;
    existing += r?.existing || 0;
  }
  lines.push(`- Sheet: ${added} added, ${existing} already there`);
}
if (crm.webhook && !runtimeEnv.CRM_WEBHOOK_URL) {
  lines.push("- Webhook: skipped (CRM_WEBHOOK_URL is a per-site Worker secret; give it to this run to resend)");
} else if (crm.webhook) {
  let sent = 0;
  for (const row of rows) {
    try {
      await toWebhook(runtimeEnv, config, row);
      sent++;
    } catch (e) {
      failed++;
      console.log(`! ${row.id}: ${e.message}`);
    }
  }
  lines.push(`- Webhook: ${sent} sent${failed ? `, ${failed} failed` : ""}`);
}
for (const l of lines) log(l.slice(2));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CRM sync for ${config.site.id}\n\n${lines.join("\n")}\n`);
if (failed) process.exit(1);
