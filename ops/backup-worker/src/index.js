// framework-backups: weekly export of every D1 database in the account to R2.
// Runs as a Workflow on a schedule (wrangler.jsonc), so each step retries on its own and the
// 10 ms CPU limit of the Free plan applies per step, not to the whole job.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { listDatabases, pollExport, startExport, storeDump, writeStatus } from "./backup.js";

export class BackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const date = new Date(event.timestamp || Date.now()).toISOString().slice(0, 10);
    const dbs = await step.do("list databases", () => listDatabases(this.env));
    const results = [];

    for (const db of dbs) {
      try {
        const bookmark = await step.do(`start export ${db.uuid}`, () => startExport(this.env, db.uuid));
        let ready = null;
        for (let i = 0; i < 30 && !ready; i++) {
          ready = await step.do(`poll export ${db.uuid} #${i}`, () => pollExport(this.env, db.uuid, bookmark));
          if (!ready) await step.sleep(`wait ${db.uuid} #${i}`, "10 seconds");
        }
        if (!ready) throw new Error("export not ready after 30 polls");
        const stored = await step.do(
          `store ${db.uuid}`,
          { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" },
          () => storeDump(this.env, db, ready.signedUrl, date),
        );
        results.push({ ok: true, size: stored.size });
      } catch (e) {
        // One failing database must not stop the others.
        results.push({ ok: false, error: String(e.message || e).slice(0, 200) });
      }
    }

    const status = {
      finishedAt: new Date().toISOString(),
      date,
      databases: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      bytes: results.reduce((n, r) => n + (r.size || 0), 0),
      errors: results.filter((r) => !r.ok).map((r) => r.error),
    };
    await step.do("write status", () => writeStatus(this.env, status));
    if (status.failed) throw new Error(`${status.failed} of ${status.databases} backups failed`);
    return status;
  }
}

export default {
  // GET /status: last run summary (counts only). Anything else: 404.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/status") return new Response("Not found", { status: 404 });
    const obj = await env.BACKUPS.get("status/last-run.json");
    if (!obj) return Response.json({ ok: false, error: "no run yet" }, { status: 404 });
    const s = await obj.json();
    const ageDays = (Date.now() - Date.parse(s.finishedAt)) / 86400000;
    // "ok" is what an uptime keyword monitor looks for: last run complete, no failures, under 8 days old.
    const ok = s.failed === 0 && ageDays < 8;
    return Response.json(
      { ok, finishedAt: s.finishedAt, databases: s.databases, succeeded: s.succeeded, failed: s.failed },
      { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
    );
  },
};
