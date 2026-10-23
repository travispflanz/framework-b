#!/usr/bin/env node
// Checks, through the Cloudflare API, that a lead sent by starter/scripts/live-lead.mjs was stored correctly:
// the row, the visitor's subscription, the attribution and (when a file was sent) the file in R2.
// Inputs (environment): SITE_ID, LEAD_FILE (the live-lead.mjs output), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { cf, env } from "./lib/api.mjs";

const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const id = env("SITE_ID");
const lead = JSON.parse(readFileSync(env("LEAD_FILE"), "utf8"));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const db = (await cf(`${A}/d1/database?name=fb-ideas`)).find((d) => d.name === "fb-ideas");
const query = async (sql, params) => (await cf(`${A}/d1/database/${db.uuid}/query`, { method: "POST", body: { sql, params } }))[0].results;
const [row] = await query("SELECT * FROM leads WHERE id = ? AND site = ?", [lead.id, id]);
check("lead row saved for this site", !!row && row.email === lead.email);
const attr = JSON.parse(row?.attribution_json || "{}");
check("attribution captured", attr.utm_source === "live-selftest" && !!attr.landing, JSON.stringify(attr));
const [sub] = await query("SELECT status FROM subscribers WHERE site = ? AND email = ?", [id, lead.email]);
check("visitor auto-subscribed", sub?.status === "subscribed");
if (lead.file) {
  check("file recorded as stored", row?.upload_status === "stored", row?.upload_status);
  let bytes = "";
  try {
    // Run Wrangler from an empty folder so no project config is picked up.
    bytes = execFileSync("npx", ["--yes", "wrangler@4.152.0", "r2", "object", "get", `fb-ideas-uploads/${row.upload_key}`, "--remote", "--pipe"], {
      cwd: mkdtempSync(`${tmpdir()}/verify-`), stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {}
  check("file bytes in R2 match", bytes.includes("% live self-test file"));
}
console.log(failures ? `\n${failures} check(s) failed` : "\nLead verified");
process.exit(failures ? 1 : 0);
