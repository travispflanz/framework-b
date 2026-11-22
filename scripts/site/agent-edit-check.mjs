#!/usr/bin/env node
// Agent edit check (roadmap 3d, stage B): on a branch's deployed preview, behind Cloudflare Access, an agent with an
// Access service token and an EmDash API token makes, edits, publishes and trashes a page of its own through EmDash's
// API, and the rendered preview is checked at each step. Runs in the owner's private ops repo (site-specific logs).
// Plan and evidence: docs/research/2026-11-20-agent-editing.md, sections 7 and 11.
//
//   node scripts/site/agent-edit-check.mjs --site <site checkout> --site-id <id> --branch <branch> [--commit <sha>]
//                                          [--report <file.md>] [--state <file.json>]
//   node scripts/site/agent-edit-check.mjs --site <site checkout> --site-id <id> --cleanup-run <run> [--report <file.md>]
//
// Environment: CLOUDFLARE_API_TOKEN (Access: Apps and Policies Edit, Service Tokens Edit; D1 Edit), CLOUDFLARE_ACCOUNT_ID,
// CF_BUILDS_TOKEN. The site checkout needs only site.config.json and wrangler.jsonc (no build).
//
// 1. Refuses unless client editing is on and the previews bind CMS_DB to `<id>-cms-preview`, not production's database.
// 2. Makes sure the previews Access application has the "framework-b agent" Service Auth policy (as the preview check).
// 3. Waits for the branch's build and reads the preview URL from its log; refuses a URL that isn't one of this Worker's
//    previews on the account's workers.dev subdomain. Mints a 30-minute service token and waits until Access takes it.
// 4. Writes a per-run Editor agent user and a 30-minute EmDash API token into the previews' content database, and
//    trashes any check page an earlier run left published.
// 5. Checks: the API token alone doesn't get past Access; the service token alone is no EmDash user (401, and no user
//    made); with both, a page of the check's own is made, published, changed as a draft, published again, read
//    through MCP and trashed, and the preview shows each step (starter/scripts/lib/emdash-agent-edit.mjs, the same
//    code the starter's CI runs).
// 6. Always (also on SIGINT or SIGTERM): trashes its page if the edit stopped half way, deletes the agent user and its
//    token, then the service token. `--state` records the run id and whether it cleaned up, so the workflow's last step
//    can run `--cleanup-run` (straight to D1) after a run that was killed first.
// The trashed page stays in the previews' trash (emptying it needs an Admin; the agent is an Editor on purpose).
// It runs no EmDash setup: on a preview database that was never set up, setup with the sample content would make every
// later preview show that copy instead of its branch's files (docs/DECISIONS.md, 2026-11-21).
// Exit code: 0 when every check passed and everything was cleaned up, 1 otherwise. Untested live until its first run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, env, log } from "./lib/api.mjs";
import { attachAgentPolicy, deleteCheckToken, ensureAgentPolicy, mintCheckToken, previewsApp, sweepCheckTokens, waitForToken } from "./lib/access-agent.mjs";
import { previewsAppName } from "./lib/adopt.mjs";
import { cleanUp, d1, fallbackCleanup, previewContentDb, retry, runId, trashBySlug } from "./lib/agent-edit.mjs";
import { buildLog, isPreviewOrigin, previewUrlFrom, waitForBuild } from "./lib/builds.mjs";

const FRAMEWORK = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const { stripJsonc } = await import(join(FRAMEWORK, "starter/scripts/lib/jsonc.mjs"));
const agent = await import(join(FRAMEWORK, "starter/scripts/lib/emdash-agent.mjs"));
const { CHECK_SLUG_PREFIX, agentEdit, checkPage, trashPage } = await import(join(FRAMEWORK, "starter/scripts/lib/emdash-agent-edit.mjs"));

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SITE = resolve(arg("site") || ".");
const id = arg("site-id");
const branch = arg("branch");
const commit = arg("commit") || "";
const reportFile = arg("report");
const stateFile = arg("state");
const cleanupRun = arg("cleanup-run");
if (!id || (!branch && !cleanupRun)) throw new Error("--site-id and --branch (or --cleanup-run) are required");
if (branch === "main") throw new Error("main is production; the agent edit check runs on a preview only");
const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
// GitHub Actions hides a value printed after ::add-mask:: from the rest of the log.
const mask = (value) => process.env.GITHUB_ACTIONS === "true" && value && console.log(`::add-mask::${value}`);

const report = [];
const line = (s) => {
  report.push(`- ${s}`);
  log("check", s.replace(/\*\*/g, ""));
};
const finish = (ok) => {
  const md = report.join("\n") + "\n";
  if (reportFile) writeFileSync(reportFile, md);
  console.log(md);
  process.exit(ok ? 0 : 1);
};

// The previews' content database, refused unless it is theirs alone (step 1).
async function contentDb() {
  const read = (f) => readFileSync(join(SITE, f), "utf8");
  const target = previewContentDb({ id, config: JSON.parse(read("site.config.json")), wrangler: JSON.parse(stripJsonc(read("wrangler.jsonc"))) });
  const found = ((await cf(`${A}/d1/database?name=${encodeURIComponent(target.name)}`)) || []).find((d) => d.name === target.name);
  if (!found) throw new Error(`no D1 database "${target.name}"`);
  if (target.id && found.uuid !== target.id) throw new Error(`wrangler.jsonc's previews CMS_DB id isn't "${target.name}"'s`);
  const prod = ((await cf(`${A}/d1/database?name=${encodeURIComponent(target.production)}`)) || []).find((d) => d.name === target.production);
  if (prod && prod.uuid === found.uuid) throw new Error("the previews' content database is production's");
  return { ...target, db: d1(A, found.uuid) };
}

// --cleanup-run: what a killed run left, straight to D1 (its tokens expire within 30 minutes anyway).
if (cleanupRun) {
  report.push(`## Agent edit check: clean-up after run \`${cleanupRun}\``, "");
  try {
    const { name, db } = await contentDb();
    await retry(() => db(fallbackCleanup({ run: cleanupRun, slug: checkPage(cleanupRun).slug, revokeAgent: agent.revokeAgent })));
    line(`Clean-up: run \`${cleanupRun}\`'s agent user and tokens are deleted and its check page is in the trash, in \`${name}\``);
    finish(true);
  } catch (e) {
    line(`**Clean-up failed:** ${e.message}`);
    finish(false);
  }
}

const RUN = runId("p");
const save = (state) => stateFile && writeFileSync(stateFile, JSON.stringify({ run: RUN, ...state }) + "\n");
report.push(`## Agent edit check: \`${branch}\`${commit ? ` @ \`${commit.slice(0, 7)}\`` : ""}`, "");
let ok = false;
let token = null;
let wrote = false;
let db = null;
let origin = null;
let access = {};
let minted = null;
let pageId = null;
let cleaning = null;

// Step 6, once, however the run ends.
async function cleanupAll() {
  cleaning ??= (async () => {
    let clean = true;
    if (wrote && db) {
      // Through EmDash when the page's id is known (it purges the page's cache); otherwise (the edit stopped on a
      // network error or a signal before it said) straight in D1 by the run's slug, which is a no-op if none was made.
      const trash = async () => {
        if (pageId && origin) {
          try {
            return `the check page is in the trash (through EmDash, HTTP ${await trashPage({ base: origin, token: minted.token.raw, id: pageId, access })})`;
          } catch {}
        }
        await db([trashBySlug(checkPage(RUN).slug)]);
        return "no check page of this run is left published (checked in D1)";
      };
      const r = await cleanUp({ run: RUN, db, revoke: agent.revokeAgent, trash });
      for (const l of r.lines) line(l);
      clean = r.ok;
    }
    if (token) {
      try {
        await retry(() => deleteCheckToken(A, token.id));
        line("Clean-up: the service token is deleted");
      } catch (e) {
        line(`**Could not delete the service token** (it expires within 30 minutes; the next run's sweep deletes it): ${e.message}`);
      }
    }
    save({ cleaned: clean });
    return clean;
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    line(`**Stopped by ${signal}**; cleaning up`);
    await cleanupAll().catch(() => {});
    finish(false);
  });
}

try {
  save({ cleaned: true });
  const target = await contentDb();
  db = target.db;
  line(`Content database: \`${target.name}\` (the previews' own; production's is \`${target.production}\`)`);

  const tag = (await cf(`${A}/workers/scripts`)).find((s) => s.id === id)?.tag;
  if (!tag) throw new Error(`no Worker named ${id}`);
  const adoptFile = join(SITE, "adopt.json");
  const appName = previewsAppName(id, existsSync(adoptFile) ? JSON.parse(readFileSync(adoptFile, "utf8")) : null);
  const app = await previewsApp(A, id, appName);
  if (!app) throw new Error(`no Access application "${appName}"; previews would be public`);
  const policy = await ensureAgentPolicy(A);
  if (await attachAgentPolicy(A, app.id, policy)) line(`Access: added the "${policy.name}" Service Auth policy to "${app.name}"`);

  let last = "";
  const build = await waitForBuild({ A, tag, branch, commit, onWait: (s) => s !== last && log("build", (last = s)) });
  if (build.build_outcome !== "success") throw new Error(`the preview build ${build.build_outcome || "failed"}; run the preview check for its log`);
  const url = previewUrlFrom(await buildLog({ A, uuid: build.build_uuid }));
  if (!url) throw new Error("the build log has no \"Preview URL:\" line");
  const subdomain = (await cf(`${A}/workers/subdomain`)).subdomain;
  if (!isPreviewOrigin(url, { worker: id, subdomain })) throw new Error(`the build log's preview URL ${URL.canParse(url) ? new URL(url).host : JSON.stringify(url)} isn't one of ${id}'s previews on ${subdomain}.workers.dev; no credential was sent`);
  origin = new URL(url).origin;
  line(`Preview: ${origin} (behind Cloudflare Access), build of \`${build.build_trigger_metadata?.commit_hash?.slice(0, 7)}\``);

  const swept = await sweepCheckTokens(A);
  if (swept) line(`Access: deleted ${swept} stale check token(s)`);
  token = await mintCheckToken(A, `${id} agent-edit ${branch}`.replace(/[^\w .-]/g, "-"));
  mask(token.clientSecret);
  access = { "CF-Access-Client-Id": token.clientId, "CF-Access-Client-Secret": token.clientSecret };
  line(`Access accepted the check's service token after ${await waitForToken(origin, token)} s`);
  // EmDash's first request on a content database can take over a minute (it makes its tables and its content model).
  const t0 = Date.now();
  const warm = await fetch(`${origin}/`, { headers: access, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  await warm.arrayBuffer();
  line(`\`/\`: HTTP ${warm.status} in ${Date.now() - t0} ms`);

  // The agent: an Editor with content:read and content:write, for 30 minutes. Rows a crashed run left go first.
  await db(agent.sweepAgents({ olderThanMinutes: 60 }));
  minted = agent.mintAgent({ run: RUN, scopes: ["content:read", "content:write"], minutes: 30 });
  mask(minted.token.raw);
  save({ cleaned: false });
  wrote = true;
  await db(minted.statements);
  line(`Agent: user \`${minted.user.id}\` (Editor) and a 30-minute API token (\`${minted.token.prefix}…\`), in \`${target.name}\``);
  const bearer = { Authorization: `Bearer ${minted.token.raw}` };

  // Check 1: the API token alone doesn't get past Access (a redirect to the Access login, or Access's own 401 or 403,
  // never EmDash's JSON error, which would mean the request reached the Worker).
  const alone = await fetch(`${origin}/_emdash/api/content/pages`, { headers: bearer, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const aloneText = await alone.text();
  const where = alone.headers.get("location") || "";
  const host = (() => {
    try {
      return new URL(where, origin).host;
    } catch {
      return "?";
    }
  })();
  let fromEmDash = false;
  try {
    fromEmDash = Boolean(JSON.parse(aloneText)?.error?.code);
  } catch {}
  const refused = ([301, 302, 303].includes(alone.status) && /\.cloudflareaccess\.com$/.test(host)) || ([401, 403].includes(alone.status) && !fromEmDash);
  line(`${refused ? "PASS" : "**FAIL**"} Access refuses the API token without the service token: HTTP ${alone.status}${where ? ` → ${host}` : ""}${fromEmDash ? " (EmDash's answer: the request reached the Worker)" : ""}`);
  if (!refused) throw new Error("Access let a request without the service token through");

  // Check 2: the service token alone is no EmDash user. EmDash makes a user for an Access identity it doesn't know
  // (the first one an Admin), so the users are counted before and after: a service token must never become one.
  const people = async () => (await db([{ sql: "SELECT id FROM users WHERE substr(id, 1, ?) != ?", params: [agent.AGENT_ID_PREFIX.length, agent.AGENT_ID_PREFIX] }]))[0].map((u) => u.id);
  const before = await people();
  const anon = await fetch(`${origin}/_emdash/api/content/pages`, { headers: access, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const anonBody = await anon.json().catch(() => null);
  const made = (await people()).filter((u) => !before.includes(u));
  line(`${anon.status === 401 && !made.length ? "PASS" : "**FAIL**"} EmDash takes no identity from the service token: HTTP ${anon.status}${anonBody?.error?.code ? ` ${anonBody.error.code}` : ""}${made.length ? `; it made user(s) ${made.join(", ")}` : ""}`);
  if (made.length) throw new Error(`EmDash made an EmDash user from the service token (${made.join(", ")}); it is left in the previews' content database for the owner to see`);
  if (anon.status !== 401) throw new Error(`EmDash answered the service token alone with HTTP ${anon.status}, not 401`);

  // With both, Access passes the API token through and the content model is there (EmDash applies the seed's
  // collections on its first request); no setup is run.
  const list = await fetch(`${origin}/_emdash/api/content/pages?limit=1`, { headers: { ...access, ...bearer }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  await list.arrayBuffer();
  line(`${list.status === 200 ? "PASS" : "**FAIL**"} With both, Access passes the API token through and EmDash lists pages: HTTP ${list.status}`);
  if (list.status !== 200) throw new Error(`listing pages with both credentials gave HTTP ${list.status}`);

  // A check page an earlier run left published (it stopped half way and couldn't clean up) goes to the trash.
  const left = (await db([{ sql: "SELECT id, slug FROM ec_pages WHERE slug LIKE ? AND deleted_at IS NULL", params: [`${CHECK_SLUG_PREFIX}%`] }]))[0];
  for (const p of left) await trashPage({ base: origin, token: minted.token.raw, id: p.id, access });
  if (left.length) line(`Trashed ${left.length} check page(s) an earlier run left: ${left.map((p) => `\`/${p.slug}\``).join(", ")}`);

  // Check 3: the edit, with both credentials, sent only to the preview's own origin.
  let edit;
  try {
    edit = await agentEdit({ base: origin, token: minted.token.raw, run: RUN, access, onStep: (s, d) => log(s, d) });
  } catch (e) {
    pageId = e.id || null;
    for (const s of e.steps || []) report.push(`- PASS ${s.step}: ${s.detail}`);
    throw e;
  }
  for (const s of edit.steps) report.push(`- PASS ${s.step}: ${s.detail}`);
  line(edit.purgeSeen ? "The cache purge on publish was exercised: the page was a cache HIT before the second publish" : "The cache purge on publish was not exercised: the page wasn't served from Cloudflare's cache before the second publish");
  report.push(`- The check page \`/${edit.slug}\` is in the previews' trash`);
  ok = true;
} catch (e) {
  line(`**FAIL** ${e.message}`);
  console.error(e.message);
}
const clean = await cleanupAll().catch((e) => {
  line(`**Clean-up failed:** ${e.message}`);
  return false;
});
finish(ok && clean);
