// Connects a site's GitHub repo to its Worker with Workers Builds: main deploys production,
// every other branch deploys a preview. Needs a user-scoped token (CF_BUILDS_TOKEN) and the
// Cloudflare GitHub app installed with access to the repo.
// API: https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/ (checked 2026-10-22).
import { cf, env } from "./api.mjs";

export async function connectBuilds({ A, tag, ghUser, repo }) {
  const bt = env("CF_BUILDS_TOKEN");
  const existing = (await cf(`${A}/builds/workers/${tag}/triggers`, { token: bt, allow404: true })) || [];
  if (existing.length) return { already: true, triggers: existing.length };
  const conn = await cf(`${A}/builds/repos/connections`, {
    method: "PUT",
    token: bt,
    body: { provider_type: "github", provider_account_id: String(ghUser.id), provider_account_name: ghUser.login, repo_id: String(repo.id), repo_name: repo.name },
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
  return { already: false, triggers: 2 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits for the Workers Builds build of one commit on one branch and returns it once it has stopped.
// GET /builds/workers/{tag}/builds lists recent builds, newest first, with build_trigger_metadata.{branch,commit_hash}.
export async function waitForBuild({ A, tag, branch, commit, timeoutMs = 25 * 60_000, everyMs = 15_000, onWait = () => {} }) {
  const bt = env("CF_BUILDS_TOKEN");
  const start = Date.now();
  for (;;) {
    const builds = (await cf(`${A}/builds/workers/${tag}/builds`, { token: bt })) || [];
    const b = builds.find((x) => x.build_trigger_metadata?.branch === branch && (!commit || x.build_trigger_metadata?.commit_hash?.startsWith(commit)));
    if (b && b.status === "stopped") return b;
    if (Date.now() - start > timeoutMs) throw new Error(`no finished build for ${branch}${commit ? `@${commit.slice(0, 7)}` : ""} after ${Math.round(timeoutMs / 60000)} min (last seen: ${b ? b.status : "none"})`);
    onWait(b ? b.status : "not started");
    await sleep(everyMs);
  }
}

// All log lines of a build. GET /builds/builds/{uuid}/logs pages with result.cursor while result.truncated.
export async function buildLog({ A, uuid }) {
  const bt = env("CF_BUILDS_TOKEN");
  const lines = [];
  let cursor = "";
  for (let page = 0; page < 50; page++) {
    const r = await cf(`${A}/builds/builds/${uuid}/logs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { token: bt });
    for (const l of r?.lines || []) lines.push(Array.isArray(l) ? l[1] : String(l));
    if (!r?.truncated || !r?.cursor) break;
    cursor = r.cursor;
  }
  return lines;
}

// `npx wrangler preview` prints "Preview URL: https://<branch>-<worker>.<subdomain>.workers.dev"
// (seen in Workers Builds logs, 2026-10-23). The stable URL follows the branch's latest deployment.
export const previewUrlFrom = (lines) => lines.map((l) => String(l).trim().match(/^Preview URL:\s*(https:\/\/\S+)/)?.[1]).find(Boolean) || null;
