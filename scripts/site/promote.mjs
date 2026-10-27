#!/usr/bin/env node
// Moves an idea-mode site to launch mode on its own domain (docs/SPEC.md section 2, "promote"). Runs in the owner's
// private ops repo; production only changes when the owner merges the pull request this prepares.
//
//   node scripts/site/promote.mjs --site <site checkout> --domain <example.com> [--phase prepare|finish]
//                                 [--dry-run] [--report <file.md>]
//
// Phase "prepare" (default), before the pull request:
//   1. Checks: the site is in idea mode; the domain is an active zone in this account (apex only); the owner's
//      inbox is a verified Email Routing destination; the Free plan's D1 budget has room for two more databases.
//   2. Zone: Always Use HTTPS and TLS 1.2 minimum; Email Routing on (so the Worker can send owner notifications
//      from notify@<domain> to the verified inbox, which is free: developers.cloudflare.com/email-service/,
//      checked 2026-10-27); a proxied www record and the www → apex Single Redirect.
//   3. Data: the site's own D1 databases (<id>-prod, <id>-staging) with migrations; its leads and subscribers are
//      copied from the shared idea database (INSERT OR IGNORE, so a rerun only adds what is new); its own R2
//      bucket (<id>-uploads) with every uploaded file the leads point at. The shared rows are left in place:
//      deleting them needs the owner's approval.
//   4. Mail: with RESEND_ADMIN_KEY (the owner's full-access Resend key, an ops secret), Resend on mail.<domain>: the
//      domain, its DNS records, verification, and a sending-only key restricted to it, stored as the Worker
//      secret RESEND_API_KEY. Without it, lead auto-replies stay off.
//   5. Access and Turnstile: /admin (and /_emdash with editing on) behind the same Access applications on the
//      domain; the domain added to the site's Turnstile widget.
//   6. The domain attached to the Worker as a Custom Domain (Workers Routes needs the deploy token; the Builds
//      token can then deploy without touching it: developers.cloudflare.com/workers/authorization/workers/).
//   7. The site's files: site.config.json and wrangler.jsonc in launch mode, DECISIONS.md and HANDOFF.md.
//      The caller commits them on a branch and opens the pull request.
// Phase "finish", after the owner merges and Workers Builds deploys:
//   copies anything that reached the shared database in between, moves the uptime monitors to the domain, and
//   checks the domain, the www redirect, /admin and the noindex twin.
//
// Inputs (environment): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, POSTAL_ADDRESS (required for prepare,
// CAN-SPAM), RESEND_ADMIN_KEY (optional), UPTIMEROBOT_API_KEY (optional, finish).
// Status: untested end to end until the first promote on a real domain (docs/ROADMAP.md step 9).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, env, log } from "./lib/api.mjs";
import { addMonitors, removeMonitors, uptimeEnabled } from "./lib/uptime.mjs";
import { DOMAIN_RE, launchConfig, launchNames, launchWrangler, mailAddresses, mergeRedirectRules, ownerChecklist, redirectRule, resendRecordName } from "./lib/promote.mjs";

const FRAMEWORK = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const { stripJsonc } = await import(join(FRAMEWORK, "starter/scripts/lib/jsonc.mjs"));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = resolve(arg("site", "."));
const domain = String(arg("domain", "")).trim().toLowerCase().replace(/\.$/, "");
const phase = arg("phase", "prepare");
const DRY = process.argv.includes("--dry-run");
const REPORT = arg("report", "");
if (!DOMAIN_RE.test(domain)) throw new Error('--domain must be a domain name, for example "example.com"');
if (!["prepare", "finish"].includes(phase)) throw new Error('--phase must be "prepare" or "finish"');

const ACCOUNT = env("CLOUDFLARE_ACCOUNT_ID");
const A = `/accounts/${ACCOUNT}`;
const configPath = join(SITE, "site.config.json");
const wranglerPath = join(SITE, "wrangler.jsonc");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const wrangler = JSON.parse(stripJsonc(readFileSync(wranglerPath, "utf8")));
const id = config.site.id;
const owner = config.site.ownerEmail;
const names = launchNames(id);
const mail = mailAddresses(domain);
const SHARED_DB = "fb-ideas";
const SHARED_UPLOADS = "fb-ideas-uploads";
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
const today = new Date().toISOString().slice(0, 10);
const wranglerBin = () => (existsSync(join(SITE, "node_modules/.bin/wrangler")) ? join(SITE, "node_modules/.bin/wrangler") : "wrangler");
const runWrangler = (args, opts = {}) => execFileSync(wranglerBin(), args, { cwd: SITE, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, CI: "1" }, ...opts });

async function zone() {
  const z = (await cf(`/zones?name=${encodeURIComponent(domain)}&account.id=${ACCOUNT}`))?.[0];
  if (!z) throw new Error(`${domain} is not a zone in this Cloudflare account. Add it (or buy it through Cloudflare Registrar) first.`);
  if (z.status !== "active") throw new Error(`${domain} is "${z.status}" in Cloudflare, not active yet: its nameservers must point at Cloudflare first.`);
  return z;
}
async function d1(name, { create = false } = {}) {
  const found = (await cf(`${A}/d1/database?name=${encodeURIComponent(name)}`)).find((d) => d.name === name);
  if (found || !create) return found?.uuid || null;
  return (await cf(`${A}/d1/database`, { method: "POST", body: { name } })).uuid;
}
async function query(uuid, sql, params = []) {
  return (await cf(`${A}/d1/database/${uuid}/query`, { method: "POST", body: { sql, params } }))[0]?.results || [];
}

// Copies this site's rows from the shared idea database. INSERT OR IGNORE keeps rows already copied as they are.
async function copyRows(fromUuid, toUuid) {
  let leads = 0;
  let subs = 0;
  for (const row of await query(fromUuid, "SELECT * FROM leads WHERE site = ? ORDER BY created_at", [id])) {
    const cols = Object.keys(row);
    const r = await cf(`${A}/d1/database/${toUuid}/query`, {
      method: "POST",
      body: { sql: `INSERT OR IGNORE INTO leads (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => row[c]) },
    });
    leads += r[0]?.meta?.changes || 0;
  }
  for (const row of await query(fromUuid, "SELECT * FROM subscribers WHERE site = ?", [id])) {
    const cols = Object.keys(row);
    const r = await cf(`${A}/d1/database/${toUuid}/query`, {
      method: "POST",
      body: { sql: `INSERT OR IGNORE INTO subscribers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => row[c]) },
    });
    subs += r[0]?.meta?.changes || 0;
  }
  const [{ n: total }] = await query(toUuid, "SELECT count(*) AS n FROM leads WHERE site = ?", [id]);
  const [{ n: shared }] = await query(fromUuid, "SELECT count(*) AS n FROM leads WHERE site = ?", [id]);
  if (total < shared) throw new Error(`Copied leads don't add up: ${total} in ${names.db}, ${shared} in ${SHARED_DB}`);
  return { leads, subs, total };
}

// Copies every stored upload the leads point at (the objects keep their keys, so the rows stay valid).
async function copyUploads(dbUuid) {
  const keys = (await query(dbUuid, "SELECT upload_key FROM leads WHERE site = ? AND upload_status = 'stored' AND upload_key IS NOT NULL", [id])).map((r) => r.upload_key);
  const scratch = mkdtempSync(join(tmpdir(), "promote-"));
  let copied = 0;
  try {
    for (const key of keys) {
      const file = join(scratch, "object");
      runWrangler(["r2", "object", "get", `${SHARED_UPLOADS}/${key}`, "--file", file, "--remote"]);
      runWrangler(["r2", "object", "put", `${names.uploads}/${key}`, "--file", file, "--remote"]);
      rmSync(file, { force: true });
      copied++;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { copied, of: keys.length };
}

async function applyMigrations(dbName, uuid) {
  const tmp = mkdtempSync(join(tmpdir(), "promote-db-"));
  const cfg = join(tmp, "wrangler.json");
  writeFileSync(cfg, JSON.stringify({ name: `${id}-promote-migrate`, compatibility_date: "2026-10-01", d1_databases: [{ binding: "DB", database_name: dbName, database_id: uuid, migrations_dir: join(SITE, "core/migrations") }] }));
  try {
    runWrangler(["d1", "migrations", "apply", dbName, "--remote", "--config", cfg]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Puts a hostname behind an existing Access application, keeping its policies and audience tag
// (same PUT shape as scripts/site/lib/access-agent.mjs, checked 2026-10-23).
async function addAccessDestination(appName, uri) {
  const app = ((await cf(`${A}/access/apps`)) || []).find((a) => a.name === appName);
  if (!app) return null;
  const destinations = app.destinations?.length ? app.destinations : [{ type: "public", uri: app.domain }];
  if (destinations.some((d) => d.uri === uri)) return false;
  await cf(`${A}/access/apps/${app.id}`, {
    method: "PUT",
    body: {
      type: app.type,
      name: app.name,
      domain: app.domain,
      destinations: [...destinations, { type: "public", uri }],
      session_duration: app.session_duration,
      policies: (app.policies || []).map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 })),
    },
  });
  return true;
}

async function resend(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.RESEND_ADMIN_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Resend ${method} ${path}: HTTP ${res.status} ${json?.message || ""}`.trim());
  return json;
}

async function ensureDns(zoneId, record) {
  const existing = await cf(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`);
  const same = existing.find((r) => r.content.replace(/^"|"$/g, "") === String(record.content).replace(/^"|"$/g, ""));
  if (same) return false;
  await cf(`/zones/${zoneId}/dns_records`, { method: "POST", body: record });
  return true;
}

// ================================ prepare ================================
async function prepare() {
  if (config.site.mode !== "idea") throw new Error(`${id} is already in ${config.site.mode} mode`);
  const postal = env("POSTAL_ADDRESS", { required: !DRY });
  const z = await zone();
  if (z.name !== domain) throw new Error(`Promote takes the zone's apex domain (${z.name}); subdomains aren't supported yet`);
  const verified = ((await cf(`${A}/email/routing/addresses`)) || []).find((a) => a.email?.toLowerCase() === owner.toLowerCase());
  if (!verified?.verified) throw new Error(`The owner's inbox isn't a verified Email Routing destination yet (docs/ONE-TIME-SETUP.md step 9)`);
  const dbs = await cf(`${A}/d1/database?per_page=100`);
  const missing = [names.db, names.stagingDb].filter((n) => !dbs.some((d) => d.name === n)).length;
  if (dbs.length + missing > 10) throw new Error(`Promote needs ${missing} more D1 database(s); the account has ${dbs.length} of the Free plan's 10`);
  const sharedUuid = await d1(SHARED_DB);
  const [{ n: leadCount }] = await query(sharedUuid, "SELECT count(*) AS n FROM leads WHERE site = ?", [id]);
  done("checks", `${domain} is an active zone; owner inbox verified; D1 ${dbs.length}/10 in use (+${missing}); ${leadCount} lead(s) to copy`);
  const withResend = !!process.env.RESEND_ADMIN_KEY;
  if (DRY) {
    done("dry run", `would set up ${domain} for ${id}${withResend ? " with Resend on " + mail.resendDomain : " without lead auto-replies (no RESEND_ADMIN_KEY)"}`);
    return;
  }

  // Zone settings (Zone Settings: Edit).
  for (const [setting, value] of [["always_use_https", "on"], ["min_tls_version", "1.2"]]) {
    await cf(`/zones/${z.id}/settings/${setting}`, { method: "PATCH", body: { value } });
  }
  done("zone settings", "Always Use HTTPS on, minimum TLS 1.2");

  // Email Routing, which lets the send_email binding send from notify@<domain> to the verified inbox.
  const routing = await cf(`/zones/${z.id}/email/routing`);
  if (!routing?.enabled) {
    try {
      await cf(`/zones/${z.id}/email/routing/dns`, { method: "POST", body: { name: domain } });
      done("email routing", "enabled (MX, SPF and DKIM records added by Cloudflare)");
    } catch (e) {
      throw new Error(`Email Routing couldn't be turned on for ${domain} (${e.message}). If the domain already has MX records for another mail provider, the owner decides which one stays.`);
    }
  } else {
    done("email routing", "already on");
  }

  // www → apex: a proxied placeholder record (100:: is the documented originless address) and the redirect rule.
  const wwwAdded = await ensureDns(z.id, { type: "AAAA", name: `www.${domain}`, content: "100::", proxied: true, ttl: 1, comment: "Framework B: www redirects to the apex" });
  const entry = await cf(`/zones/${z.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { allow404: true });
  const rules = mergeRedirectRules(entry?.rules, redirectRule(domain));
  await cf(`/zones/${z.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, { method: "PUT", body: { rules } });
  done("www", `${wwwAdded ? "proxied record added; " : ""}301 to https://${domain} (Single Redirect)`);

  // Data.
  const prodUuid = await d1(names.db, { create: true });
  const stagingUuid = await d1(names.stagingDb, { create: true });
  await applyMigrations(names.db, prodUuid);
  await applyMigrations(names.stagingDb, stagingUuid);
  done("databases", `${names.db} and ${names.stagingDb}, migrations applied`);
  const copied = await copyRows(sharedUuid, prodUuid);
  done("leads", `${copied.leads} lead(s) and ${copied.subs} subscriber(s) copied; ${copied.total} lead(s) in ${names.db}. The rows in ${SHARED_DB} stay until the owner approves deleting them`);
  if (!(await cf(`${A}/r2/buckets/${names.uploads}`, { allow404: true }))) await cf(`${A}/r2/buckets`, { method: "POST", body: { name: names.uploads } });
  const files = await copyUploads(prodUuid);
  done("uploads", `bucket ${names.uploads}; ${files.copied} of ${files.of} file(s) copied`);

  // Resend for lead auto-replies.
  let resendOn = false;
  if (withResend) {
    try {
      const list = (await resend("/domains")).data || [];
      let dom = list.find((d) => d.name === mail.resendDomain);
      dom = dom ? await resend(`/domains/${dom.id}`) : await resend("/domains", { method: "POST", body: { name: mail.resendDomain } });
      for (const r of dom.records || []) {
        const name = resendRecordName(r.name, { zone: domain, sendingDomain: mail.resendDomain });
        await ensureDns(z.id, { type: r.type, name, content: r.value, ttl: 1, proxied: false, ...(r.priority !== undefined ? { priority: Number(r.priority) } : {}), comment: "Framework B: Resend" });
      }
      await resend(`/domains/${dom.id}/verify`, { method: "POST" });
      let status = "pending";
      for (let i = 0; i < 30 && status !== "verified"; i++) {
        await new Promise((r) => setTimeout(r, 10_000));
        status = (await resend(`/domains/${dom.id}`)).status;
      }
      if (status !== "verified") warn(`Resend hasn't verified ${mail.resendDomain} yet (status "${status}"). It keeps checking; auto-replies fail and are recorded on each lead until it does.`);
      const key = await resend("/api-keys", { method: "POST", body: { name: `${id} sending`, permission: "sending_access", domain_id: dom.id } });
      runWrangler(["secret", "put", "RESEND_API_KEY", "--name", id], { input: key.token });
      resendOn = true;
      done("resend", `${mail.resendDomain} ${status}; sending-only key stored as the Worker secret RESEND_API_KEY.`);
    } catch (e) {
      warn(`Resend not set up (${e.message}); lead auto-replies stay off`);
    }
  } else {
    warn("No RESEND_ADMIN_KEY: lead auto-replies stay off. Owner notifications still go out through Cloudflare.");
  }

  // Access and Turnstile.
  const admin = await addAccessDestination(`${id} admin`, `${domain}/admin`);
  if (admin === null) warn(`Access application "${id} admin" not found: /admin on ${domain} would only be guarded by the Worker's own JWT check`);
  else done("access /admin", admin ? `added ${domain}/admin` : "already covers the domain");
  if (config.editing?.enabled) {
    const editor = await addAccessDestination(`${id} editor`, `${domain}/_emdash`);
    if (editor !== null) done("access /_emdash", editor ? `added ${domain}/_emdash` : "already covers the domain");
  }
  const siteKey = config.turnstile?.siteKey || "";
  if (siteKey && !siteKey.startsWith("1x0000")) {
    const w = await cf(`${A}/challenges/widgets/${siteKey}`);
    if (!w.domains.includes(domain)) {
      const keep = Object.fromEntries(["bot_fight_mode", "clearance_level", "ephemeral_id", "offlabel", "region"].filter((k) => w[k] !== undefined).map((k) => [k, w[k]]));
      await cf(`${A}/challenges/widgets/${siteKey}`, { method: "PUT", body: { ...keep, name: w.name, mode: w.mode, domains: [...w.domains, domain] } });
    }
    done("turnstile", `widget covers ${domain}`);
  } else {
    warn("The site uses Turnstile test keys; real forms on the domain need a real widget");
  }

  // The Custom Domain. The current (idea) deploy answers there with noindex until the launch deploy.
  await cf(`${A}/workers/domains`, { method: "PUT", body: { hostname: domain, service: id, zone_id: z.id, enabled: true } });
  done("custom domain", `${domain} → Worker ${id}`);

  // The site's files.
  const nextConfig = launchConfig(config, { domain, postalAddress: postal, resend: resendOn });
  writeFileSync(configPath, JSON.stringify(nextConfig, null, 2) + "\n");
  const nextWrangler = launchWrangler(wrangler, { id, domain, owner, db: prodUuid, stagingDb: stagingUuid });
  writeFileSync(wranglerPath, "// Launch mode, written by framework-b scripts/site/promote.mjs. Resource IDs are not secrets.\n" + JSON.stringify(nextWrangler, null, 2) + "\n");
  const decisions = join(SITE, "DECISIONS.md");
  if (existsSync(decisions)) {
    appendFileSync(decisions, [
      `| ${today} | Promoted to launch mode at https://${domain}; the workers.dev address stays as a noindex twin | Owner chose the domain | owner |`,
      `| ${today} | Owner notifications from ${mail.notifyFrom} through Cloudflare Email Routing; lead auto-replies ${resendOn ? `from ${mail.confirmFrom} through Resend` : "off"} | Launch defaults | inferred |`,
      `| ${today} | Own database ${names.db} (previews ${names.stagingDb}) and bucket ${names.uploads}; the idea-mode rows stay in ${SHARED_DB} until the owner approves deleting them | Launch defaults | inferred |`,
      "",
    ].join("\n"));
  }
  const handoff = join(SITE, "HANDOFF.md");
  if (existsSync(handoff)) {
    let h = readFileSync(handoff, "utf8");
    h = h.replace(/^- Site: .*$/m, `- Site: https://${domain} (the workers.dev twin answers with noindex)`).replace(/^- Admin: https:\/\/[^/\s]+\/admin/m, `- Admin: https://${domain}/admin`);
    h += `\n## Launch (promoted ${today})\n\n- Domain: ${domain} (zone ${z.id}); www redirects to the apex\n- D1: \`${names.db}\` (previews \`${names.stagingDb}\`)\n- R2: \`${names.uploads}\`\n- Mail: owner notifications from ${mail.notifyFrom}; auto-replies ${resendOn ? `from ${mail.confirmFrom} (Resend, ${mail.resendDomain})` : "off"}\n\n### Owner checklist (no API reaches these)\n\n${ownerChecklist(domain).map((l) => `- [ ] ${l}`).join("\n")}\n`;
    writeFileSync(handoff, h);
  }
  done("site files", "site.config.json and wrangler.jsonc in launch mode; DECISIONS.md and HANDOFF.md updated");
}

// ================================ finish ================================
async function finish() {
  if (config.site.mode !== "launch" || config.site.canonicalHost !== domain) throw new Error(`Merge the promote pull request first: site.config.json is still in ${config.site.mode} mode`);
  const sharedUuid = await d1(SHARED_DB);
  const prodUuid = await d1(names.db);
  if (!prodUuid) throw new Error(`${names.db} doesn't exist; run the prepare phase first`);
  const copied = await copyRows(sharedUuid, prodUuid);
  const files = await copyUploads(prodUuid);
  done("catch-up copy", `${copied.leads} lead(s), ${copied.subs} subscriber(s) and ${files.copied} file(s) that arrived before the launch deploy`);

  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    try {
      const r = await fetch(`https://${domain}/api/health`);
      ok = r.ok && (await r.json()).ok === true && !(await fetch(`https://${domain}/`)).headers.get("x-robots-tag")?.includes("noindex");
    } catch {}
    if (!ok) await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!ok) throw new Error(`https://${domain} isn't serving the launch deploy yet (health, or noindex still on). Check the Workers Builds run, then rerun finish.`);
  done("domain", `https://${domain}/api/health ok and indexable`);
  const www = await fetch(`https://www.${domain}/pricing?x=1`, { redirect: "manual" });
  if (www.status === 301 && www.headers.get("location") === `https://${domain}/pricing?x=1`) done("www", "301 to the apex, path and query kept");
  else warn(`www answered ${www.status} ${www.headers.get("location") || ""}; expected a 301 to https://${domain}/pricing?x=1`);
  const admin = (await fetch(`https://${domain}/admin`, { redirect: "manual" })).status;
  if ([302, 303, 401, 403].includes(admin)) done("admin", `locked on the domain (HTTP ${admin} before login)`);
  else warn(`/admin on ${domain} answered ${admin} without a login`);
  const sub = (await cf(`${A}/workers/subdomain`)).subdomain;
  const twin = (await fetch(`https://${id}.${sub}.workers.dev/`)).headers.get("x-robots-tag") || "";
  if (twin.includes("noindex")) done("workers.dev twin", "noindex");
  else warn("The workers.dev twin doesn't send noindex");

  if (uptimeEnabled()) {
    try {
      const removed = await removeMonitors(`${id}.${sub}.workers.dev`);
      const m = await addMonitors({ name: config.site.name, host: domain });
      done("uptime monitors", `${removed} workers.dev monitor(s) replaced by ${m.ids.length} on ${domain}`);
    } catch (e) {
      warn(`Uptime monitors not moved: ${e.message}`);
    }
  }
  done("next", `ask the owner for one real lead on https://${domain} to prove the notification email, then record it in HANDOFF.md`);
}

try {
  if (phase === "prepare") await prepare();
  else await finish();
} finally {
  const text = `## Promote ${id} to ${domain} (${phase}${DRY ? ", dry run" : ""})\n\n${lines.join("\n")}\n${warnings.length ? `\n### Warnings\n${warnings.map((w) => `- ${w}`).join("\n")}\n` : ""}`;
  if (REPORT) writeFileSync(REPORT, text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
