#!/usr/bin/env node
// Checks, through the Cloudflare API, that a lead sent by starter/scripts/live-lead.mjs was stored correctly:
// the row, the visitor's subscription, the attribution and (when a file was sent) the file in R2, byte for byte. On a
// site with the consent box (optIn.mode "checkbox"), the ticked lead's row and subscription keep the box's wording, and
// the second lead, sent with the box unticked, kept no wording and subscribed no one.
// Then probes the per-IP rate limit on the live form (scripts/site/lib/selftest.mjs). The probe runs last: nothing
// after this step in the self-test posts to the form endpoint (the preview check only loads pages), and its posts
// carry no Turnstile token, so they store nothing.
// Inputs (environment): SITE_ID, LEAD_FILE (the live-lead.mjs output), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID;
// GITHUB_STEP_SUMMARY (optional) gets the results.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cf, env } from "./lib/api.mjs";
import { probeRateLimit, sameWording } from "./lib/selftest.mjs";

const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const id = env("SITE_ID");
const lead = JSON.parse(readFileSync(env("LEAD_FILE"), "utf8"));
let failures = 0;
const summary = ["### Live lead", ""];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  summary.push(`- ${ok ? "PASS" : "**FAIL**"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
const size = (n) => (n < 1024 * 1024 ? `${n}-byte` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const db = (await cf(`${A}/d1/database?name=fb-ideas`)).find((d) => d.name === "fb-ideas");
const query = async (sql, params) => (await cf(`${A}/d1/database/${db.uuid}/query`, { method: "POST", body: { sql, params } }))[0].results;
const [row] = await query("SELECT * FROM leads WHERE id = ? AND site = ?", [lead.id, id]);
check("lead row saved for this site", !!row && row.email === lead.email);
const attr = JSON.parse(row?.attribution_json || "{}");
check("attribution captured", attr.utm_source === "live-selftest" && !!attr.landing, JSON.stringify(attr));
const [sub] = await query("SELECT status, consent_text FROM subscribers WHERE site = ? AND email = ?", [id, lead.email]);
if (lead.consent?.box) {
  // Checkbox mode: the wording on record is the box's label, as the visitor read it.
  check("lead row keeps the consent box's wording", sameWording(row?.consent_text, lead.consent.label), JSON.stringify(row?.consent_text ?? null));
  check("visitor subscribed by ticking the box, with its wording", sub?.status === "subscribed" && sameWording(sub?.consent_text, lead.consent.label), sub?.status || "no subscriber row");
} else check("visitor auto-subscribed", sub?.status === "subscribed");
if (lead.consent?.box && !lead.consent.required) {
  const [quiet] = lead.unticked?.id ? await query("SELECT email, consent_text FROM leads WHERE id = ? AND site = ?", [lead.unticked.id, id]) : [];
  check("lead sent with the box unticked saved, with no consent wording", !!quiet && quiet.email === lead.unticked.email && quiet.consent_text === "",
    quiet ? JSON.stringify(quiet.consent_text) : "no row");
  const [none] = lead.unticked?.email ? await query("SELECT status FROM subscribers WHERE site = ? AND email = ?", [id, lead.unticked.email]) : [{ status: "no lead" }];
  check("an unticked box subscribed no one", !none, none?.status);
}
if (lead.file) {
  check("file recorded as stored", row?.upload_status === "stored", row?.upload_status);
  check("stored size is the size sent", row?.upload_size === lead.fileBytes, `${row?.upload_size} of ${lead.fileBytes} bytes`);
  // Downloaded to a file, not a pipe: a file over 10 MB would overflow execFileSync's output buffer.
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  const file = join(dir, "upload.bin");
  let got = null;
  try {
    // Run Wrangler from an empty folder so no project config is picked up.
    execFileSync("npx", ["--yes", "wrangler@4.152.0", "r2", "object", "get", `fb-ideas-uploads/${row.upload_key}`, "--remote", "--file", file], {
      cwd: dir, stdio: ["ignore", "ignore", "ignore"],
    });
    if (existsSync(file)) got = readFileSync(file);
  } catch {}
  const sha = got ? createHash("sha256").update(got).digest("hex") : "";
  check(`file in R2 matches the ${size(lead.fileBytes || 0)} file sent (size and SHA-256)`, !!got && got.length === lead.fileBytes && sha === lead.fileSha256,
    got ? `${got.length} bytes, sha256 ${sha.slice(0, 12)}…` : "not downloaded");
}

// 3c: the per-IP rate limit, as scripts/site/create.mjs sets it (5 posts per 60 s per address).
const probe = await probeRateLimit({ url: lead.url, form: row?.form || "contact", limit: 5, periodSeconds: 60 });
console.log(`${probe.result.toUpperCase()}  rate limit  (${probe.detail})`);
summary.push("", "### Rate limit (per address)", "", `**${probe.result.toUpperCase()}**: ${probe.detail}.`, "", `Answers: ${probe.answers}.`);
if (probe.result === "fail") failures++;
if (probe.result === "inconclusive") console.log(`::warning title=Rate limit probe inconclusive::${probe.detail}`);

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n\n");
console.log(failures ? `\n${failures} check(s) failed` : "\nLead verified");
process.exit(failures ? 1 : 0);
