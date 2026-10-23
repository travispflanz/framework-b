#!/usr/bin/env node
// Removes an idea-mode site and frees its resources. Exports its leads and subscribers to the
// framework-backups bucket first, then deletes them.
//
// Deleting leads needs the owner's approval, so this refuses unless either:
//   - SITE_ID starts with "selftest-" (throwaway sites made by the template self-test), or
//   - CONFIRM is exactly "delete <SITE_ID>".
// The GitHub repo is archived, not deleted, unless DELETE_REPO is "yes".
//
// Inputs (environment): SITE_ID, CONFIRM, DELETE_REPO, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID,
// CF_BUILDS_TOKEN, GH_SITES_TOKEN.
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cf, gh, env, log } from "./lib/api.mjs";

// R2 objects go through Wrangler, the documented interface (same version the starter pins).
const r2 = (...args) => execFileSync("npx", ["--yes", "wrangler@4.152.0", "r2", "object", ...args, "--remote"], { stdio: ["ignore", "ignore", "pipe"] });
const scratch = mkdtempSync(join(tmpdir(), "teardown-"));

const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const id = env("SITE_ID").trim().toLowerCase();
const confirmed = id.startsWith("selftest-") || process.env.CONFIRM === `delete ${id}`;
if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(id)) throw new Error("bad SITE_ID");
if (!confirmed) throw new Error(`Refusing: set CONFIRM to "delete ${id}" (the owner's approval to delete this site's leads)`);
const SHARED = { db: "fb-ideas", previewDb: "fb-previews", uploads: "fb-ideas-uploads", previewUploads: "fb-previews", backups: "framework-backups" };
const report = [];
const did = (s) => {
  report.push(s);
  log(s);
};

async function dbUuid(name) {
  return (await cf(`${A}/d1/database?name=${encodeURIComponent(name)}`)).find((d) => d.name === name)?.uuid;
}
async function query(uuid, sql, params = []) {
  return (await cf(`${A}/d1/database/${uuid}/query`, { method: "POST", body: { sql, params } }))[0]?.results || [];
}

// 1. Export, then delete, this site's rows and uploaded files (production and previews).
for (const [dbName, bucket] of [[SHARED.db, SHARED.uploads], [SHARED.previewDb, SHARED.previewUploads]]) {
  const uuid = await dbUuid(dbName);
  if (!uuid) continue;
  const leads = await query(uuid, "SELECT * FROM leads WHERE site = ?", [id]);
  const subscribers = await query(uuid, "SELECT * FROM subscribers WHERE site = ?", [id]);
  if (leads.length || subscribers.length) {
    const key = `teardown/${id}/${dbName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const file = join(scratch, "export.json");
    writeFileSync(file, JSON.stringify({ site: id, exportedAt: new Date().toISOString(), leads, subscribers }));
    try {
      r2("put", `${SHARED.backups}/${key}`, "--file", file, "--content-type", "application/json");
    } catch (e) {
      throw new Error(`export to R2 failed; nothing was deleted (${String(e.stderr || e.message).slice(0, 300)})`);
    }
    did(`exported ${leads.length} leads and ${subscribers.length} subscribers from ${dbName} to ${SHARED.backups}/${key}`);
  }
  for (const l of leads.filter((l) => l.upload_key)) {
    try {
      r2("delete", `${bucket}/${l.upload_key}`);
    } catch (e) {
      did(`file ${l.upload_key} not deleted: ${String(e.stderr || e.message).slice(0, 200)}`);
    }
  }
  await query(uuid, "DELETE FROM leads WHERE site = ?", [id]);
  await query(uuid, "DELETE FROM subscribers WHERE site = ?", [id]);
  did(`deleted ${id} rows and files in ${dbName}`);
}

// 2. Workers Builds triggers.
const scripts = await cf(`${A}/workers/scripts`);
const tag = scripts.find((s) => s.id === id)?.tag;
if (tag) {
  try {
    const bt = env("CF_BUILDS_TOKEN");
    const triggers = (await cf(`${A}/builds/workers/${tag}/triggers`, { token: bt })) || [];
    for (const t of triggers) await cf(`${A}/builds/triggers/${t.trigger_uuid}`, { method: "DELETE", token: bt });
    did(`removed ${triggers.length} Workers Builds trigger(s)`);
  } catch (e) {
    did(`Workers Builds triggers not removed: ${e.message}`);
  }
}

// 3. Access applications.
for (const app of (await cf(`${A}/access/apps`)).filter((a) => a.name === `${id} admin` || a.name === `${id} previews`)) {
  await cf(`${A}/access/apps/${app.id}`, { method: "DELETE" });
  did(`deleted Access application "${app.name}"`);
}

// 4. Turnstile widget (self-test sites use test keys and have none).
for (const w of (await cf(`${A}/challenges/widgets`)).filter((w) => w.name === id)) {
  await cf(`${A}/challenges/widgets/${w.sitekey}`, { method: "DELETE" });
  did("deleted Turnstile widget");
}

// 5. The Worker.
if (tag) {
  await cf(`${A}/workers/scripts/${id}?force=true`, { method: "DELETE" });
  did(`deleted Worker ${id}`);
}

// 6. The GitHub repo: archived unless deletion was asked for.
const user = await gh("/user");
const repoPath = `/repos/${user.login}/site-${id}`;
if (await gh(repoPath, { allow404: true })) {
  if (process.env.DELETE_REPO === "yes") {
    await gh(repoPath, { method: "DELETE" });
    did(`deleted repo site-${id}`);
  } else {
    await gh(repoPath, { method: "PATCH", body: { archived: true } });
    did(`archived repo site-${id}`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Teardown: ${id}\n\n${report.map((r) => `- ${r}`).join("\n")}\n`);
console.log(`\nTeardown of ${id} complete.`);
