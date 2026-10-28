import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const API = "https://api.cloudflare.com/client/v4/accounts/test-account";
let polls;
beforeEach(() => {
  polls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(`${API}/d1/database?`)) {
      return Response.json({ success: true, result: [{ uuid: "u1", name: "ideas" }, { uuid: "u2", name: "broken" }], result_info: { total_count: 2 } });
    }
    if (url === `${API}/d1/database/u1/export`) {
      const body = JSON.parse(init.body);
      if (!body.current_bookmark) return Response.json({ success: true, result: { at_bookmark: "bm-1" } });
      // Not ready on the first poll, ready on the second.
      return Response.json({ success: true, result: ++polls < 2 ? { status: "active" } : { status: "complete", result: { signed_url: "https://dumps.example.com/u1.sql", filename: "u1.sql" } } });
    }
    if (url === `${API}/d1/database/u2/export`) return Response.json({ success: false, errors: [{ code: 7400, message: "export failed" }] }, { status: 500 });
    if (url === "https://dumps.example.com/u1.sql") return new Response("CREATE TABLE t (x);\n", { headers: { "content-length": "20" } });
    return new Response("unexpected", { status: 599 });
  });
});
afterEach(() => vi.restoreAllMocks());

it("backs up every database, keeps going past a failing one, and records the status", async () => {
  await using instance = await introspectWorkflowInstance(env.BACKUP, "run-1");
  await instance.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  await env.BACKUP.create({ id: "run-1" });
  await expect(instance.waitForStatus("errored")).resolves.not.toThrow();

  const dumps = await env.BACKUPS.list({ prefix: "d1/" });
  expect(dumps.objects.map((o) => o.key)).toEqual([expect.stringMatching(/^d1\/ideas\/\d{4}-\d{2}-\d{2}\.sql$/)]);
  const status = await (await env.BACKUPS.get("status/last-run.json")).json();
  expect(status).toMatchObject({ databases: 2, succeeded: 1, failed: 1 });
  expect(status.errors[0]).toMatch(/7400 export failed/);
});

it("the weekly cron starts one run per day, named by the date", async () => {
  const { default: worker } = await import("../src/index.js");
  const scheduledTime = Date.parse("2026-10-26T06:17:00Z");
  await using instance = await introspectWorkflowInstance(env.BACKUP, "backup-2026-10-26");
  await instance.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  await worker.scheduled({ scheduledTime, cron: "17 6 * * MON" }, env);
  await worker.scheduled({ scheduledTime, cron: "17 6 * * MON" }, env); // a retried trigger must not throw
  await expect(instance.waitForStatus("errored")).resolves.not.toThrow(); // the mocked "broken" database fails
  expect((await env.BACKUP.get("backup-2026-10-26")).id).toBe("backup-2026-10-26");
});
