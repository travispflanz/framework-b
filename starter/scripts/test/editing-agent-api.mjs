#!/usr/bin/env node
// CI check that an agent can edit a page through EmDash's own API with an EmDash API token and no person signing in
// (roadmap 3d, stage A; docs/research/2026-11-20-agent-editing.md section 7). Run it in a starter that
// `editing.mjs on` switched on, with fill-test-placeholders. It builds, starts the local Worker, brings the seed's
// pages into the local content database, then writes agent users and tokens there with `wrangler d1 execute --local`,
// using the same code a live check would (scripts/lib/emdash-agent.mjs).
// It asserts, against the real EmDash:
// 1. GET /_emdash/api/content/pages/home with an Editor's content:read + content:write token: 200 and a _rev. The
//    token is checked before EmDash's Access check: with it, a bad Access JWT is never looked at; without it, 401.
// 2. PUT of a new hero headline: a draft; the rendered home page still shows the old one, and EmDash's live row is
//    unchanged. POST …/publish: the home page shows the new one.
// 3. A content:read token reads, and gets 403 INSUFFICIENT_SCOPE on the PUT.
// 4. An expired token, a disabled user's token and an unknown token get 401 INVALID_TOKEN.
// 5. MCP (POST /_emdash/api/mcp): initialize, tools/list and content_get work with the token; without a Bearer token
//    it is 401 with WWW-Authenticate.
// 6. The sweep removes an agent user left by an older run (and its token) and keeps the current one; revoking removes
//    the current one's rows.
// 7. (Run before 6.) The agent edit check's steps (scripts/lib/emdash-agent-edit.mjs): a new page is a draft and not on
//    the site, is published and shown, is changed as a draft (the site keeps the published headline), is published
//    again and shown, is read through MCP, and is trashed (the site answers 404).
// No Cloudflare Access in front: the local Worker is reached directly, so what Access does with the service token's
// headers and the Authorization header is stage B's to prove, on a preview. Local files only; nothing is left changed
// but dist/.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as agent from "../lib/emdash-agent.mjs";
import { agentEdit, trashPage } from "../lib/emdash-agent-edit.mjs";
import { startLocalSite } from "../lib/local-site.mjs";

assert.ok(JSON.parse(readFileSync("site.config.json", "utf8")).editing?.enabled, "switch client editing on first (scripts/editing.mjs on)");

const NAME = "agentapi";
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const RUN = `ci-${Date.now().toString(36)}`;

// The local SQLite file behind CMS_DB: the one holding EmDash's tables (as scripts/e2e.mjs finds it).
function cmsDatabase(state) {
  const dir = join(state, "v3/d1/miniflare-D1DatabaseObject");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite")) {
    const db = new DatabaseSync(join(dir, f), { readOnly: true });
    const hit = db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_emdash_fields'").get();
    db.close();
    if (hit) return join(dir, f);
  }
  return null;
}

let local;
try {
  run("npm", ["run", "build"]);
  local = await startLocalSite({ name: NAME, port: 8796 });
  const { base, state } = local;
  const config = `dist/server/.${NAME}.wrangler.json`;
  // Statements go into the local CMS_DB the way stage B sends them to the D1 API, as SQL with its parameters inlined.
  const d1 = (statements) =>
    JSON.parse(execFileSync("npx", ["wrangler", "d1", "execute", "CMS_DB", "--local", "--persist-to", state, "--config", config, "--json", "--command", statements.map(agent.inlineSql).join("; ")], { encoding: "utf8" }));
  const rows = (sql) => d1([{ sql, params: [] }]).at(-1).results;

  // EmDash makes its tables on the first request; the pages come in as the setup wizard's sample content would.
  assert.equal((await fetch(`${base}/`)).status, 200, "the home page answers");
  const cms = cmsDatabase(state);
  assert.ok(cms, "EmDash made its tables in the local content database");
  run("npx", ["emdash", "seed", "-d", cms, "seed/seed.json", "--skip-media", "--on-conflict", "update"]);
  const seedHome = JSON.parse(readFileSync("seed/seed.json", "utf8")).content.pages.find((p) => p.slug === "home");
  const oldHeadline = seedHome.data.sections[0].headline;
  const newHeadline = `Changed by an agent through the API (${RUN})`;
  const plain = (s) => s.replace(/[*=]/g, "");
  const homePage = async () => (await (await fetch(`${base}/`)).text());
  assert.ok((await homePage()).includes(plain(oldHeadline).slice(0, 30)), "the home page shows the seeded headline");

  // The agents: an Editor with content:read + content:write (and a content:read-only and an expired token), and an
  // Editor who is disabled.
  const editor = agent.mintAgent({ run: RUN, scopes: ["content:read", "content:write"] });
  const reader = agent.agentToken({ run: RUN, label: "read", scopes: ["content:read"] });
  const expired = agent.agentToken({ run: RUN, label: "expired", scopes: ["content:read", "content:write"], minutes: -1 });
  const off = agent.mintAgent({ run: `${RUN}-off`, scopes: ["content:read", "content:write"] });
  d1([...editor.statements, reader.statement, expired.statement, ...off.statements, agent.setAgentDisabled(`${RUN}-off`)]);
  const users = rows(`SELECT id, email, role, disabled FROM users WHERE id LIKE 'fb-agent-${RUN}%' ORDER BY id`);
  assert.deepEqual(users.map((u) => [u.id, u.role, u.disabled]), [[editor.user.id, 40, 0], [off.user.id, 40, 1]], "the agent users are in EmDash's users table");

  const api = (path, token, init = {}) =>
    fetch(`${base}/_emdash/api${path}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
  const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });

  // 1. Read the home page with the token.
  const got = await json(await api("/content/pages/home", editor.token.raw));
  assert.equal(got.status, 200, `GET the home page with the token: ${JSON.stringify(got.body)}`);
  const rev = got.body?.data?._rev;
  const item = got.body?.data?.item;
  assert.ok(typeof rev === "string" && rev.length > 0, "the item comes with a _rev");
  assert.equal(item?.data?.sections?.[0]?.headline, oldHeadline, "the token reads the seeded page");
  // The token is checked before Access: with it, a bad Access JWT is never looked at; without it, EmDash's Access
  // check runs and refuses the request.
  const badJwt = { "Cf-Access-Jwt-Assertion": "not-a-jwt" };
  assert.equal((await api("/content/pages/home", editor.token.raw, { headers: badJwt })).status, 200, "with the token, a bad Access JWT is never checked");
  assert.equal((await api("/content/pages/home", null, { headers: badJwt })).status, 401, "without the token, EmDash's Access check refuses a bad JWT");
  assert.equal((await api("/content/pages/home", null)).status, 401, "without any credentials, EmDash refuses the API");
  console.log(`1. GET /_emdash/api/content/pages/home with an Editor's token: 200, _rev ${rev} (checked before Access; 401 without it).`);

  // 3 (first, so the page is still as seeded). A content:read token reads but can't write.
  assert.equal((await api("/content/pages/home", reader.raw)).status, 200, "a content:read token reads the page");
  const sections = structuredClone(item.data.sections);
  sections[0].headline = newHeadline;
  const denied = await json(await api("/content/pages/home", reader.raw, { method: "PUT", body: JSON.stringify({ data: { sections }, _rev: rev }) }));
  assert.equal(denied.status, 403, `a content:read token's PUT is refused: ${JSON.stringify(denied.body)}`);
  assert.equal(denied.body?.error?.code, "INSUFFICIENT_SCOPE");
  console.log(`3. A content:read token reads (200) and its PUT gets 403 ${denied.body.error.code}.`);

  // 2. Change the hero headline as a draft, then publish. No X-EmDash-Request header: EmDash skips its CSRF check for
  // a token, which is not an ambient credential.
  const put = await json(await api(`/content/pages/${item.id}`, editor.token.raw, { method: "PUT", body: JSON.stringify({ data: { sections }, _rev: rev }) }));
  assert.equal(put.status, 200, `PUT the new headline: ${JSON.stringify(put.body)}`);
  assert.ok(put.body?.data?.item?.draftRevisionId, "a change to a published page is kept as a draft revision");
  assert.equal(put.body?.data?.item?.status, "published", "the page stays published");
  const live = new DatabaseSync(cms, { readOnly: true });
  const liveHeadline = JSON.parse(live.prepare("SELECT sections FROM ec_pages WHERE slug = 'home'").get().sections)[0].headline;
  live.close();
  assert.equal(liveHeadline, oldHeadline, "EmDash's live row keeps the old headline until the draft is published");
  const draftPage = await homePage();
  assert.ok(!draftPage.includes(newHeadline) && draftPage.includes(plain(oldHeadline).slice(0, 30)), "the rendered home page doesn't show the draft");
  const reread = await json(await api("/content/pages/home", editor.token.raw));
  assert.equal(reread.body?.data?.item?.data?.sections?.[0]?.headline, newHeadline, "the API shows the draft to an Editor");
  const pub = await json(await api(`/content/pages/${item.id}/publish`, editor.token.raw, { method: "POST", body: JSON.stringify({ _rev: put.body.data._rev }) }));
  assert.equal(pub.status, 200, `publish: ${JSON.stringify(pub.body)}`);
  let shown = false;
  for (let i = 0; i < 20 && !shown; i++, await new Promise((r) => setTimeout(r, 500))) shown = (await homePage()).includes(newHeadline);
  assert.ok(shown, "the rendered home page shows the published headline");
  console.log("2. PUT kept the new headline as a draft (the page still showed the old one); publish put it on the page.");

  // 4. Tokens EmDash must refuse.
  for (const [what, token] of [["an expired token", expired.raw], ["a disabled user's token", off.token.raw], ["an unknown token", agent.makeApiToken().raw]]) {
    const r = await json(await api("/content/pages/home", token));
    assert.equal(r.status, 401, `${what} is refused: ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.error?.code, "INVALID_TOKEN", `${what}: ${JSON.stringify(r.body)}`);
  }
  console.log("4. An expired token, a disabled user's token and an unknown token get 401 INVALID_TOKEN.");

  // 5. MCP, stateless Streamable HTTP: JSON-RPC over POST, answered as JSON or as a server-sent event.
  const mcp = async (method, params, token = editor.token.raw, id = 1) => {
    const r = await api("/mcp", token, { method: "POST", headers: { Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const text = await r.text();
    const data = (r.headers.get("content-type") || "").includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === id)
      : text ? JSON.parse(text) : null;
    return { status: r.status, data, headers: r.headers };
  };
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "framework-b-ci", version: "1" } });
  assert.equal(init.status, 200, `MCP initialize: ${JSON.stringify(init.data)}`);
  const tools = await mcp("tools/list", {}, editor.token.raw, 2);
  assert.equal(tools.status, 200, `MCP tools/list: ${JSON.stringify(tools.data)}`);
  const names = (tools.data?.result?.tools || []).map((t) => t.name);
  for (const t of ["content_get", "content_update", "content_publish"]) assert.ok(names.includes(t), `MCP lists ${t} (${names.length} tools)`);
  const mcpGet = await mcp("tools/call", { name: "content_get", arguments: { collection: "pages", id: "home" } }, editor.token.raw, 3);
  assert.equal(mcpGet.status, 200);
  assert.ok(!mcpGet.data?.result?.isError, `MCP content_get: ${JSON.stringify(mcpGet.data)}`);
  const mcpText = (mcpGet.data?.result?.content || []).map((c) => c.text || "").join("");
  assert.ok(mcpText.includes(newHeadline) && mcpText.includes("_rev"), "MCP content_get returns the published headline and a _rev");
  const anonymous = await fetch(`${base}/_emdash/api/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(anonymous.status, 401, "MCP without a Bearer token is refused");
  assert.match(anonymous.headers.get("www-authenticate") || "", /^Bearer resource_metadata="/, "with a WWW-Authenticate header");
  console.log(`5. MCP: initialize, tools/list (${names.length} tools) and content_get work with the token; without one, 401 with WWW-Authenticate.`);

  // 7. The live check's own steps (scripts/lib/emdash-agent-edit.mjs, which Framework B's agent edit check runs on a
  // preview through Access): a new page, drafted, published, changed as a draft, published again, read through MCP and
  // trashed, with the rendered page checked at every step.
  const edit = await agentEdit({ base, token: editor.token.raw, run: RUN, settleMs: 10_000, everyMs: 500 });
  for (const s of edit.steps) console.log(`   ${s.step}: ${s.detail}`);
  const trashed = rows(`SELECT deleted_at FROM ec_pages WHERE slug = '${edit.slug}'`);
  assert.ok(trashed.length === 1 && trashed[0].deleted_at, "the check page is in the trash, not deleted");
  // The live check's clean-up trashes a page a failed run made; on a page already in the trash it answers 404.
  assert.equal(await trashPage({ base, token: editor.token.raw, id: edit.id }), 404, "trashing a trashed page again is a 404, not an error");
  assert.equal(edit.purgeSeen, false, "the local Worker serves no cache, so no purge is claimed");
  console.log(`7. The agent edit check's steps passed: /${edit.slug} was made, published, changed, published again, read through MCP and trashed.`);

  // 6. Clean-up: the sweep removes what an older run left, then the run revokes its own agent.
  const oldRun = `${RUN}-old`;
  // Made 70 minutes ago with a 2-hour token: still valid, and older than the sweep's 60 minutes.
  const stale = agent.mintAgent({ run: oldRun, now: new Date(Date.now() - 70 * 60_000), minutes: 120 });
  d1(stale.statements);
  assert.equal((await api("/content/pages/home", stale.token.raw)).status, 200, "an older run's token that hasn't expired still works");
  d1(agent.sweepAgents({ olderThanMinutes: 60 }));
  assert.equal((await api("/content/pages/home", stale.token.raw)).status, 401, "the swept agent's token is refused");
  assert.equal((await api("/content/pages/home", editor.token.raw)).status, 200, "the sweep keeps the current run's agent");
  d1([...agent.revokeAgent(RUN), ...agent.revokeAgent(`${RUN}-off`)]);
  assert.equal((await api("/content/pages/home", editor.token.raw)).status, 401, "a revoked token is refused");
  assert.deepEqual(rows(`SELECT id FROM users WHERE id LIKE 'fb-agent-${RUN}%'`), [], "no agent user is left");
  assert.deepEqual(rows(`SELECT id FROM _emdash_api_tokens WHERE user_id LIKE 'fb-agent-${RUN}%'`), [], "no agent token is left");
  console.log("6. The sweep removed an older run's agent and kept the current one; revoking removed the rest.");
  console.log("Agent API passed: an Editor's API token read, drafted and published a page through EmDash's REST API and MCP, and EmDash refused the tokens it should.");
} finally {
  local?.stop();
}
