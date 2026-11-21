// The agent edit check's helpers (scripts/site/lib/agent-edit.mjs): it writes only to the previews' own content
// database, sends the agent's SQL with bound parameters, and names its page and rows per run.
//   node --test scripts/site/test/agent-edit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { d1, previewContentDb, runId } from "../lib/agent-edit.mjs";
import { checkPage } from "../../../starter/scripts/lib/emdash-agent-edit.mjs";
import { agentUser, sweepAgents } from "../../../starter/scripts/lib/emdash-agent.mjs";

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
