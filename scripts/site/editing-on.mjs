#!/usr/bin/env node
// Switches client editing (EmDash) on for a site that already exists (one made with editing off, or adopted), in its
// checkout, ready for a pull request. `site create` does the same for a new site when EDITING=on; this is the
// ops repo's **site editing** workflow with mode "on" (docs/SPEC.md section 9).
//
//   node scripts/site/editing-on.mjs --site <site checkout> [--editors "a@example.com,b@example.com"] [--dry-run]
//
// In the account (idempotent, so a rerun reuses what an earlier run made):
//   - checks the Free plan's budget first: 2 more D1 databases (10 per account) and the hourly Cron Trigger (5 per
//     account; the site's own schedule doesn't count, because the deploy replaces it);
//   - D1 <id>-cms and <id>-cms-preview, R2 <id>-media and <id>-media-preview, KV <id>-session and <id>-session-preview;
//   - the Access application "<id> editor" on <host>/_emdash for the site's hosts (its canonical host, and its
//     workers.dev host when that is on), allowing the owner and any editors named;
//   - Worker secrets CF_ACCESS_AUDIENCE (the editor application's audience) and EMDASH_ENCRYPTION_KEY (generated once,
//     never replaced: it encrypts what EmDash stores), and for previews the same key and the previews application's
//     audience. Setting a secret deploys the running code again with it; the code ignores it until the pull request
//     is merged.
// Then in the site: `node scripts/editing.mjs on` (the overlay, the seed with the site's own pictures, the packages), then
// the real resource ids in wrangler.jsonc, production and previews.
// Inputs (environment): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cf, env, log } from "./lib/api.mjs";
import { previewsApp } from "./lib/access-agent.mjs";
import { previewsAppName } from "./lib/adopt.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = resolve(arg("site", "."));
const DRY = process.argv.includes("--dry-run");
const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const report = [];
const did = (s) => {
  report.push(s);
  log(s);
};
const read = (f) => readFileSync(join(SITE, f), "utf8");
const site = JSON.parse(read("site.config.json"));
const id = site.site.id;
if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(id || "")) throw new Error(`site.config.json site.id "${id}" isn't a site id`);
if (site.editing?.enabled) {
  did("client editing is already on in this site; nothing to do");
  process.exit(0);
}
const { stripJsonc } = await import(join(SITE, "scripts/lib/jsonc.mjs"));
const wrangler = JSON.parse(stripJsonc(read("wrangler.jsonc")));
const worker = wrangler.name;
const adopt = existsSync(join(SITE, "adopt.json")) ? JSON.parse(read("adopt.json")) : null;
const editors = [...new Set([site.site.ownerEmail, ...String(arg("editors", "")).split(",")].map((e) => e.trim().toLowerCase()).filter(Boolean))];
for (const e of editors) if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`"${e}" isn't an email address`);

// 1. Budget (https://developers.cloudflare.com/d1/platform/limits/ and
// https://developers.cloudflare.com/workers/platform/limits/, checked 2026-10-23).
const databases = (await cf(`${A}/d1/database?per_page=100`)) || [];
const missingDbs = [`${id}-cms`, `${id}-cms-preview`].filter((n) => !databases.some((d) => d.name === n));
if (databases.length + missingDbs.length > 10) throw new Error(`Client editing needs ${missingDbs.length} more D1 database(s), and this account has ${databases.length} of the Free plan's 10`);
let crons = 0;
for (const script of (await cf(`${A}/workers/scripts`)) || []) {
  if (script.id === worker) continue;
  crons += ((await cf(`${A}/workers/scripts/${script.id}/schedules`, { allow404: true }))?.schedules || []).length;
}
if (crons >= 5) throw new Error(`Client editing needs a Cron Trigger, and the account's other Workers use ${crons} of the Free plan's 5`);
did(`budget: D1 databases ${databases.length + missingDbs.length}/10 after this, Cron Triggers ${crons + 1}/5`);
if (DRY) {
  did(`dry run: would make ${missingDbs.join(", ") || "no databases (they exist)"}, R2 ${id}-media (+ preview), KV ${id}-session (+ preview), the Access application "${id} editor" for ${editors.join(", ")}, the two secrets, and switch the site on`);
  process.exit(0);
}

// 2. Resources.
async function ensureD1(name) {
  const found = ((await cf(`${A}/d1/database?name=${encodeURIComponent(name)}`)) || []).find((d) => d.name === name);
  return found ? found.uuid : (await cf(`${A}/d1/database`, { method: "POST", body: { name } })).uuid;
}
async function ensureBucket(name) {
  if (!(await cf(`${A}/r2/buckets/${name}`, { allow404: true }))) await cf(`${A}/r2/buckets`, { method: "POST", body: { name } });
}
async function ensureKv(title) {
  const found = ((await cf(`${A}/storage/kv/namespaces?per_page=100`)) || []).find((n) => n.title === title);
  return found ? found.id : (await cf(`${A}/storage/kv/namespaces`, { method: "POST", body: { title } })).id;
}
const cms = { db: await ensureD1(`${id}-cms`), previewDb: await ensureD1(`${id}-cms-preview`), session: await ensureKv(`${id}-session`), previewSession: await ensureKv(`${id}-session-preview`) };
await ensureBucket(`${id}-media`);
await ensureBucket(`${id}-media-preview`);
did(`resources: D1 ${id}-cms (+ preview), R2 ${id}-media (+ preview), KV ${id}-session (+ preview)`);

// 3. Access on /_emdash: EmDash checks the Access JWT on all of /_emdash/*, so the application covers the whole path.
const sub = (await cf(`${A}/workers/subdomain`, { allow404: true }))?.subdomain;
const hosts = [...new Set([site.site.canonicalHost, wrangler.workers_dev !== false && sub ? `${worker}.${sub}.workers.dev` : null].filter(Boolean))];
const body = {
  type: "self_hosted",
  name: `${id} editor`,
  domain: `${hosts[0]}/_emdash`,
  destinations: hosts.map((h) => ({ type: "public", uri: `${h}/_emdash` })),
  session_duration: "24h",
  policies: [{ name: "editors", decision: "allow", include: editors.map((email) => ({ email: { email } })) }],
};
const existing = ((await cf(`${A}/access/apps`)) || []).find((a) => a.name === `${id} editor`);
const editorApp = existing ? await cf(`${A}/access/apps/${existing.id}`, { method: "PUT", body }) : await cf(`${A}/access/apps`, { method: "POST", body });
did(`Access application "${id} editor" ${existing ? "updated" : "created"} on ${hosts.map((h) => `${h}/_emdash`).join(" and ")}, for ${editors.join(", ")}`);

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: SITE, stdio: ["ignore", "inherit", "inherit"], ...opts });
// 4. Secrets, set with the site's wrangler config as it is (before `on` changes it). The key is generated once, in
// EmDash's own format (the version the site will install), and never replaced.
const names = ((await cf(`${A}/workers/scripts/${worker}/secrets`, { allow404: true })) || []).map((s) => s.name);
const secret = (name, value, preview = false) => {
  const args = preview ? ["wrangler", "preview", "base-config", "secret", "put", name] : ["wrangler", "secret", "put", name, "--name", worker];
  sh("npx", args, { input: value, stdio: ["pipe", "ignore", "inherit"] });
};
secret("CF_ACCESS_AUDIENCE", editorApp.aud);
let key = null;
if (!names.includes("EMDASH_ENCRYPTION_KEY")) {
  const version = JSON.parse(read("editing/packages.json")).dependencies.emdash;
  key = execFileSync("npx", ["--yes", `emdash@${version}`, "secrets", "generate"], { cwd: tmpdir(), encoding: "utf8" }).trim().split("\n").pop().trim();
  secret("EMDASH_ENCRYPTION_KEY", key);
}
did(`secrets: CF_ACCESS_AUDIENCE set on ${worker}; EMDASH_ENCRYPTION_KEY ${key ? "generated and set" : "kept (already set)"}`);
// On a preview URL the Access JWT comes from the previews application, so EmDash expects its audience there.
const pApp = await previewsApp(A, id, previewsAppName(id, adopt));
try {
  if (key) secret("EMDASH_ENCRYPTION_KEY", key, true);
  if (pApp) secret("CF_ACCESS_AUDIENCE", pApp.aud, true);
  did(`preview secrets: ${[key && "EMDASH_ENCRYPTION_KEY", pApp && `CF_ACCESS_AUDIENCE (from "${pApp.name}")`].filter(Boolean).join(", ") || "nothing new"}`);
} catch (e) {
  did(`! preview secrets not set (${String(e.message).split("\n")[0].slice(0, 160)}); previews can't open the editor until they are`);
}

// 5. The site's files.
sh("node", ["scripts/editing.mjs", "on"]);
const w = JSON.parse(stripJsonc(read("wrangler.jsonc")));
const fill = (list, binding, value) => (list || []).map((x) => (x.binding === binding ? { ...x, ...value } : x));
w.d1_databases = fill(w.d1_databases, "CMS_DB", { database_name: `${id}-cms`, database_id: cms.db });
w.r2_buckets = fill(w.r2_buckets, "MEDIA", { bucket_name: `${id}-media` });
w.kv_namespaces = fill(w.kv_namespaces, "SESSION", { id: cms.session });
// Previews never touch the production content (EmDash's Cloudflare guide, checked 2026-10-23).
if (w.previews) {
  w.previews.d1_databases = [...(w.previews.d1_databases || []).filter((d) => d.binding !== "CMS_DB"), { binding: "CMS_DB", database_name: `${id}-cms-preview`, database_id: cms.previewDb }];
  w.previews.r2_buckets = [...(w.previews.r2_buckets || []).filter((b) => b.binding !== "MEDIA"), { binding: "MEDIA", bucket_name: `${id}-media-preview` }];
  w.previews.kv_namespaces = [...(w.previews.kv_namespaces || []).filter((k) => k.binding !== "SESSION"), { binding: "SESSION", id: cms.previewSession }];
}
if (/<[a-z-]+>/.test(JSON.stringify(w))) throw new Error("wrangler.jsonc still has a <placeholder> after filling the editing bindings");
writeFileSync(join(SITE, "wrangler.jsonc"), "// Client editing on (scripts/site/editing-on.mjs). Resource IDs are not secrets.\n" + JSON.stringify(w, null, 2) + "\n");
did("site: editing switched on (scripts/editing.mjs on), bindings filled in wrangler.jsonc for production and previews");

const out = arg("report", "");
if (out) writeFileSync(out, report.map((r) => `- ${r}`).join("\n") + "\n");
