#!/usr/bin/env node
// P6 preview check: waits for the Workers Builds preview of a branch, then runs the site's QA gate against the
// deployed preview, through Cloudflare Access. Runs in the owner's private ops repo (site-specific logs).
//
//   node scripts/site/preview-check.mjs --site <site checkout> --site-id <id> --branch <branch> [--commit <sha>]
//                                       [--report <file.md>]
//
// Environment: CLOUDFLARE_API_TOKEN (Access: Apps and Policies Edit, Service Tokens Edit), CLOUDFLARE_ACCOUNT_ID,
// CF_BUILDS_TOKEN. The site checkout must be built (`npm run build`: QA's content checks read dist/) and have a
// Playwright Chromium.
//
// 1. Makes sure the site's previews Access application admits the "framework-b agent" Service Auth policy.
// 2. Waits for the branch's build of that commit; fails with the end of the build log if the build failed.
// 3. Reads the preview URL from the build log.
// 4. Mints a 30-minute service token, runs `npm run qa -- --url <preview>` with it, and deletes the token.
// Exit code: 0 when the preview built and QA passed, 1 otherwise. The report says which.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cf, env, log } from "./lib/api.mjs";
import { attachAgentPolicy, deleteCheckToken, ensureAgentPolicy, mintCheckToken, previewsApp, sweepCheckTokens } from "./lib/access-agent.mjs";
import { buildLog, previewUrlFrom, waitForBuild } from "./lib/builds.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SITE = resolve(arg("site") || ".");
const id = arg("site-id");
const branch = arg("branch");
const commit = arg("commit") || "";
const reportFile = arg("report");
if (!id || !branch) throw new Error("--site-id and --branch are required");
if (branch === "main") throw new Error("main deploys production, not a preview; check production with the QA gate's --launch mode");
const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;

const report = [`## Preview check: \`${branch}\`${commit ? ` @ \`${commit.slice(0, 7)}\`` : ""}`, ""];
let ok = false;
let token = null;
try {
  const qaSource = existsSync(join(SITE, "scripts/qa.mjs")) ? readFileSync(join(SITE, "scripts/qa.mjs"), "utf8") : "";
  if (!qaSource.includes("ACCESS_CLIENT_ID")) throw new Error("this site's QA gate predates Access-protected preview checks; bring the site up to date with `site update` first");
  const tag = (await cf(`${A}/workers/scripts`)).find((s) => s.id === id)?.tag;
  if (!tag) throw new Error(`no Worker named ${id}`);

  const app = await previewsApp(A, id);
  if (!app) throw new Error(`no Access application "${id} previews"; previews would be public`);
  const policy = await ensureAgentPolicy(A);
  if (await attachAgentPolicy(A, app.id, policy)) log("access", `added the "${policy.name}" Service Auth policy to "${app.name}"`);

  let last = "";
  const build = await waitForBuild({ A, tag, branch, commit, onWait: (s) => s !== last && log("build", (last = s)) });
  const lines = await buildLog({ A, uuid: build.build_uuid });
  if (build.build_outcome !== "success") {
    report.push(`- Build: **${build.build_outcome || "failed"}**`, "", "```", ...lines.slice(-30), "```");
    throw new Error(`the preview build ${build.build_outcome || "failed"}`);
  }
  const url = previewUrlFrom(lines);
  if (!url) throw new Error("the build log has no \"Preview URL:\" line (is the preview trigger's deploy command `npx wrangler preview`?)");
  report.push(`- Build: passed (commit \`${build.build_trigger_metadata?.commit_hash?.slice(0, 7)}\`)`, `- Preview: ${url} (behind Cloudflare Access)`);
  log("preview", url);

  const swept = await sweepCheckTokens(A);
  if (swept) log("access", `deleted ${swept} stale check token(s)`);
  token = await mintCheckToken(A, `${id} ${branch}`.replace(/[^\w .-]/g, "-"));
  const auth = { "CF-Access-Client-Id": token.clientId, "CF-Access-Client-Secret": token.clientSecret };
  // A new service token is refused (302 to the login page) for a few seconds until Access has it everywhere
  // (seen 2026-10-26). Wait until it's accepted, up to two minutes.
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${url}/api/health`, { headers: auth, redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.status === 200) break;
    if (Date.now() - t0 > 120_000) throw new Error(`Access still refuses the new service token after 2 min (last: HTTP ${r?.status ?? "no response"}); is the "framework-b agent" policy on the previews application?`);
    await new Promise((res) => setTimeout(res, 3000));
  }
  report.push(`- Access accepted the check's service token after ${Math.round((Date.now() - t0) / 1000)} s`);
  // Probe each page once before the browser checks, so a slow or stuck page is named with its timing.
  for (const path of ["/api/health", "/"]) {
    const t0 = Date.now();
    try {
      const r = await fetch(url + path, { headers: auth, redirect: "manual", signal: AbortSignal.timeout(25_000) });
      await r.arrayBuffer();
      report.push(`- \`${path}\`: HTTP ${r.status} in ${Date.now() - t0} ms${r.headers.get("location") ? ` → ${r.headers.get("location").split("?")[0]}` : ""}`);
    } catch (e) {
      report.push(`- \`${path}\`: **no response after ${Date.now() - t0} ms** (${e.name})`);
    }
  }
  // The token reaches QA only through its environment; QA sends it to the preview's own host only.
  const qa = spawnSync("npm", ["run", "qa", "--", "--url", url], {
    cwd: SITE,
    env: { ...process.env, ACCESS_CLIENT_ID: token.clientId, ACCESS_CLIENT_SECRET: token.clientSecret, CLOUDFLARE_API_TOKEN: "", CF_BUILDS_TOKEN: "" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${qa.stdout || ""}${qa.stderr || ""}`;
  mkdirSync(join(SITE, "qa-output"), { recursive: true });
  writeFileSync(join(SITE, "qa-output", "preview-qa.log"), out);
  const summary = out.split("\n").filter((l) => /^QA gate (passed|FAILED)/.test(l)).pop() || `QA exited with ${qa.status}`;
  const failures = out.split("\n").filter((l) => l.startsWith("FAIL")).slice(0, 25);
  report.push(`- QA gate on the preview: ${qa.status === 0 ? summary : `**${summary}**`}`);
  if (failures.length) report.push("", "Failed checks:", "", ...failures.map((f) => `- ${f.replace(/^FAIL\s+/, "")}`));
  ok = qa.status === 0;
} catch (e) {
  report.push("", `**Preview check failed:** ${e.message}`);
  console.error(e.message);
} finally {
  if (token) await deleteCheckToken(A, token.id).catch((e) => console.error(`could not delete the check token: ${e.message}`));
}

const md = report.join("\n") + "\n";
if (reportFile) writeFileSync(reportFile, md);
console.log(md);
process.exit(ok ? 0 : 1);
