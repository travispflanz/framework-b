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

/**
 * True when `url` is one of this Worker's preview URLs on the account's workers.dev subdomain:
 * https://<branch>-<worker>.<subdomain>.workers.dev (docs/SPEC.md, "Checking a preview (P6)"). The preview check and
 * the agent edit check read the URL from the build log, which the branch's own build also writes to, so they test it
 * with this before sending a credential there. A preview of another Worker in the same account whose name ends in
 * "-<worker>" also matches: the same owner's.
 */
export function isPreviewOrigin(url, { worker, subdomain }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const suffix = `-${worker}.${subdomain}.workers.dev`.toLowerCase();
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.port && host.endsWith(suffix) && /^[a-z0-9][a-z0-9-]*$/.test(host.slice(0, -suffix.length));
}

/**
 * The Worker Preview a branch's `npx wrangler preview` creates or updates. A Preview is named after the git branch, and
 * the Previews API lists each one with its routable URLs (`urls`) and when it was last deployed (`deployed_on`); its
 * `name` filter is a partial match, and the list is newest deployment first (docs/SPEC.md, "Checking a preview (P6)").
 * Returns null when the Worker has no Preview of that exact name.
 */
export async function branchPreview({ A, worker, branch, perPage = 100, maxPages = 10 }) {
  for (let page = 1; page <= maxPages; page++) {
    const q = new URLSearchParams({ name: branch, per_page: String(perPage), page: String(page) });
    const list = await cf(`${A}/workers/workers/${encodeURIComponent(worker)}/previews?${q}`);
    if (!Array.isArray(list)) throw new Error(`the Previews API returned no list for ${worker} (got ${list === null ? "null" : typeof list})`);
    const hit = list.find((p) => p.name === branch);
    if (hit) return hit;
    if (list.length < perPage) return null;
  }
  throw new Error(`more than ${perPage * maxPages} Worker Previews have names containing "${branch}"; stopped looking for the exact one`);
}

const originOf = (url) => (URL.canParse(url) ? new URL(url).origin : null);

/**
 * Null when `url` (already through isPreviewOrigin) is the branch's own Preview URL and that Preview was last deployed
 * after this build began running; otherwise the reason it isn't. isPreviewOrigin admits any preview of the Worker, so without this
 * a branch's build could print another branch's preview URL and QA would pass on that branch's code.
 */
export function branchPreviewMismatch(url, preview, { branch, build }) {
  const named = `the \`${branch}\` Worker Preview`;
  if (!preview) return `the Worker has no Preview named \`${branch}\``;
  const origins = (preview.urls || []).map(originOf).filter(Boolean);
  if (!origins.includes(originOf(url))) {
    const host = originOf(url) ? new URL(url).host : JSON.stringify(url);
    return `${host} isn't the URL of ${named} (${origins.map((o) => new URL(o).host).join(", ") || "it lists none"})`;
  }
  // When the build began running, not when it was queued: an earlier build of the branch can still deploy while this
  // one waits in the queue.
  const startedAt = build?.running_on || build?.created_on || "";
  if (!(Date.parse(preview.deployed_on || "") >= Date.parse(startedAt))) {
    return `${named} was last deployed ${preview.deployed_on ? `at ${preview.deployed_on}` : "never"}, before this build started (${startedAt || "unknown"})`;
  }
  return null;
}
