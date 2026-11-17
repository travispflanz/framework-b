#!/usr/bin/env node
// Checks, through the Cloudflare API, that leads sent by starter/scripts/live-lead.mjs were stored correctly:
// the row, the visitor's subscription, the attribution and (when a file was sent) the file in R2, byte for byte.
// Usage: node scripts/site/verify-lead.mjs [lead.json ...]   (each a live-lead.mjs output; default: LEAD_FILE)
// Inputs (environment): SITE_ID, LEAD_FILE (when no files are named), CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
// In GitHub Actions, one line a lead goes to the job summary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cf, env } from "./lib/api.mjs";

const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const id = env("SITE_ID");
const files = process.argv.slice(2).length ? process.argv.slice(2) : [env("LEAD_FILE")];
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const db = (await cf(`${A}/d1/database?name=fb-ideas`)).find((d) => d.name === "fb-ideas");
const query = async (sql, params) => (await cf(`${A}/d1/database/${db.uuid}/query`, { method: "POST", body: { sql, params } }))[0].results;

const summary = [];
for (const file of files) {
  const before = failures;
  const lead = JSON.parse(readFileSync(file, "utf8"));
  console.log(`\n${file}${lead.fileBytes ? `: a file of ${lead.fileBytes} bytes` : ""}`);
  const [row] = await query("SELECT * FROM leads WHERE id = ? AND site = ?", [lead.id, id]);
  check("lead row saved for this site", !!row && row.email === lead.email);
  const attr = JSON.parse(row?.attribution_json || "{}");
  check("attribution captured", attr.utm_source === "live-selftest" && !!attr.landing, JSON.stringify(attr));
  const [sub] = await query("SELECT status FROM subscribers WHERE site = ? AND email = ?", [id, lead.email]);
  check("visitor auto-subscribed", sub?.status === "subscribed");
  if (!lead.file) {
    summary.push(`- Lead without a file: ${failures === before ? "stored" : "**failed**"}`);
    continue;
  }
  check("file recorded as stored", row?.upload_status === "stored", row?.upload_status);
  if (lead.fileBytes) check("recorded size matches", row?.upload_size === lead.fileBytes, `${row?.upload_size} vs ${lead.fileBytes}`);
  let bytes = Buffer.alloc(0);
  try {
    // Run Wrangler from an empty folder so no project config is picked up; write to a file, not a pipe, so a large
    // object isn't held in a buffer.
    const dir = mkdtempSync(join(tmpdir(), "verify-"));
    const out = join(dir, "object");
    execFileSync("npx", ["--yes", "wrangler@4.152.0", "r2", "object", "get", `fb-ideas-uploads/${row.upload_key}`, "--remote", "--file", out], {
      cwd: dir, stdio: ["ignore", "ignore", "ignore"], timeout: 300_000,
    });
    if (statSync(out).size) bytes = readFileSync(out);
  } catch {}
  if (lead.fileSha256) {
    check("file size in R2 matches", bytes.length === lead.fileBytes, `${bytes.length} vs ${lead.fileBytes} bytes`);
    const sha = createHash("sha256").update(bytes).digest("hex");
    check("file SHA-256 in R2 matches", sha === lead.fileSha256, sha);
  } else {
    check("file bytes in R2 match", bytes.toString("latin1").includes("% live self-test file"));
  }
  const ok = failures === before;
  summary.push(`- Lead with ${lead.fileName || "a file"} (${lead.fileBytes ?? bytes.length} bytes): ${ok ? `stored${lead.fileSha256 ? ", size and SHA-256 match in R2" : ""}` : "**failed**"}`);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Leads on ${id}\n\n${summary.join("\n")}\n\n`);
console.log(failures ? `\n${failures} check(s) failed` : `\n${files.length} lead(s) verified`);
process.exit(failures ? 1 : 0);
