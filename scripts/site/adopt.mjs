#!/usr/bin/env node
// Moves an existing site that wasn't built with Framework B onto it, keeping its Worker (so its domains, Access
// applications, Turnstile widget and secrets stay) and copying its leads into new Framework B databases. The old
// database is only ever read; nothing in it is changed or deleted. Runs in the owner's private ops repo.
//
//   node scripts/site/adopt.mjs --site <new site checkout> --phase prepare|preview|cutover|rollback [--dry-run] [--report <file.md>]
//
// The site repo is a normal Framework B site (built from the starter, launch mode) with an adopt.json (format in
// lib/adopt.mjs) and the mapping queries it names, which turn the old rows into core's schema.
//
// Phase "prepare" (before the owner reviews the new site):
//   1. Checks adopt.json and the mapping queries (single read-only SELECTs), that the Worker and the old database
//      exist, and that the Free plan's D1 budget (10 databases) has room for the new ones.
//   2. Creates <id>-prod and <id>-staging with core's migrations, and copies the mapped leads and subscribers into
//      <id>-prod (INSERT OR IGNORE: a rerun only adds what is new). Every mapped row is checked first.
//   3. Uploads: "reuse" keeps the existing bucket (the keys stay valid); "copyFrom" copies every stored file.
//   4. Adds SIGNING_SECRET to the Worker when it has none (wrangler secret put deploys a version with the same code
//      and the new secret, which the old code ignores) and to the previews' base configuration.
//   5. Records the Worker's current Workers Builds triggers in adopt.json (legacyBuild), writes the database ids into
//      wrangler.jsonc. The caller commits them on the site's branch.
// Phase "preview": uploads the checkout as a preview version of the Worker (`wrangler preview`), so the new site can be
//   checked on its preview URL while production still runs the old code. Prints the URL.
// Phase "cutover" (after the owner merges the new site into main): copies new arrivals, points the Worker's Workers
//   Builds triggers at the new repo, builds main (which deploys the new site with the new database), copies anything
//   that reached the old database in between, and checks the live site.
// Phase "rollback": points the triggers back at the old repo (adopt.json legacyRepo and legacyBuild) and builds its
//   main. The new database keeps what it received; the old one still has everything from before the cutover.
//
// Inputs (environment): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID; CF_BUILDS_TOKEN and GH_SITES_TOKEN for cutover
// and rollback. Status: untested end to end until the first adoption.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, env, gh, log } from "./lib/api.mjs";
import { connectBuilds, waitForBuild } from "./lib/builds.mjs";
import { launchNames } from "./lib/promote.mjs";
import { adoptWrangler, checkAdoptConfig, checkLeadRow, checkSelect, checkSubscriberRow, keepTrigger } from "./lib/adopt.mjs";

const FRAMEWORK = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const { stripJsonc } = await import(join(FRAMEWORK, "starter/scripts/lib/jsonc.mjs"));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = resolve(arg("site", "."));
const phase = arg("phase", "prepare");
const DRY = process.argv.includes("--dry-run");
const REPORT = arg("report", "");
if (!["prepare", "preview", "cutover", "rollback"].includes(phase)) throw new Error('--phase must be "prepare", "preview", "cutover" or "rollback"');

const ACCOUNT = env("CLOUDFLARE_ACCOUNT_ID");
const A = `/accounts/${ACCOUNT}`;
const adoptPath = join(SITE, "adopt.json");
if (!existsSync(adoptPath)) throw new Error(`${adoptPath} is missing (format: framework-b scripts/site/lib/adopt.mjs)`);
const adopt = JSON.parse(readFileSync(adoptPath, "utf8"));
const configErrors = checkAdoptConfig(adopt);
if (configErrors.length) throw new Error(configErrors.join("\n"));
const config = JSON.parse(readFileSync(join(SITE, "site.config.json"), "utf8"));
const wranglerPath = join(SITE, "wrangler.jsonc");
const wrangler = JSON.parse(stripJsonc(readFileSync(wranglerPath, "utf8")));
const id = config.site.id;
const names = launchNames(id);
const lines = [];
const warnings = [];
const done = (step, detail = "") => {
  lines.push(`- ${step}${detail ? `: ${detail}` : ""}`);
  log(step, detail);
};
const warn = (msg) => {
  warnings.push(msg);
  console.log(`! ${msg}`);
};
const wranglerBin = () => (existsSync(join(SITE, "node_modules/.bin/wrangler")) ? join(SITE, "node_modules/.bin/wrangler") : "wrangler");
const runWrangler = (args, opts = {}) => execFileSync(wranglerBin(), args, { cwd: SITE, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", env: { ...process.env, CI: "1" }, ...opts });

async function d1(name, { create = false } = {}) {
  const found = (await cf(`${A}/d1/database?name=${encodeURIComponent(name)}`)).find((d) => d.name === name);
  if (found || !create) return found?.uuid || null;
  return (await cf(`${A}/d1/database`, { method: "POST", body: { name } })).uuid;
}
async function query(uuid, sql, params = []) {
  return (await cf(`${A}/d1/database/${uuid}/query`, { method: "POST", body: { sql, params } }))[0]?.results || [];
}
async function applyMigrations(dbName, uuid) {
  const tmp = mkdtempSync(join(tmpdir(), "adopt-db-"));
  const cfg = join(tmp, "wrangler.json");
  writeFileSync(cfg, JSON.stringify({ name: `${id}-adopt-migrate`, compatibility_date: "2026-10-01", d1_databases: [{ binding: "DB", database_name: dbName, database_id: uuid, migrations_dir: join(SITE, "core/migrations") }] }));
  try {
    runWrangler(["d1", "migrations", "apply", dbName, "--remote", "--config", cfg]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
async function workerTag() {
  const tag = (await cf(`${A}/workers/scripts`)).find((s) => s.id === adopt.worker)?.tag;
  if (!tag) throw new Error(`Worker ${adopt.worker} not found in the account`);
  return tag;
}
const readSql = (file, label) => {
  const sql = readFileSync(join(SITE, file), "utf8");
  const problem = checkSelect(sql, label);
  if (problem) throw new Error(problem);
  return sql.trim().replace(/;\s*$/, "");
};

// Maps the old rows and copies them into <id>-prod. Every row is checked before any is written.
async function copyRows(legacyUuid, prodUuid) {
  const leadsSql = readSql(adopt.leadsSql, adopt.leadsSql);
  const subsSql = adopt.subscribersSql ? readSql(adopt.subscribersSql, adopt.subscribersSql) : null;
  const leads = (await query(legacyUuid, leadsSql)).map((r) => checkLeadRow(r, id));
  const subs = subsSql ? (await query(legacyUuid, subsSql)).map((r) => checkSubscriberRow(r, id)) : [];
  const bad = [...leads.map((l, i) => [`lead ${l.row.id ?? i}`, l.errors]), ...subs.map((s, i) => [`subscriber ${i}`, s.errors])].filter(([, e]) => e.length);
  if (bad.length) throw new Error(`The mapping queries return rows core can't store (nothing was copied):\n${bad.slice(0, 20).map(([w, e]) => `- ${w}: ${e.join("; ")}`).join("\n")}`);
  let added = { leads: 0, subscribers: 0 };
  if (!DRY) {
    for (const [table, rows, key] of [["leads", leads, "leads"], ["subscribers", subs, "subscribers"]]) {
      for (const { row } of rows) {
        const cols = Object.keys(row);
        const r = await cf(`${A}/d1/database/${prodUuid}/query`, {
          method: "POST",
          body: { sql: `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => row[c]) },
        });
        added[key] += r[0]?.meta?.changes || 0;
      }
    }
    const [{ n: total }] = await query(prodUuid, "SELECT count(*) AS n FROM leads WHERE site = ?", [id]);
    if (total < leads.length) throw new Error(`Copied leads don't add up: ${total} in ${names.db}, ${leads.length} mapped from ${adopt.legacyDb}`);
  }
  return { mapped: { leads: leads.length, subscribers: subs.length }, added, uploads: leads.filter((l) => l.row.upload_status === "stored" && l.row.upload_key).map((l) => l.row.upload_key) };
}

async function copyUploads(keys) {
  if ((adopt.uploads ?? "reuse") === "reuse") return `reusing the existing bucket; ${keys.length} stored file(s) keep their keys`;
  const from = adopt.uploads.copyFrom;
  if (DRY) return `would copy ${keys.length} file(s) from ${from} to ${names.uploads}`;
  if (!(await cf(`${A}/r2/buckets/${names.uploads}`, { allow404: true }))) await cf(`${A}/r2/buckets`, { method: "POST", body: { name: names.uploads } });
  const scratch = mkdtempSync(join(tmpdir(), "adopt-"));
  let copied = 0;
  try {
    for (const key of keys) {
      const file = join(scratch, "object");
      runWrangler(["r2", "object", "get", `${from}/${key}`, "--file", file, "--remote"]);
      runWrangler(["r2", "object", "put", `${names.uploads}/${key}`, "--file", file, "--remote"]);
      rmSync(file, { force: true });
      copied++;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return `${copied} of ${keys.length} file(s) copied from ${from} to ${names.uploads}`;
}

async function triggers(tag) {
  return (await cf(`${A}/builds/workers/${tag}/triggers`, { token: env("CF_BUILDS_TOKEN"), allow404: true })) || [];
}
// Points the Worker's Workers Builds at another repo: the current triggers are deleted and two new ones created
// (the documented way; whether PATCH can change a trigger's repo isn't documented, checked 2026-10-28).
async function repoint(tag, repoName, build) {
  const bt = env("CF_BUILDS_TOKEN");
  for (const t of await triggers(tag)) await cf(`${A}/builds/triggers/${t.trigger_uuid}`, { method: "DELETE", token: bt });
  const ghUser = await gh("/user");
  const repo = await gh(`/repos/${ghUser.login}/${repoName}`);
  if (!build) return connectBuilds({ A, tag, ghUser, repo });
  const conn = await cf(`${A}/builds/repos/connections`, { method: "PUT", token: bt, body: { provider_type: "github", provider_account_id: String(ghUser.id), provider_account_name: ghUser.login, repo_id: String(repo.id), repo_name: repo.name } });
  const tokens = await cf(`${A}/builds/tokens`, { token: bt });
  for (const t of build) await cf(`${A}/builds/triggers`, { method: "POST", token: bt, body: { ...t, external_script_id: tag, repo_connection_uuid: conn.repo_connection_uuid, build_token_uuid: tokens[0].build_token_uuid } });
  return { already: false, triggers: build.length };
}
async function buildMain(tag) {
  const bt = env("CF_BUILDS_TOKEN");
  const prod = (await triggers(tag)).find((t) => (t.branch_includes || []).includes("main"));
  if (!prod) throw new Error("no production trigger for main after connecting");
  const started = Date.now();
  await cf(`${A}/builds/triggers/${prod.trigger_uuid}/builds`, { method: "POST", token: bt, body: { branch: "main" } });
  let last = "";
  const b = await waitForBuild({ A, tag, branch: "main", onWait: (s) => s !== last && log("build", (last = s)) });
  if (Date.parse(b.created_on || b.created_at || 0) < started - 60_000) warn("the finished build found may predate this run; check the Worker's deployments");
  if (b.build_outcome !== "success") throw new Error(`the build of main ended "${b.build_outcome}"`);
  return b;
}
async function check(url, expect) {
  const r = await fetch(url, { redirect: "manual" }).catch((e) => ({ status: `error ${e.message}` }));
  const ok = expect.includes(r.status);
  (ok ? done : warn)(`check ${url}`, `${r.status}${ok ? "" : ` (expected ${expect.join(" or ")})`}`);
  return ok;
}

// ---------------------------------------------------------------------------------------------------------------
const legacyUuid = await d1(adopt.legacyDb);
if (!legacyUuid) throw new Error(`the old database ${adopt.legacyDb} isn't in the account`);
const tag = await workerTag();
done("worker", `${adopt.worker} found; the site keeps its name, domains, secrets and Access applications`);

if (phase === "prepare") {
  const all = await cf(`${A}/d1/database?per_page=100`);
  const missing = [names.db, names.stagingDb].filter((n) => !all.some((d) => d.name === n));
  if (all.length + missing.length > 10) throw new Error(`The Free plan allows 10 D1 databases; the account has ${all.length} and adoption needs ${missing.length} more. Ask the owner which to remove (with a backup) or whether to upgrade.`);
  done("d1 budget", `${all.length} of 10 used; ${missing.length} to create`);
  if (DRY) {
    const r = await copyRows(legacyUuid, null);
    done("dry run", `${r.mapped.leads} lead(s) and ${r.mapped.subscribers} subscriber(s) map cleanly; ${await copyUploads(r.uploads)}`);
  } else {
    const prod = await d1(names.db, { create: true });
    const staging = await d1(names.stagingDb, { create: true });
    await applyMigrations(names.db, prod);
    await applyMigrations(names.stagingDb, staging);
    done("databases", `${names.db} and ${names.stagingDb} with core's migrations`);
    const r = await copyRows(legacyUuid, prod);
    done("rows", `${r.added.leads} of ${r.mapped.leads} lead(s) and ${r.added.subscribers} of ${r.mapped.subscribers} subscriber(s) added (the rest were already there); ${adopt.legacyDb} unchanged`);
    done("uploads", await copyUploads(r.uploads));
    const secrets = (await cf(`/accounts/${ACCOUNT}/workers/scripts/${adopt.worker}/secrets`)).map((s) => s.name);
    if (!secrets.includes("SIGNING_SECRET")) {
      const value = randomBytes(36).toString("base64url");
      runWrangler(["secret", "put", "SIGNING_SECRET", "--name", adopt.worker], { input: value });
      try {
        runWrangler(["preview", "base-config", "secret", "put", "SIGNING_SECRET"], { input: value });
      } catch (e) {
        warn(`Preview secret SIGNING_SECRET not set (${String(e.stderr || e.message).split("\n").find(Boolean)?.slice(0, 160)})`);
      }
      done("secrets", "SIGNING_SECRET added to the Worker and its previews");
    } else done("secrets", "SIGNING_SECRET already set");
    const missingSecrets = ["TURNSTILE_SECRET"].filter((s) => !secrets.includes(s));
    if (missingSecrets.length) warn(`The Worker has no ${missingSecrets.join(", ")}; forms will fail until it is set`);
    if (config.legacyUnsubSecret && !secrets.includes(config.legacyUnsubSecret)) warn(`legacyUnsubSecret names ${config.legacyUnsubSecret}, which the Worker doesn't have`);
    if (!adopt.legacyBuild) {
      adopt.legacyBuild = (await triggers(tag)).map(keepTrigger);
      writeFileSync(adoptPath, JSON.stringify(adopt, null, 2) + "\n");
      done("builds", `${adopt.legacyBuild.length} current trigger(s) recorded in adopt.json for a rollback`);
    }
    writeFileSync(wranglerPath, "// Framework B site adopted onto an existing Worker (scripts/site/adopt.mjs). Resource IDs are not secrets.\n" + JSON.stringify(adoptWrangler(wrangler, { worker: adopt.worker, db: prod, stagingDb: staging, id }), null, 2) + "\n");
    done("wrangler.jsonc", `Worker ${adopt.worker}, DB ${names.db}, previews ${names.stagingDb}`);
  }
} else if (phase === "preview") {
  runWrangler(["--version"]);
  execFileSync("npm", ["run", "build"], { cwd: SITE, stdio: "inherit" });
  const out = DRY ? "" : runWrangler(["preview"]);
  const url = out.split("\n").map((l) => l.trim().match(/^Preview URL:\s*(https:\/\/\S+)/)?.[1]).find(Boolean);
  if (!DRY && !url) throw new Error(`wrangler preview printed no Preview URL:\n${out.slice(-800)}`);
  done("preview", url || "(dry run)");
  if (url && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
} else if (phase === "cutover") {
  const prod = await d1(names.db);
  if (!prod) throw new Error(`${names.db} doesn't exist; run prepare first`);
  if (!adopt.legacyBuild) throw new Error("adopt.json has no legacyBuild; run prepare first so a rollback is possible");
  const repoName = arg("repo", `site-${id}`);
  const before = await copyRows(legacyUuid, prod);
  done("rows before", `${before.added.leads} new lead(s), ${before.added.subscribers} new subscriber(s)`);
  if (!DRY) {
    await repoint(tag, repoName);
    done("builds", `Workers Builds now builds ${repoName} (main deploys production, other branches previews)`);
    await buildMain(tag);
    done("deploy", "main built and deployed");
    const after = await copyRows(legacyUuid, prod);
    done("rows after", `${after.added.leads} lead(s) and ${after.added.subscribers} subscriber(s) that reached ${adopt.legacyDb} during the switch`);
    const host = config.site.canonicalHost;
    await check(`https://${host}/`, [200]);
    await check(`https://${host}/go?src=adopt-check`, [302]);
    await check(`https://${host}/api/health`, [200]);
    await check(`https://${host}/admin`, [302, 401, 403]);
  }
} else if (phase === "rollback") {
  if (!adopt.legacyRepo || !adopt.legacyBuild) throw new Error('adopt.json needs "legacyRepo" (the old repo\'s name) and "legacyBuild" (written by prepare)');
  if (!DRY) {
    await repoint(tag, adopt.legacyRepo, adopt.legacyBuild);
    done("builds", `Workers Builds builds ${adopt.legacyRepo} again`);
    await buildMain(tag);
    done("deploy", `${adopt.legacyRepo} main built and deployed; leads that reached ${names.db} meanwhile are still there`);
  }
}

const report = `## Adopt ${id}: ${phase}${DRY ? " (dry run)" : ""}\n\n${lines.join("\n")}\n${warnings.length ? `\n### Warnings\n\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : ""}`;
if (REPORT) writeFileSync(REPORT, report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
console.log(`\n${report}`);
