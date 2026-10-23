import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDatabases, pollExport, startExport, storeDump, writeStatus } from "../src/backup.js";
import worker from "../src/index.js";

const API = "https://api.cloudflare.com/client/v4/accounts/test-account";
let calls;
beforeEach(() => {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    if (url.startsWith(`${API}/d1/database?page=1`)) {
      return Response.json({ success: true, result: [{ uuid: "u1", name: "ideas" }, { uuid: "u2", name: "site-a" }], result_info: { total_count: 3 } });
    }
    if (url.startsWith(`${API}/d1/database?page=2`)) {
      return Response.json({ success: true, result: [{ uuid: "u3", name: "site-b" }], result_info: { total_count: 3 } });
    }
    if (url === `${API}/d1/database/u1/export`) {
      const body = JSON.parse(init.body);
      if (!body.current_bookmark) return Response.json({ success: true, result: { at_bookmark: "bm-1" } });
      return Response.json({ success: true, result: { signed_url: "https://dumps.example.com/u1.sql", filename: "u1.sql" } });
    }
    if (url === `${API}/d1/database/u9/export`) return Response.json({ success: true, result: { status: "active" } });
    if (url === "https://dumps.example.com/u1.sql") {
      const sql = "CREATE TABLE leads (id TEXT);\nINSERT INTO leads VALUES ('a');\n";
      return new Response(sql, { headers: { "content-length": String(sql.length) } });
    }
    if (url === `${API}/d1/database/bad/export`) return Response.json({ success: false, errors: [{ code: 7500, message: "not found" }] }, { status: 404 });
    return new Response("unexpected", { status: 599 });
  });
});
afterEach(() => vi.restoreAllMocks());

describe("backup steps", () => {
  it("lists every database across pages, with the token", async () => {
    expect(await listDatabases(env)).toEqual([{ uuid: "u1", name: "ideas" }, { uuid: "u2", name: "site-a" }, { uuid: "u3", name: "site-b" }]);
    expect(calls[0].init.headers.authorization).toBe("Bearer test-token");
  });

  it("starts an export and polls until a signed URL is ready", async () => {
    expect(await startExport(env, "u1")).toBe("bm-1");
    expect(await pollExport(env, "u9", "bm-9")).toBeNull();
    expect(await pollExport(env, "u1", "bm-1")).toEqual({ signedUrl: "https://dumps.example.com/u1.sql", filename: "u1.sql" });
  });

  it("surfaces API errors with the code and message", async () => {
    await expect(startExport(env, "bad")).rejects.toThrow(/7500 not found/);
  });

  it("streams the dump into R2 under d1/<name>/<date>.sql", async () => {
    const out = await storeDump(env, { uuid: "u1", name: "ideas" }, "https://dumps.example.com/u1.sql", "2026-10-26");
    expect(out.key).toBe("d1/ideas/2026-10-26.sql");
    const obj = await env.BACKUPS.get(out.key);
    expect(await obj.text()).toContain("INSERT INTO leads");
    expect(obj.customMetadata).toEqual({ database: "ideas", uuid: "u1" });
  });
});

describe("status endpoint", () => {
  it("is 404 before any run, ok after a clean recent run, 503 after failures or when stale", async () => {
    const get = () => worker.fetch(new Request("https://backups.example.workers.dev/status"), env);
    await env.BACKUPS.delete("status/last-run.json");
    expect((await get()).status).toBe(404);

    await writeStatus(env, { finishedAt: new Date().toISOString(), databases: 3, succeeded: 3, failed: 0 });
    let res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, databases: 3 });

    await writeStatus(env, { finishedAt: new Date().toISOString(), databases: 3, succeeded: 2, failed: 1 });
    expect((await get()).status).toBe(503);

    await writeStatus(env, { finishedAt: new Date(Date.now() - 9 * 86400000).toISOString(), databases: 3, succeeded: 3, failed: 0 });
    expect((await get()).status).toBe(503);
  });

  it("serves nothing else", async () => {
    expect((await worker.fetch(new Request("https://backups.example.workers.dev/"), env)).status).toBe(404);
  });
});
