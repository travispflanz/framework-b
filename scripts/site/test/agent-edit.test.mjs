// The agent edit check's helpers (scripts/site/lib/agent-edit.mjs): it writes only to the previews' own content
// database, sends the agent's SQL with bound parameters, names its page and rows per run, sends its credentials only to
// the Worker's own preview, and cleans up (retrying, and on to the next step when one fails).
//   node --test scripts/site/test/agent-edit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanUp, d1, fallbackCleanup, isPreviewOrigin, previewContentDb, retry, runId } from "../lib/agent-edit.mjs";
import { checkPage } from "../../../starter/scripts/lib/emdash-agent-edit.mjs";
import { agentUser, revokeAgent, sweepAgents } from "../../../starter/scripts/lib/emdash-agent.mjs";

const config = { editing: { enabled: true } };
const wrangler = (preview, prod = { binding: "CMS_DB", database_name: "example-cms", database_id: "p1" }) => ({
  d1_databases: [{ binding: "DB", database_name: "example-prod", database_id: "x" }, prod],
  previews: { d1_databases: preview ? [preview] : [] },
});

test("the check writes only to <id>-cms-preview, never production's content database", () => {
  const ok = previewContentDb({ id: "example", config, wrangler: wrangler({ binding: "CMS_DB", database_name: "example-cms-preview", database_id: "v1" }) });
  assert.deepEqual(ok, { name: "example-cms-preview", id: "v1", production: "example-cms" });
  assert.throws(() => previewContentDb({ id: "example", config: { editing: { enabled: false } }, wrangler: wrangler({ binding: "CMS_DB", database_name: "example-cms-preview" }) }), /editing is off/);
  assert.throws(() => previewContentDb({ id: "example", config, wrangler: wrangler(null) }), /no CMS_DB/);
  assert.throws(() => previewContentDb({ id: "example", config, wrangler: wrangler({ binding: "CMS_DB", database_name: "example-cms" }) }), /not "example-cms-preview"/);
  assert.throws(
    () => previewContentDb({ id: "example", config, wrangler: wrangler({ binding: "CMS_DB", database_name: "example-cms-preview", database_id: "p1" }) }),
    /production's content database/,
    "a preview binding that points at production's database id is refused",
  );
});

test("statements go to the D1 query API one at a time, with their parameters bound", async () => {
  const calls = [];
  const saved = { fetch: globalThis.fetch, token: process.env.CLOUDFLARE_API_TOKEN };
  process.env.CLOUDFLARE_API_TOKEN = "t";
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, result: [{ results: [{ n: calls.length }], success: true }] }), { status: 200 });
  };
  try {
    const run = d1("/accounts/a", "uuid-1");
    const rows = await run(sweepAgents({ now: new Date("2026-11-21T00:00:00Z") }));
    assert.deepEqual(rows, [[{ n: 1 }], [{ n: 2 }]]);
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.url, "https://api.cloudflare.com/client/v4/accounts/a/d1/database/uuid-1/query");
      assert.equal(c.method, "POST");
      assert.ok(!/fb-agent-|framework-b\.invalid/.test(c.body.sql), "values travel as parameters, not inside the SQL");
      assert.deepEqual(c.body.params, ["fb-agent-", "agent-%@framework-b.invalid", "2026-11-20T23:00:00.000Z"]);
    }
  } finally {
    globalThis.fetch = saved.fetch;
    process.env.CLOUDFLARE_API_TOKEN = saved.token;
  }
});

test("each run has its own id, agent user and check page", () => {
  const a = runId("p", 1_700_000_000_000);
  const b = runId("p", 1_700_000_000_001);
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9][a-z0-9-]{0,47}$/);
  assert.match(runId("Feature/Long Branch Name With Spaces And More Words", Date.now()), /^[a-z0-9][a-z0-9-]{0,47}$/);
  assert.equal(agentUser(a).id, `fb-agent-${a}`);
  const page = checkPage(a);
  assert.equal(page.slug, `fb-agent-check-${a}`);
  assert.notEqual(page.first, page.second);
  assert.throws(() => checkPage("Not A Run"), /run id/);
});

test("credentials go only to this Worker's previews on the account's workers.dev subdomain", () => {
  const ours = { worker: "example", subdomain: "acct" };
  assert.ok(isPreviewOrigin("https://feat-x-example.acct.workers.dev", ours));
  assert.ok(isPreviewOrigin("https://feat-x-example.acct.workers.dev/some/path", ours));
  for (const url of [
    "https://example.com",
    "http://feat-x-example.acct.workers.dev",
    "https://feat-x-example.acct.workers.dev:8443",
    "https://feat-x-other.acct.workers.dev",
    "https://feat-x-example.someone-else.workers.dev",
    "https://example.acct.workers.dev",
    "https://feat-x-example.acct.workers.dev.example.com",
    "https://evil.feat-x-example.acct.workers.dev",
    "not a url",
  ]) assert.ok(!isPreviewOrigin(url, ours), url);
});

test("clean-up retries each step and goes on when one fails", async () => {
  let tries = 0;
  assert.equal(await retry(async () => (++tries < 3 ? Promise.reject(new Error("lost")) : "ok"), { waitMs: 1 }), "ok");
  assert.equal(tries, 3);
  await assert.rejects(retry(async () => { throw new Error("down"); }, { attempts: 2, waitMs: 1 }), /down/);

  const sent = [];
  const db = async (statements) => sent.push(...statements);
  let trashes = 0;
  const failingTrash = async () => { trashes++; throw new Error("HTTP 500"); };
  const r = await cleanUp({ run: "p-1", db, revoke: revokeAgent, trash: failingTrash, waitMs: 1 });
  assert.equal(trashes, 3, "the trash is tried three times");
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /may still be published/);
  assert.deepEqual(sent, revokeAgent("p-1"), "the agent is still revoked after the trash failed");

  const ok = await cleanUp({ run: "p-2", db: async () => [], revoke: revokeAgent, trash: async () => "the check page is in the trash", waitMs: 1 });
  assert.deepEqual(ok, { ok: true, lines: ["Clean-up: the check page is in the trash", "Clean-up: the agent user and its API token are deleted"] });
  const lost = await cleanUp({ run: "p-3", db: async () => { throw new Error("D1 down"); }, revoke: revokeAgent, waitMs: 1 });
  assert.equal(lost.ok, false);
  assert.match(lost.lines[0], /agent user for run `p-3` may be left/);
});

test("the fallback clean-up removes only that run's agent, first, then trashes only its page", () => {
  const page = checkPage("p-4");
  const st = fallbackCleanup({ run: "p-4", slug: page.slug, revokeAgent, now: new Date("2026-11-21T00:00:00Z") });
  assert.deepEqual(st.slice(0, -1), revokeAgent("p-4"), "the agent goes first: a failed page update can't leave it");
  assert.deepEqual(st.at(-1), { sql: "UPDATE ec_pages SET deleted_at = ? WHERE slug = ? AND deleted_at IS NULL", params: ["2026-11-21T00:00:00.000Z", "fb-agent-check-p-4"] });
});
