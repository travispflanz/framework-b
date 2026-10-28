#!/usr/bin/env node
// Creates a new idea-mode site end to end: Cloudflare resources, the site's private GitHub repo,
// the first deploy, Access on /admin and previews, and Workers Builds. Runs in the owner's private
// ops repo (never in framework-b, whose Actions logs are public).
//
// Inputs (environment):
//   BRIEF            optional: a kickoff brief as JSON (scripts/site/lib/brief.mjs). When set, it supplies SITE_ID,
//                    SITE_NAME, SITE_TAGLINE, OWNER_EMAIL, EDITING, INDEXING and CRM, and is kept in the site as brief.json
//   SITE_ID          lowercase letters, digits, dashes; becomes the Worker name and repo "site-<id>"
//   SITE_NAME        display name
//   SITE_TAGLINE     one line (optional)
//   OWNER_EMAIL      owner inbox: Access login, lead notifications
//   TURNSTILE_MODE   "real" (default) or "test" (documented test keys; self-test only)
//   EDITING          "on" switches client editing (EmDash) on; default "off"
//   INDEXING         "on" lets search engines index the idea site at its workers.dev address; default "off"
//   FRAMEWORK_DIR    path to a framework-b checkout (default: this repo)
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_BUILDS_TOKEN, GH_SITES_TOKEN
//   MAILER_URL, MAILER_SECRET (optional: idea-mode Apps Script mailer)
//   UPTIMEROBOT_API_KEY (optional: homepage and health monitors)
//
// Every step logs what it did. Nothing secret is printed. Idempotent where it can be: shared resources
// are reused, and it stops early if the Worker or repo already exists.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { cf, gh, env, log, ApiError } from "./lib/api.mjs";
import { connectBuilds } from "./lib/builds.mjs";
import { AGENT_POLICY, attachAgentPolicy, ensureAgentPolicy } from "./lib/access-agent.mjs";
import { createInputs, decisionRows, normalizeBrief } from "./lib/brief.mjs";
import { addMonitors, uptimeEnabled } from "./lib/uptime.mjs";

const FRAMEWORK = resolve(process.env.FRAMEWORK_DIR || join(dirname(fileURLToPath(import.meta.url)), "../.."));
const ACCOUNT = env("CLOUDFLARE_ACCOUNT_ID");
const A = `/accounts/${ACCOUNT}`;
// A kickoff brief (BRIEF: its JSON) supplies the inputs below and is kept in the site as brief.json.
const kickoff = process.env.BRIEF?.trim() ? normalizeBrief(JSON.parse(process.env.BRIEF)) : null;
if (kickoff?.errors.length) throw new Error(`The brief has errors:\n- ${kickoff.errors.join("\n- ")}`);
for (const w of kickoff?.warnings || []) console.log(`! brief: ${w}`);
const input = kickoff ? createInputs(kickoff.brief) : null;
const from = (key, opts) => (input ? input[key] : env(key, opts));
const id = from("SITE_ID").trim().toLowerCase();
const name = from("SITE_NAME").trim();
const tagline = (from("SITE_TAGLINE", { required: false }) || "").trim() || `${name}.`;
const owner = from("OWNER_EMAIL").trim().toLowerCase();
const turnstileMode = (process.env.TURNSTILE_MODE || "real").trim();
const editing = (input?.EDITING ?? process.env.EDITING ?? "off").trim() === "on";
const indexing = (input?.INDEXING ?? process.env.INDEXING ?? "off").trim() === "on";
const crm = (input?.CRM ?? process.env.CRM ?? "none").trim();
const autoReply = (input?.AUTO_REPLY ?? process.env.AUTO_REPLY ?? "off").trim() === "on";
const repoName = `site-${id}`;
const SHARED = { db: "fb-ideas", previewDb: "fb-previews", uploads: "fb-ideas-uploads", previewUploads: "fb-previews" };
const TEST_SITEKEY = "1x00000000000000000000AA";
const TEST_SECRET = "1x0000000000000000000000000000000AA";
const summary = { site: id, steps: [], warnings: [] };
const done = (step, detail) => {
  summary.steps.push(detail ? `${step}: ${detail}` : step);
  log(step, detail);
};
const warn = (msg) => {
  summary.warnings.push(msg);
  console.log(`! ${msg}`);
};
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["pipe", "inherit", "inherit"], ...opts });

if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(id)) throw new Error("SITE_ID must be 3-42 lowercase letters, digits or dashes, starting with a letter");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) throw new Error("OWNER_EMAIL is not an email address");
if (!["real", "test"].includes(turnstileMode)) throw new Error('TURNSTILE_MODE must be "real" or "test"');
if (!["on", "off"].includes((process.env.EDITING || "off").trim())) throw new Error('EDITING must be "on" or "off"');
if (!["on", "off"].includes((process.env.INDEXING || "off").trim())) throw new Error('INDEXING must be "on" or "off"');

// ---------- 1. Preconditions ----------
const ghUser = await gh("/user");
if (await gh(`/repos/${ghUser.login}/${repoName}`, { allow404: true })) throw new Error(`GitHub repo ${repoName} already exists`);
if (await cf(`${A}/workers/scripts/${id}/settings`, { allow404: true })) throw new Error(`Worker ${id} already exists`);
const sub = (await cf(`${A}/workers/subdomain`)).subdomain;
const host = `${id}.${sub}.workers.dev`;
const authDomain = (await cf(`${A}/access/organizations`)).auth_domain;
if (!authDomain) throw new Error("Zero Trust organization not set up (docs/ONE-TIME-SETUP.md)");
// Client editing needs a Cron Trigger and two more D1 databases; the Free plan allows 5 and 10 per account
// (https://developers.cloudflare.com/workers/platform/limits/, https://developers.cloudflare.com/d1/platform/limits/,
// checked 2026-10-23). Stop before creating anything if either would run out.
if (editing) {
  let crons = 0;
  for (const script of await cf(`${A}/workers/scripts`)) {
    crons += ((await cf(`${A}/workers/scripts/${script.id}/schedules`, { allow404: true }))?.schedules || []).length;
  }
  const d1Count = (await cf(`${A}/d1/database?per_page=100`)).length;
  if (crons >= 5) throw new Error(`Client editing needs a Cron Trigger, and this account already uses ${crons} of the Free plan's 5`);
  if (d1Count + 2 > 10) throw new Error(`Client editing needs 2 D1 databases, and this account already has ${d1Count} of the Free plan's 10`);
  done("editing budget", `Cron Triggers ${crons}/5 in use, D1 databases ${d1Count}/10`);
}
done("preconditions", `repo and Worker names free; host ${host}`);

// ---------- 2. Shared idea resources (created once, reused by every idea site) ----------
async function ensureD1(dbName) {
  const list = await cf(`${A}/d1/database?name=${encodeURIComponent(dbName)}`);
  const found = list.find((d) => d.name === dbName);
  if (found) return { uuid: found.uuid, created: false };
  const made = await cf(`${A}/d1/database`, { method: "POST", body: { name: dbName } });
  return { uuid: made.uuid, created: true };
}
async function ensureBucket(bucket) {
  if (await cf(`${A}/r2/buckets/${bucket}`, { allow404: true })) return false;
  await cf(`${A}/r2/buckets`, { method: "POST", body: { name: bucket } });
  return true;
}
const db = await ensureD1(SHARED.db);
const previewDb = await ensureD1(SHARED.previewDb);
const uploadsCreated = await ensureBucket(SHARED.uploads);
const previewUploadsCreated = await ensureBucket(SHARED.previewUploads);
done("shared resources", [
  `${SHARED.db} ${db.created ? "created" : "reused"}`,
  `${SHARED.previewDb} ${previewDb.created ? "created" : "reused"}`,
  `${SHARED.uploads} ${uploadsCreated ? "created" : "reused"}`,
  `${SHARED.previewUploads} ${previewUploadsCreated ? "created" : "reused"}`,
].join(", "));

// ---------- 2b. Client editing resources (one set per site: EmDash content can't be shared) ----------
async function ensureKv(title) {
  const found = (await cf(`${A}/storage/kv/namespaces?per_page=100`)).find((n) => n.title === title);
  if (found) return found.id;
  return (await cf(`${A}/storage/kv/namespaces`, { method: "POST", body: { title } })).id;
}
let cms = null;
if (editing) {
  cms = {
    db: await ensureD1(`${id}-cms`),
    previewDb: await ensureD1(`${id}-cms-preview`),
    media: `${id}-media`,
    previewMedia: `${id}-media-preview`,
    session: await ensureKv(`${id}-session`),
    previewSession: await ensureKv(`${id}-session-preview`),
  };
  await ensureBucket(cms.media);
  await ensureBucket(cms.previewMedia);
  done("editing resources", `D1 ${id}-cms (+ preview), R2 ${cms.media} (+ preview), KV ${id}-session (+ preview)`);
}

// ---------- 3. Turnstile ----------
let siteKey = TEST_SITEKEY;
let turnstileSecret = TEST_SECRET;
let widgetKey = null;
if (turnstileMode === "real") {
  // A hostname covers its subdomains, so the account's workers.dev subdomain covers production and previews.
  const w = await cf(`${A}/challenges/widgets`, { method: "POST", body: { name: id, domains: [`${sub}.workers.dev`], mode: "managed" } });
  siteKey = w.sitekey;
  turnstileSecret = w.secret;
  widgetKey = w.sitekey;
  done("turnstile", "managed widget created");
} else {
  done("turnstile", "test keys (self-test mode)");
}

// ---------- 4. Access on /admin ----------
const adminApp = await cf(`${A}/access/apps`, {
  method: "POST",
  body: {
    type: "self_hosted",
    name: `${id} admin`,
    domain: `${host}/admin`,
    session_duration: "24h",
    policies: [{ name: "owner", decision: "allow", include: [{ email: { email: owner } }] }],
  },
});
done("access /admin", "application created");
// EmDash checks the Access JWT on all of /_emdash/*, so the application must cover the whole path.
const editorApp = editing ? await cf(`${A}/access/apps`, {
  method: "POST",
  body: {
    type: "self_hosted",
    name: `${id} editor`,
    domain: `${host}/_emdash`,
    session_duration: "24h",
    policies: [{ name: "editors", decision: "allow", include: [{ email: { email: owner } }] }],
  },
}) : null;
if (editorApp) done("access /_emdash", "application created (editors: the owner)");

// ---------- 5. Site files ----------
const work = mkdtempSync(join(tmpdir(), `site-${id}-`));
const dir = join(work, repoName);
cpSync(join(FRAMEWORK, "starter"), dir, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|dist|\.astro|\.wrangler|qa-output|core)([\\/]|$)/.test(src.slice(join(FRAMEWORK, "starter").length)),
});
sh("node", [join(FRAMEWORK, "scripts/vendor-core.mjs"), dir]);
const coreVersion = readFileSync(join(dir, "core/VERSION"), "utf8").trim();
// Where the site starts from, so scripts/site/update.mjs can bring it up to later framework versions.
const frameworkCommit = execFileSync("git", ["-C", FRAMEWORK, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(dir, "framework.lock.json"), JSON.stringify({ framework: { repo: "framework-b", commit: frameworkCommit, coreVersion }, editing, updatedAt: new Date().toISOString() }, null, 2) + "\n");

const config = JSON.parse(readFileSync(join(dir, "site.config.json"), "utf8"));
config.site = { ...config.site, id, name, tagline, mode: "idea", canonicalHost: host, ownerEmail: owner, postalAddress: "", indexing };
if (indexing) done("indexing", `search engines may index https://${host}; previews stay noindex`);
config.turnstile = { siteKey };
const mailer = process.env.MAILER_URL && process.env.MAILER_SECRET;
// Lead auto-replies on an idea site come from the mailer's Gmail (brief `autoReply`); without the mailer they stay off.
config.email = { notify: mailer ? "apps-script" : "none", confirm: mailer && autoReply ? "apps-script" : "none" };
if (autoReply && !mailer) warn("lead auto-reply asked for, but no Apps Script mailer is configured: auto-replies stay off");
if (!mailer) warn("No mailer configured: leads are saved in D1 and visible in /admin, but no email is sent yet");
// CRM mirror: the Google Sheet goes through the same Apps Script mailer; the webhook needs its URL as a secret later.
config.crm = { sheet: crm.includes("sheet") && !!mailer, webhook: crm.includes("webhook") };
if (crm.includes("sheet") && !mailer) warn("CRM sheet asked for, but no Apps Script mailer is configured: the Sheet copy stays off");
if (config.crm.sheet || config.crm.webhook) done("crm", `each lead is copied to ${[config.crm.sheet && "the owner's Google Sheet", config.crm.webhook && "the webhook (set CRM_WEBHOOK_URL)"].filter(Boolean).join(" and ")}`);
writeFileSync(join(dir, "site.config.json"), JSON.stringify(config, null, 2) + "\n");

const rateNamespace = String(1000 + (parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 1_000_000_000));
const wrangler = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: id,
  main: "src/worker.js",
  compatibility_date: "2026-10-01",
  workers_dev: true,
  preview_urls: true,
  assets: { directory: "./dist", binding: "ASSETS", not_found_handling: "404-page", html_handling: "drop-trailing-slash", run_worker_first: ["/api/*", "/admin", "/admin/*", "/u"] },
  d1_databases: [{ binding: "DB", database_name: SHARED.db, database_id: db.uuid, migrations_dir: "core/migrations" }],
  r2_buckets: [{ binding: "UPLOADS", bucket_name: SHARED.uploads }],
  ratelimits: [{ name: "SUBMIT_LIMITER", namespace_id: rateNamespace, simple: { limit: 5, period: 60 } }],
  vars: { ACCESS_TEAM_DOMAIN: authDomain, ACCESS_AUD: adminApp.aud },
  observability: { enabled: true },
  previews: {
    d1_databases: [{ binding: "DB", database_name: SHARED.previewDb, database_id: previewDb.uuid, migrations_dir: "core/migrations" }],
    r2_buckets: [{ binding: "UPLOADS", bucket_name: SHARED.previewUploads }],
    ratelimits: [{ name: "SUBMIT_LIMITER", namespace_id: rateNamespace, simple: { limit: 20, period: 60 } }],
    vars: { ACCESS_TEAM_DOMAIN: authDomain, ACCESS_AUD: adminApp.aud },
  },
};
writeFileSync(join(dir, "wrangler.jsonc"), "// Written by framework-b scripts/site/create.mjs. Resource IDs are not secrets.\n" + JSON.stringify(wrangler, null, 2) + "\n");

if (editing) {
  sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  sh("node", ["scripts/editing.mjs", "on"], { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
  const { stripJsonc } = await import(join(dir, "scripts/lib/jsonc.mjs"));
  const w = JSON.parse(stripJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")));
  const fill = (list, binding, value) => list.map((x) => (x.binding === binding ? { ...x, ...value } : x));
  w.d1_databases = fill(w.d1_databases, "CMS_DB", { database_name: `${id}-cms`, database_id: cms.db.uuid });
  w.r2_buckets = fill(w.r2_buckets, "MEDIA", { bucket_name: cms.media });
  w.kv_namespaces = fill(w.kv_namespaces, "SESSION", { id: cms.session });
  // Previews never touch the production content (EmDash's Cloudflare guide, checked 2026-10-23).
  w.previews.d1_databases.push({ binding: "CMS_DB", database_name: `${id}-cms-preview`, database_id: cms.previewDb.uuid });
  w.previews.r2_buckets.push({ binding: "MEDIA", bucket_name: cms.previewMedia });
  w.previews.kv_namespaces = [{ binding: "SESSION", id: cms.previewSession }];
  writeFileSync(join(dir, "wrangler.jsonc"), "// Written by framework-b scripts/site/create.mjs, client editing on. Resource IDs are not secrets.\n" + JSON.stringify(w, null, 2) + "\n");
  done("client editing", "switched on (EmDash at /_emdash/admin)");
}

mkdirSync(join(dir, ".githooks"), { recursive: true });
writeFileSync(join(dir, ".githooks/pre-push"), [
  "#!/bin/sh",
  "# Refuse direct pushes to main (production deploys from main). Enable once per clone: git config core.hooksPath .githooks",
  "while read local_ref local_sha remote_ref remote_sha; do",
  '  if [ "$remote_ref" = "refs/heads/main" ]; then echo "Refusing to push to main. Push a branch and open a pull request." >&2; exit 1; fi',
  "done",
  "exit 0",
  "",
].join("\n"));
chmodSync(join(dir, ".githooks/pre-push"), 0o755);

const today = new Date().toISOString().slice(0, 10);
if (kickoff) writeFileSync(join(dir, "brief.json"), JSON.stringify(kickoff.brief, null, 2) + "\n");
appendFileSync(join(dir, "DECISIONS.md"), [
  `| ${today} | Created in idea mode at https://${host} | Kickoff | owner |`,
  ...(kickoff
    ? decisionRows(kickoff.brief, kickoff.sources, today)
    : [
        `| ${today} | Search engines: ${indexing ? "indexed at the workers.dev address" : "noindex (idea default)"} | ${indexing ? "Kickoff" : "Idea default"} | ${indexing ? "owner" : "inferred"} |`,
        `| ${today} | Client editing (EmDash): ${editing ? "on; editors sign in through Cloudflare Access at /_emdash/admin" : "off"} | Kickoff | owner |`,
      ]),
  `| ${today} | Email: ${mailer ? "Apps Script mailer to the owner's inbox" : "none yet; leads are in /admin"} | Mailer ${mailer ? "configured" : "not set up"} | inferred |`,
  `| ${today} | Framework B core ${coreVersion} | Current release | inferred |`,
  "",
].join("\n"));
writeFileSync(join(dir, "HANDOFF.md"), readFileSync(join(dir, "HANDOFF.md"), "utf8")
  .replace("- Site:", `- Site: https://${host}`)
  .replace("- Admin: /admin (Cloudflare Access)", `- Admin: https://${host}/admin (Cloudflare Access, ${owner})`)
  .replace("- Repo:", `- Repo: https://github.com/${ghUser.login}/${repoName}`)
  + `\n## Resources (agent-verified ${today})\n\n- Worker: \`${id}\`\n- D1: \`${SHARED.db}\` (rows with site = \`${id}\`); previews use \`${SHARED.previewDb}\`\n- R2: \`${SHARED.uploads}\` under \`${id}/\`; previews use \`${SHARED.previewUploads}\`\n- Turnstile: ${turnstileMode === "real" ? `widget \`${id}\`` : "test keys (self-test only)"}\n- Access: applications \`${id} admin\`${editing ? `, \`${id} editor\`` : ""} and \`${id} previews\`\n${editing ? `- Client editing: D1 \`${id}-cms\` (previews \`${id}-cms-preview\`), R2 \`${cms.media}\` (previews \`${cms.previewMedia}\`), KV \`${id}-session\` (previews \`${id}-session-preview\`), hourly Cron Trigger\n` : ""}`);
done("site files", `starter + core ${coreVersion}`);

// ---------- 6. Install, migrate, build, deploy ----------
const run = (cmd, args) => sh(cmd, args, { cwd: dir, env: { ...process.env, CI: "1" } });
run("npm", ["ci", "--no-audit", "--no-fund"]);
run("npx", ["wrangler", "d1", "migrations", "apply", SHARED.db, "--remote"]);
// Previews database: same migrations, applied through a throwaway config pointing at it.
writeFileSync(join(work, "previews-db.jsonc"), JSON.stringify({ name: `${id}-previews-migrate`, compatibility_date: "2026-10-01",
  d1_databases: [{ binding: "DB", database_name: SHARED.previewDb, database_id: previewDb.uuid, migrations_dir: join(dir, "core/migrations") }] }));
run("npx", ["wrangler", "d1", "migrations", "apply", SHARED.previewDb, "--remote", "--config", join(work, "previews-db.jsonc")]);
done("migrations", "applied to both databases");

run("npm", ["run", "build"]);
const secrets = { TURNSTILE_SECRET: turnstileSecret, SIGNING_SECRET: randomBytes(36).toString("base64url") };
if (mailer) Object.assign(secrets, { MAILER_URL: process.env.MAILER_URL, MAILER_SECRET: process.env.MAILER_SECRET });
if (editing) {
  secrets.CF_ACCESS_AUDIENCE = editorApp.aud;
  // Encrypts plugin secrets EmDash stores in D1; generated in EmDash's own format. Kept only as a Worker secret.
  secrets.EMDASH_ENCRYPTION_KEY = execFileSync("npx", ["emdash", "secrets", "generate"], { cwd: dir, encoding: "utf8" }).trim().split("\n").pop().trim();
}
const secretsFile = join(work, "secrets.json");
writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
process.on("exit", () => rmSync(secretsFile, { force: true }));
run("npx", ["wrangler", "deploy", "--secrets-file", secretsFile]);
done("deploy", "Worker deployed with its secrets");

// Previews get the same secrets through the Previews base configuration.
for (const [k, v] of Object.entries(secrets)) {
  if (k === "CF_ACCESS_AUDIENCE") continue; // previews sit behind their own Access application; set below
  try {
    execFileSync("npx", ["wrangler", "preview", "base-config", "secret", "put", k], { cwd: dir, input: v, stdio: ["pipe", "ignore", "pipe"] });
  } catch (e) {
    warn(`Preview secret ${k} not set (${String(e.stderr || e.message).split("\n").find(Boolean)?.slice(0, 160)})`);
  }
}
rmSync(secretsFile, { force: true });
done("preview secrets", "base configuration updated");

// ---------- 7. Access on previews ----------
const scripts = await cf(`${A}/workers/scripts`);
const tag = scripts.find((s) => s.id === id)?.tag;
let previewApp = null;
if (tag) {
  previewApp = await cf(`${A}/access/apps`, {
    method: "POST",
    body: {
      type: "self_hosted",
      name: `${id} previews`,
      destinations: [{ type: "preview_worker", worker_id: tag }],
      session_duration: "24h",
      policies: [{ name: "owner", decision: "allow", include: [{ email: { email: owner } }] }],
    },
  });
  done("access previews", "application created");
  // Lets the P6 preview check open previews with a short-lived service token (scripts/site/lib/access-agent.mjs).
  try {
    await attachAgentPolicy(A, previewApp.id, await ensureAgentPolicy(A));
    done("access previews", `"${AGENT_POLICY}" Service Auth policy added for preview checks`);
  } catch (e) {
    warn(`Preview checks can't open previews yet: ${e.message}`);
  }
  if (editing) {
    // On a preview URL, the Access JWT comes from the previews application, so EmDash must expect its audience.
    try {
      execFileSync("npx", ["wrangler", "preview", "base-config", "secret", "put", "CF_ACCESS_AUDIENCE"], { cwd: dir, input: previewApp.aud, stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      warn(`Preview secret CF_ACCESS_AUDIENCE not set (${String(e.stderr || e.message).split("\n").find(Boolean)?.slice(0, 160)})`);
    }
  }
} else {
  warn("Worker tag not found; previews are not behind Access");
}

// ---------- 8. GitHub repo ----------
const repo = await gh("/user/repos", {
  method: "POST",
  body: { name: repoName, private: true, description: `${name} (Framework B site)`, has_wiki: false, has_projects: false, auto_init: false },
});
const remote = `https://${ghUser.login}:${env("GH_SITES_TOKEN")}@github.com/${ghUser.login}/${repoName}.git`;
const git = (...args) => sh("git", args, { cwd: dir, stdio: ["ignore", "ignore", "inherit"] });
git("init", "-q", "-b", "main");
git("-c", "user.name=Framework B", "-c", "user.email=framework-b@users.noreply.github.com", "add", "-A");
git("-c", "user.name=Framework B", "-c", "user.email=framework-b@users.noreply.github.com", "commit", "-q", "-m", `Create ${id} from Framework B starter (core ${coreVersion})`);
git("push", "-q", remote, "main");
done("github", `private repo ${repo.full_name}`);

// ---------- 9. Workers Builds ----------
try {
  await connectBuilds({ A, tag, ghUser, repo });
  done("workers builds", "production and preview triggers connected");
} catch (e) {
  warn(`Workers Builds not connected: ${e.message}. Pushes won't deploy until it is: run the "site connect builds" workflow once the Cloudflare GitHub app can see the repo.`);
}

// ---------- 10. Live check ----------
let healthy = false;
for (let i = 0; i < 20 && !healthy; i++) {
  try {
    const r = await fetch(`https://${host}/api/health`);
    healthy = r.ok && (await r.json()).ok === true;
  } catch {}
  if (!healthy) await new Promise((r) => setTimeout(r, 3000));
}
if (!healthy) warn("Health check did not pass within 60 s");
else done("health", `https://${host}/api/health ok`);
const adminStatus = (await fetch(`https://${host}/admin`, { redirect: "manual" })).status;
if (![302, 303, 401, 403].includes(adminStatus)) warn(`/admin answered ${adminStatus} without a login`);
else done("admin", `locked (HTTP ${adminStatus} before login)`);

// ---------- 11. Uptime monitors ----------
// Self-test sites get them too, so the weekly self-test covers this path; teardown removes them first.
let monitors = [];
if (!uptimeEnabled()) {
  warn("No UPTIMEROBOT_API_KEY: the site has no uptime monitors");
} else {
  try {
    const m = await addMonitors({ name, host });
    monitors = m.ids;
    done("uptime monitors", `homepage and /api/health, alerting ${m.contacts} contact(s)`);
  } catch (e) {
    warn(`Uptime monitors not created: ${e.message}`);
  }
}

Object.assign(summary, {
  url: `https://${host}`,
  dir, // the built site on this machine, for follow-up checks (QA, live lead)
  admin: `https://${host}/admin`,
  repo: repo.html_url,
  worker: id,
  turnstile: turnstileMode,
  core: coreVersion,
  editing,
  ids: { monitors, workerTag: tag, editorApp: editorApp?.id || null, cmsDb: cms?.db.uuid || null, adminApp: adminApp.id, previewApp: previewApp?.id || null, turnstileSitekey: widgetKey },
});
writeFileSync(process.env.SUMMARY_FILE || join(process.cwd(), `site-${id}.json`), JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${name}\n\n- Site: ${summary.url}\n- Admin: ${summary.admin}\n- Repo: ${summary.repo}\n\n### Steps\n${summary.steps.map((s) => `- ${s}`).join("\n")}\n${summary.warnings.length ? `\n### Warnings\n${summary.warnings.map((s) => `- ${s}`).join("\n")}\n` : ""}`);
}
console.log(`\nDone: ${summary.url}${summary.warnings.length ? ` (${summary.warnings.length} warning(s))` : ""}`);
