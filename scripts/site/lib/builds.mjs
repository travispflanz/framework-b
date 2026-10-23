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
