#!/usr/bin/env node
// A complete, read-only snapshot of one Worker and its zone, so a site can be put back exactly as it was. It changes
// nothing in Cloudflare. Works for any Worker, Framework B or not.
//
//   node scripts/site/snapshot.mjs --worker <name> --zone <domain> --out <dir> [--repo <git checkout>] [--upload <bucket>/<prefix>]
//
// Writes to <dir>:
//   snapshot.json    the Worker (settings and bindings, cron schedules, secret names, workers.dev and preview
//                    settings, custom domains, routes, deployments, versions, Workers Builds triggers), the zone
//                    (settings, DNS records, rulesets with their rules, page rules, Email Routing settings, rules
//                    and catch-all), the account's Email Routing destinations, the Access applications and their
//                    policies on the zone's hostnames, the Turnstile widgets that list them (no secrets), every
//                    D1 database and R2 bucket the Worker binds (production and previews), and UptimeRobot monitors
//                    on the zone (with UPTIMEROBOT_API_KEY)
//   dns.bind         the zone's DNS records in BIND format
//   worker/script    the deployed Worker code as Cloudflare returns it (multipart)
//   d1/<name>.sql    each bound D1 database, exported with `wrangler d1 export` (schema and data)
//   r2/<bucket>/...  every object in each bound R2 bucket
//   repo.bundle      the site's git repository, every branch and tag (with --repo)
// Secret values can't be read back from Cloudflare; snapshot.json lists their names. D1 exports and R2 objects can
// hold personal data, so --upload sends the whole folder to a private R2 bucket; keep snapshot.json in the private
// ops repo and never commit the data files anywhere. Inputs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cf, env, log } from "./lib/api.mjs";
import { stripJsonc } from "../../starter/scripts/lib/jsonc.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const WORKER = arg("worker");
const ZONE = arg("zone");
const OUT = resolve(arg("out") || "snapshot");
const REPO = arg("repo");
const UPLOAD = arg("upload");
if (!WORKER || !ZONE) throw new Error("usage: snapshot.mjs --worker <name> --zone <domain> --out <dir> [--repo <dir>] [--upload <bucket>/<prefix>]");
const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const WRANGLER = ["--yes", "wrangler@4.152.0"];
mkdirSync(OUT, { recursive: true });

// A read that may legitimately be empty or unavailable on this plan is recorded as such, not fatal.
const soft = async (path) => {
  try {
    return await cf(path);
  } catch (e) {
    return { unavailable: e.message };
  }
};
const raw = async (path) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}` } });
  if (!res.ok) throw new Error(`GET ${path.replace(/\/accounts\/[0-9a-f]{32}/, "/accounts/…")}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const hostMatches = (h) => h === ZONE || String(h).endsWith(`.${ZONE}`) || String(h).startsWith(`${ZONE}/`) || String(h).includes(`.${ZONE}/`);

const snap = { takenAt: new Date().toISOString(), worker: { name: WORKER }, zone: { name: ZONE } };

// ---------- Worker ----------
const script = (await cf(`${A}/workers/scripts`)).find((s) => s.id === WORKER);
if (!script) throw new Error(`No Worker named ${WORKER}`);
snap.worker.script = script;
snap.worker.settings = await cf(`${A}/workers/scripts/${WORKER}/settings`);
snap.worker.schedules = await soft(`${A}/workers/scripts/${WORKER}/schedules`);
snap.worker.secretNames = ((await soft(`${A}/workers/scripts/${WORKER}/secrets`)) || []).map?.((s) => s.name) ?? [];
snap.worker.subdomain = await soft(`${A}/workers/scripts/${WORKER}/subdomain`);
snap.worker.deployments = await soft(`${A}/workers/scripts/${WORKER}/deployments`);
snap.worker.versions = await soft(`${A}/workers/scripts/${WORKER}/versions`);
snap.worker.customDomains = (await cf(`${A}/workers/domains?service=${encodeURIComponent(WORKER)}`)) || [];
snap.worker.buildsTriggers = script.tag ? await soft(`${A}/builds/workers/${script.tag}/triggers`) : [];
mkdirSync(join(OUT, "worker"), { recursive: true });
writeFileSync(join(OUT, "worker/script"), await raw(`${A}/workers/scripts/${WORKER}`));
log("worker", `${snap.worker.customDomains.length} custom domain(s), ${snap.worker.secretNames.length} secret name(s), code saved`);

// ---------- Zone ----------
const zone = (await cf(`/zones?name=${encodeURIComponent(ZONE)}`))[0];
if (!zone) throw new Error(`No zone ${ZONE} in this account`);
const Z = `/zones/${zone.id}`;
snap.zone.details = zone;
snap.zone.settings = await cf(`${Z}/settings`);
snap.zone.dns = await cf(`${Z}/dns_records?per_page=5000`);
writeFileSync(join(OUT, "dns.bind"), await raw(`${Z}/dns_records/export`));
snap.zone.workerRoutes = await soft(`${Z}/workers/routes`);
snap.zone.pageRules = await soft(`${Z}/pagerules`);
const rulesets = (await soft(`${Z}/rulesets`)) || [];
snap.zone.rulesets = [];
for (const r of Array.isArray(rulesets) ? rulesets : []) snap.zone.rulesets.push(r.kind === "zone" ? await cf(`${Z}/rulesets/${r.id}`) : r);
snap.zone.emailRouting = {
  settings: await soft(`${Z}/email/routing`),
  dns: await soft(`${Z}/email/routing/dns`),
  rules: await soft(`${Z}/email/routing/rules`),
  catchAll: await soft(`${Z}/email/routing/rules/catch_all`),
};
snap.emailDestinations = await soft(`${A}/email/routing/addresses`);
log("zone", `${snap.zone.dns.length} DNS records, ${snap.zone.rulesets.length} rulesets, Email Routing ${snap.zone.emailRouting.settings?.enabled ? "on" : "off"}`);

// ---------- Access and Turnstile ----------
const apps = (await soft(`${A}/access/apps`)) || [];
snap.access = [];
for (const app of Array.isArray(apps) ? apps : []) {
  const hosts = [app.domain, ...(app.self_hosted_domains || []), ...(app.destinations || []).map((d) => d.uri)].filter(Boolean);
  if (!hosts.some(hostMatches)) continue;
  snap.access.push({ app, policies: await soft(`${A}/access/apps/${app.id}/policies`) });
}
const widgets = (await soft(`${A}/challenges/widgets`)) || [];
snap.turnstile = (Array.isArray(widgets) ? widgets : []).filter((w) => (w.domains || []).some(hostMatches)).map(({ secret, ...w }) => w);
log("access", `${snap.access.length} Access app(s), ${snap.turnstile.length} Turnstile widget(s)`);

// ---------- Data: D1 and R2 the Worker binds (production and previews) ----------
const bindings = [...(snap.worker.settings.bindings || [])];
// Preview bindings have no documented read API (Previews Base lives in the Wrangler file, checked 2026-10-27:
// https://developers.cloudflare.com/workers/previews/configuration/), so they come from the repo's wrangler.jsonc.
const previewBindings = [];
const wranglerFile = REPO && ["wrangler.jsonc", "wrangler.json"].map((f) => join(REPO, f)).find(existsSync);
const dbList = await cf(`${A}/d1/database?per_page=100`);
if (wranglerFile) {
  const p = JSON.parse(stripJsonc(readFileSync(wranglerFile, "utf8"))).previews || {};
  for (const d of p.d1_databases || []) previewBindings.push({ type: "d1", name: d.binding, id: d.database_id || dbList.find((x) => x.name === d.database_name)?.uuid });
  for (const b of p.r2_buckets || []) previewBindings.push({ type: "r2_bucket", name: b.binding, bucket_name: b.bucket_name });
  snap.worker.previewsFromRepo = p;
}
const d1 = [...new Map([...bindings, ...previewBindings].filter((b) => b.type === "d1").map((b) => [b.id || b.database_id, b])).values()];
const r2 = [...new Set([...bindings, ...previewBindings].filter((b) => b.type === "r2_bucket").map((b) => b.bucket_name))];
const dbs = dbList;
snap.d1 = [];
const work = mkdtempSync(join(tmpdir(), "snapshot-"));
try {
  for (const b of d1) {
    const db = dbs.find((d) => d.uuid === (b.id || b.database_id));
    if (!db) continue;
    writeFileSync(join(work, "wrangler.json"), JSON.stringify({ name: "snapshot", compatibility_date: "2026-10-01", d1_databases: [{ binding: "DB", database_name: db.name, database_id: db.uuid }] }));
    mkdirSync(join(OUT, "d1"), { recursive: true });
    execFileSync("npx", [...WRANGLER, "d1", "export", db.name, "--remote", "--output", join(OUT, "d1", `${db.name}.sql`)], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    snap.d1.push({ binding: b.name, name: db.name, uuid: db.uuid, file: `d1/${db.name}.sql`, bytes: statSync(join(OUT, "d1", `${db.name}.sql`)).size });
  }
  snap.r2 = [];
  for (const bucket of r2) {
    const objects = [];
    let cursor;
    do {
      const page = await fetch(`https://api.cloudflare.com/client/v4${A}/r2/buckets/${bucket}/objects?per_page=1000${cursor ? `&cursor=${cursor}` : ""}`, { headers: { authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}` } }).then((r) => r.json());
      objects.push(...(page.result || []));
      cursor = page.result_info?.is_truncated ? page.result_info.cursor : undefined;
    } while (cursor);
    for (const o of objects) {
      const dest = join(OUT, "r2", bucket, o.key);
      mkdirSync(dirname(dest), { recursive: true });
      execFileSync("npx", [...WRANGLER, "r2", "object", "get", `${bucket}/${o.key}`, "--remote", "--file", dest], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    }
    snap.r2.push({ bucket, objects: objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, last_modified: o.last_modified, http_metadata: o.http_metadata, custom_metadata: o.custom_metadata })) });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
log("data", `${snap.d1.length} D1 database(s), ${snap.r2.reduce((n, b) => n + b.objects.length, 0)} R2 object(s) in ${snap.r2.length} bucket(s)`);

// ---------- Uptime monitors ----------
if (process.env.UPTIMEROBOT_API_KEY) {
  const res = await fetch(`https://api.uptimerobot.com/v3/monitors?url=${encodeURIComponent(ZONE)}`, { headers: { authorization: `Bearer ${process.env.UPTIMEROBOT_API_KEY}` } });
  snap.uptime = res.ok ? ((await res.json()).data || []).filter((m) => hostMatches(new URL(m.url).host)) : { unavailable: `HTTP ${res.status}` };
}

// ---------- Repository ----------
if (REPO) {
  execFileSync("git", ["-C", REPO, "fetch", "-q", "--all", "--tags"]);
  execFileSync("git", ["-C", REPO, "bundle", "create", join(OUT, "repo.bundle"), "--all"], { stdio: ["ignore", "ignore", "pipe"] });
  snap.repo = { head: execFileSync("git", ["-C", REPO, "ls-remote", "origin", "HEAD"], { encoding: "utf8" }).split(/\s/)[0], remote: execFileSync("git", ["-C", REPO, "remote", "get-url", "origin"], { encoding: "utf8" }).trim().replace(/\/\/[^@]+@/, "//"), bundle: "repo.bundle" };
}

writeFileSync(join(OUT, "snapshot.json"), JSON.stringify(snap, null, 2) + "\n");
log("snapshot", OUT);

// ---------- Upload ----------
if (UPLOAD) {
  const [bucket, ...rest] = UPLOAD.split("/");
  const prefix = rest.join("/").replace(/\/$/, "");
  const files = [];
  const walk = (d) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name))));
  walk(OUT);
  for (const f of files) execFileSync("npx", [...WRANGLER, "r2", "object", "put", `${bucket}/${prefix}/${relative(OUT, f)}`, "--remote", "--file", f], { stdio: ["ignore", "ignore", "pipe"] });
  log("upload", `${files.length} file(s) to ${bucket}/${prefix}/`);
}
