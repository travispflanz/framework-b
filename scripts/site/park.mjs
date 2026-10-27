#!/usr/bin/env node
// Takes a Worker off its domain without deleting anything, so the domain can be used for something else (for
// example a promote test) and the site put back exactly as it was. Works for any Worker, Framework B or not.
// Take a snapshot first (scripts/site/snapshot.mjs).
//
//   node scripts/site/park.mjs --worker <name> --zone <domain> --record park.json          park
//   node scripts/site/park.mjs --worker <name> --zone <domain> --record park.json --undo   put it back
// --record can be r2:<bucket>/<key> to keep the record in R2 (the ops workflow does).
//
// Parking:
//   1. pauses the UptimeRobot monitors on the zone (with UPTIMEROBOT_API_KEY), so they don't page anyone;
//   2. points the Worker's Workers Builds production trigger at a branch that doesn't exist (with CF_BUILDS_TOKEN),
//      so a push to main can't redeploy the Worker onto the domain again;
//   3. detaches the Worker's custom domains on the zone;
//   4. moves each Access application on the zone's hostnames to a parked path (<host>/_parked<path>), so a new
//      application can protect the same path; the application, its policies and its AUD stay as they are.
// The Worker, its code, secrets, cron, databases, buckets, Turnstile widget, DNS, Email Routing and rulesets are not
// touched. Everything changed is written to the record; --undo reverses exactly that, in the opposite order.
// Inputs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_BUILDS_TOKEN (optional), UPTIMEROBOT_API_KEY (optional).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync as writeLocal } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cf, env, log } from "./lib/api.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const WORKER = arg("worker");
const ZONE = arg("zone");
// The record is a local file, or r2:<bucket>/<key> (the ops workflow keeps it in the private backups bucket).
const RECORD_ARG = arg("record");
const R2_RECORD = RECORD_ARG?.startsWith("r2:") ? RECORD_ARG.slice(3) : null;
const RECORD = R2_RECORD ? join(mkdtempSync(join(tmpdir(), "park-")), "park.json") : RECORD_ARG;
const wrangler = (...a) => execFileSync("npx", ["--yes", "wrangler@4.152.0", "r2", "object", ...a, "--remote"], { stdio: ["ignore", "ignore", "pipe"] });
if (R2_RECORD) {
  try {
    wrangler("get", R2_RECORD, "--file", RECORD);
  } catch {}
}
const writeFileSync = (file, text) => {
  writeLocal(file, text);
  if (R2_RECORD) wrangler("put", R2_RECORD, "--file", file, "--content-type", "application/json");
};
const UNDO = process.argv.includes("--undo");
if (!WORKER || !ZONE || !RECORD_ARG) throw new Error("usage: park.mjs --worker <name> --zone <domain> --record <file> [--undo]");
const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const BUILDS = process.env.CF_BUILDS_TOKEN;
const UR = process.env.UPTIMEROBOT_API_KEY;
const PARKED_BRANCH = "parked-do-not-create";

// UptimeRobot v2 editMonitor: status 0 pauses, 1 resumes (https://uptimerobot.com/api/, legacy v2 API).
async function monitorStatus(id, status) {
  const res = await fetch("https://api.uptimerobot.com/v2/editMonitor", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ api_key: UR, id: String(id), status: String(status), format: "json" }) });
  const json = await res.json().catch(() => null);
  if (json?.stat !== "ok") throw new Error(`UptimeRobot editMonitor ${id}: ${JSON.stringify(json?.error || res.status)}`);
}
const parkedPath = (uri) => uri.replace(/^([^/]+)(\/.*)?$/, (_, host, path = "") => `${host}/_parked${path}`);
const onZone = (h) => h === ZONE || String(h).endsWith(`.${ZONE}`) || String(h).split("/")[0] === ZONE || String(h).split("/")[0].endsWith(`.${ZONE}`);
const accessFields = (app) => ({ domain: app.domain, self_hosted_domains: app.self_hosted_domains, destinations: app.destinations });
// The Access PUT body: the application's own settings and its policies by id and precedence, which keeps its
// policies and audience tag (the shape scripts/site/lib/access-agent.mjs uses, checked 2026-10-23).
const SETTINGS = ["type", "name", "domain", "self_hosted_domains", "destinations", "session_duration", "allowed_idps", "auto_redirect_to_identity", "app_launcher_visible", "enable_binding_cookie", "http_only_cookie_attribute", "same_site_cookie_attribute", "skip_interstitial", "options_preflight_bypass", "service_auth_401_redirect", "custom_deny_url", "custom_deny_message", "logo_url", "tags"];
const accessBody = (app, override = {}) => {
  const body = {};
  for (const k of SETTINGS) if (app[k] !== undefined && app[k] !== null) body[k] = app[k];
  body.policies = (app.policies || []).map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 }));
  return { ...body, ...override };
};

if (!UNDO) {
  if (existsSync(RECORD) && !JSON.parse(readFileSync(RECORD, "utf8")).restoredAt) throw new Error(`${RECORD_ARG} exists: this Worker is already parked. Undo first, or use another record.`);
  const record = { worker: WORKER, zone: ZONE, parkedAt: new Date().toISOString(), monitors: [], builds: [], domains: [], access: [] };
  const save = () => writeFileSync(RECORD, JSON.stringify(record, null, 2) + "\n");
  save();

  if (UR) {
    const res = await fetch("https://api.uptimerobot.com/v2/getMonitors", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ api_key: UR, format: "json" }) });
    for (const m of ((await res.json()).monitors || []).filter((m) => onZone(new URL(m.url).host) && m.status !== 0)) {
      await monitorStatus(m.id, 0);
      record.monitors.push({ id: m.id, name: m.friendly_name, url: m.url });
      save();
    }
    log("monitors", `${record.monitors.length} paused`);
  }

  const script = (await cf(`${A}/workers/scripts`)).find((s) => s.id === WORKER);
  if (!script) throw new Error(`No Worker named ${WORKER}`);
  if (BUILDS && script.tag) {
    for (const t of (await cf(`${A}/builds/workers/${script.tag}/triggers`, { token: BUILDS })) || []) {
      if (/wrangler (deploy|versions upload)\b/.test(t.deploy_command) && !t.deploy_command.includes("preview")) {
        await cf(`${A}/builds/triggers/${t.trigger_uuid}`, { method: "PATCH", body: { branch_includes: [PARKED_BRANCH] }, token: BUILDS });
        record.builds.push({ trigger_uuid: t.trigger_uuid, name: t.trigger_name, branch_includes: t.branch_includes });
        save();
      }
    }
    log("builds", `${record.builds.length} production trigger(s) pointed at ${PARKED_BRANCH}`);
  } else log("builds", "skipped (no CF_BUILDS_TOKEN, or no Builds connection)");

  for (const d of (await cf(`${A}/workers/domains?service=${encodeURIComponent(WORKER)}`)) || []) {
    if (!onZone(d.hostname)) continue;
    await cf(`${A}/workers/domains/${d.id}`, { method: "DELETE" });
    record.domains.push({ hostname: d.hostname, service: d.service, zone_id: d.zone_id, environment: d.environment });
    save();
  }
  log("domains", `${record.domains.map((d) => d.hostname).join(", ") || "none"} detached`);

  for (const app of (await cf(`${A}/access/apps`)) || []) {
    const fields = accessFields(app);
    if (!(fields.domain && onZone(fields.domain))) continue;
    const full = await cf(`${A}/access/apps/${app.id}`);
    const next = accessBody(full, {
      domain: parkedPath(fields.domain),
      ...(fields.self_hosted_domains ? { self_hosted_domains: fields.self_hosted_domains.map(parkedPath) } : {}),
      ...(fields.destinations ? { destinations: fields.destinations.map((d) => (d.uri ? { ...d, uri: parkedPath(d.uri) } : d)) } : {}),
    });
    await cf(`${A}/access/apps/${app.id}`, { method: "PUT", body: next });
    const after = await cf(`${A}/access/apps/${app.id}`);
    if (after.aud !== full.aud) throw new Error(`Access application ${app.name}: its audience tag changed; restore it from the snapshot`);
    record.access.push({ id: app.id, name: app.name, aud: full.aud, before: fields, app: full });
    save();
  }
  log("access", `${record.access.length} application(s) moved to a /_parked path`);
  console.log(`Parked. To put it back: node scripts/site/park.mjs --worker ${WORKER} --zone ${ZONE} --record ${RECORD} --undo`);
} else {
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  for (const a of record.access) {
    const app = await cf(`${A}/access/apps/${a.id}`);
    await cf(`${A}/access/apps/${a.id}`, { method: "PUT", body: accessBody({ ...a.app, policies: app.policies }, a.before) });
  }
  log("access", `${record.access.length} application(s) restored`);
  for (const d of record.domains) {
    await cf(`${A}/workers/domains`, { method: "PUT", body: { hostname: d.hostname, service: d.service, zone_id: d.zone_id, ...(d.environment ? { environment: d.environment } : {}) } });
  }
  log("domains", `${record.domains.map((d) => d.hostname).join(", ") || "none"} attached to ${WORKER}`);
  if (record.builds.length && !BUILDS) throw new Error("CF_BUILDS_TOKEN is needed to restore the Builds triggers");
  for (const t of record.builds) await cf(`${A}/builds/triggers/${t.trigger_uuid}`, { method: "PATCH", body: { branch_includes: t.branch_includes }, token: BUILDS });
  log("builds", `${record.builds.length} trigger(s) restored`);
  if (record.monitors.length && !UR) throw new Error("UPTIMEROBOT_API_KEY is needed to resume the monitors");
  for (const m of record.monitors) await monitorStatus(m.id, 1);
  log("monitors", `${record.monitors.length} resumed`);
  writeFileSync(RECORD, JSON.stringify({ ...record, restoredAt: new Date().toISOString() }, null, 2) + "\n");
  console.log("Restored.");
}
