#!/usr/bin/env node
// Checks a deployed site with client editing (EmDash) on: the editor is behind Cloudflare Access, the home page
// renders through EmDash, EmDash set up its own database, and the hourly Cron Trigger is in place.
// Inputs (environment): SITE_ID, SITE_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
import { cf, env } from "./lib/api.mjs";

const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const id = env("SITE_ID");
const base = env("SITE_URL").replace(/\/$/, "");
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

const editor = await fetch(`${base}/_emdash/admin`, { redirect: "manual" });
const where = editor.headers.get("location") || "";
check("the editor asks for a Cloudflare Access login", [302, 303].includes(editor.status) && /cloudflareaccess\.com/.test(where), `${editor.status} ${new URL(where || base).host}`);
const api = await fetch(`${base}/_emdash/api/content/pages`, { redirect: "manual" });
check("EmDash's API is behind Access too", [302, 303, 401, 403].includes(api.status), String(api.status));
const home = await fetch(`${base}/`);
check("home page renders through EmDash", home.status === 200, String(home.status));

const db = (await cf(`${A}/d1/database?name=${encodeURIComponent(`${id}-cms`)}`)).find((d) => d.name === `${id}-cms`);
let collections = [];
for (let i = 0; i < 10 && !collections.length; i++) {
  try {
    collections = (await cf(`${A}/d1/database/${db.uuid}/query`, { method: "POST", body: { sql: "SELECT slug FROM _emdash_collections" } }))[0].results;
  } catch {}
  if (!collections.length) await new Promise((r) => setTimeout(r, 3000));
}
check("EmDash applied the content model to its own database", collections.some((c) => c.slug === "pages"), collections.map((c) => c.slug).join(", "));
const q = async (sql) => (await cf(`${A}/d1/database/${db.uuid}/query`, { method: "POST", body: { sql } }))[0].results;
const fields = (await q("SELECT slug FROM _emdash_fields")).map((r) => r.slug);
check("pages have the section library's sections field", fields.includes("sections"), fields.join(", "));
const blockTypes = (await q("SELECT slug FROM _emdash_block_types")).map((r) => r.slug);
check("the section library is registered as EmDash block types", blockTypes.includes("fb_hero") && blockTypes.includes("fb_form"), blockTypes.join(", "));

const schedules = (await cf(`${A}/workers/scripts/${id}/schedules`)).schedules || [];
check("the hourly Cron Trigger is set", schedules.some((s) => s.cron === "17 * * * *"), schedules.map((s) => s.cron).join(", "));
process.exit(failures ? 1 : 0);
