#!/usr/bin/env node
// Creates a new idea-mode site end to end: Cloudflare resources, the site's private GitHub repo,
// the first deploy, Access on /admin and previews, and Workers Builds. Runs in the owner's private
// ops repo (never in framework-b, whose Actions logs are public).
//
// Inputs (environment):
//   SITE_ID          lowercase letters, digits, dashes; becomes the Worker name and repo "site-<id>"
//   SITE_NAME        display name
//   SITE_TAGLINE     one line (optional)
//   OWNER_EMAIL      owner inbox: Access login, lead notifications
//   TURNSTILE_MODE   "real" (default) or "test" (documented test keys; self-test only)
//   FRAMEWORK_DIR    path to a framework-b checkout (default: this repo)
//   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_BUILDS_TOKEN, GH_SITES_TOKEN
//   MAILER_URL, MAILER_SECRET (optional: idea-mode Apps Script mailer)
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

const FRAMEWORK = resolve(process.env.FRAMEWORK_DIR || join(dirname(fileURLToPath(import.meta.url)), "../.."));
const ACCOUNT = env("CLOUDFLARE_ACCOUNT_ID");
const A = `/accounts/${ACCOUNT}`;
const id = env("SITE_ID").trim().toLowerCase();
const name = env("SITE_NAME").trim();
const tagline = (process.env.SITE_TAGLINE || "").trim() || `${name}.`;
const owner = env("OWNER_EMAIL").trim().toLowerCase();
const turnstileMode = (process.env.TURNSTILE_MODE || "real").trim();
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

// ---------- 1. Preconditions ----------
const ghUser = await gh("/user");
if (await gh(`/repos/${ghUser.login}/${repoName}`, { allow404: true })) throw new Error(`GitHub repo ${repoName} already exists`);
if (await cf(`${A}/workers/scripts/${id}/settings`, { allow404: true })) throw new Error(`Worker ${id} already exists`);
const sub = (await cf(`${A}/workers/subdomain`)).subdomain;
const host = `${id}.${sub}.workers.dev`;
const authDomain = (await cf(`${A}/access/organizations`)).auth_domain;
if (!authDomain) throw new Error("Zero Trust organization not set up (docs/ONE-TIME-SETUP.md)");
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

// ---------- 5. Site files ----------
const work = mkdtempSync(join(tmpdir(), `site-${id}-`));
const dir = join(work, repoName);
cpSync(join(FRAMEWORK, "starter"), dir, {
  recursive: true,
  filter: (src) => !/[\\/](node_modules|dist|\.astro|\.wrangler|qa-output|core)([\\/]|$)/.test(src.slice(join(FRAMEWORK, "starter").length)),
});
sh("node", [join(FRAMEWORK, "scripts/vendor-core.mjs"), dir]);
const coreVersion = readFileSync(join(dir, "core/VERSION"), "utf8").trim();

const config = JSON.parse(readFileSync(join(dir, "site.config.json"), "utf8"));
config.site = { ...config.site, id, name, tagline, mode: "idea", canonicalHost: host, ownerEmail: owner, postalAddress: "", indexing: false };
config.turnstile = { siteKey };
const mailer = process.env.MAILER_URL && process.env.MAILER_SECRET;
config.email = { notify: mailer ? "apps-script" : "none", confirm: "none" };
if (!mailer) warn("No mailer configured: leads are saved in D1 and visible in /admin, but no email is sent yet");
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
appendFileSync(join(dir, "DECISIONS.md"), [
  `| ${today} | Created in idea mode at https://${host} | Kickoff | owner |`,
  `| ${today} | Search engines: noindex (idea default) | Idea default | inferred |`,
  `| ${today} | Email: ${mailer ? "Apps Script mailer to the owner's inbox" : "none yet; leads are in /admin"} | Mailer ${mailer ? "configured" : "not set up"} | inferred |`,
  `| ${today} | Framework B core ${coreVersion} | Current release | inferred |`,
  "",
].join("\n"));
writeFileSync(join(dir, "HANDOFF.md"), readFileSync(join(dir, "HANDOFF.md"), "utf8")
  .replace("- Site:", `- Site: https://${host}`)
  .replace("- Admin: /admin (Cloudflare Access)", `- Admin: https://${host}/admin (Cloudflare Access, ${owner})`)
  .replace("- Repo:", `- Repo: https://github.com/${ghUser.login}/${repoName}`)
  + `\n## Resources (agent-verified ${today})\n\n- Worker: \`${id}\`\n- D1: \`${SHARED.db}\` (rows with site = \`${id}\`); previews use \`${SHARED.previewDb}\`\n- R2: \`${SHARED.uploads}\` under \`${id}/\`; previews use \`${SHARED.previewUploads}\`\n- Turnstile: ${turnstileMode === "real" ? `widget \`${id}\`` : "test keys (self-test only)"}\n- Access: applications \`${id} admin\` and \`${id} previews\`\n`);
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
const secretsFile = join(work, "secrets.json");
writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
run("npx", ["wrangler", "deploy", "--secrets-file", secretsFile]);
done("deploy", "Worker deployed with its secrets");

// Previews get the same secrets through the Previews base configuration.
for (const [k, v] of Object.entries(secrets)) {
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
  const bt = env("CF_BUILDS_TOKEN");
  const conn = await cf(`${A}/builds/repos/connections`, {
    method: "PUT",
    token: bt,
    body: { provider_type: "github", provider_account_id: String(ghUser.id), provider_account_name: ghUser.login, repo_id: String(repo.id), repo_name: repoName },
  });
  const tokens = await cf(`${A}/builds/tokens`, { token: bt });
  if (!tokens?.length) throw new Error("no build token in the account (create one once in any Worker's Settings → Builds)");
  const base = {
    external_script_id: tag,
    repo_connection_uuid: conn.repo_connection_uuid,
    build_token_uuid: tokens[0].build_token_uuid,
    build_command: "npm run build",
    root_directory: "/",
    path_includes: ["*"],
    path_excludes: [],
  };
  await cf(`${A}/builds/triggers`, { method: "POST", token: bt, body: { ...base, trigger_name: "Deploy production", deploy_command: "npx wrangler deploy", branch_includes: ["main"], branch_excludes: [] } });
  await cf(`${A}/builds/triggers`, { method: "POST", token: bt, body: { ...base, trigger_name: "Deploy previews", deploy_command: "npx wrangler preview", branch_includes: ["*"], branch_excludes: ["main"] } });
  done("workers builds", "production and preview triggers connected");
} catch (e) {
  warn(`Workers Builds not connected: ${e.message}. Pushes won't deploy until it is (Worker → Settings → Builds).`);
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

Object.assign(summary, {
  url: `https://${host}`,
  admin: `https://${host}/admin`,
  repo: repo.html_url,
  worker: id,
  turnstile: turnstileMode,
  core: coreVersion,
  ids: { workerTag: tag, adminApp: adminApp.id, previewApp: previewApp?.id || null, turnstileSitekey: widgetKey },
});
writeFileSync(process.env.SUMMARY_FILE || join(process.cwd(), `site-${id}.json`), JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${name}\n\n- Site: ${summary.url}\n- Admin: ${summary.admin}\n- Repo: ${summary.repo}\n\n### Steps\n${summary.steps.map((s) => `- ${s}`).join("\n")}\n${summary.warnings.length ? `\n### Warnings\n${summary.warnings.map((s) => `- ${s}`).join("\n")}\n` : ""}`);
}
console.log(`\nDone: ${summary.url}${summary.warnings.length ? ` (${summary.warnings.length} warning(s))` : ""}`);
