// Account-wide D1 backup, step by step. Uses D1's own export API (a full SQL dump: schema and data),
// so every database in the account is covered without per-site bindings or a site registry.
// https://developers.cloudflare.com/workflows/examples/backup-d1/ (checked 2026-10-22)

const API = "https://api.cloudflare.com/client/v4";

async function cf(env, path, init = {}) {
  const res = await fetch(`${API}/accounts/${env.ACCOUNT_ID}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${env.D1_BACKUP_TOKEN}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const msg = body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${path}: ${msg}`);
  }
  return body;
}

// All D1 databases in the account: [{ uuid, name }].
export async function listDatabases(env) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const body = await cf(env, `/d1/database?page=${page}&per_page=100`);
    out.push(...body.result.map((d) => ({ uuid: d.uuid, name: d.name })));
    const info = body.result_info;
    if (!info || out.length >= info.total_count || body.result.length === 0) break;
  }
  return out;
}

// The live export API nests the dump under result.result ({ status: "complete", result: { signed_url, filename } }),
// not at result.signed_url as the Workflows backup example shows. Observed with a real database on 2026-10-23.
// Both shapes are accepted. A small database is often complete in the first response, before any poll.
function readyFrom(r) {
  const url = r?.result?.signed_url || r?.signed_url;
  return url ? { signedUrl: url, filename: r?.result?.filename || r?.filename } : null;
}

// Starts an export job. Returns { bookmark, ready }, where ready is set if the dump is already done.
export async function startExport(env, uuid) {
  const body = await cf(env, `/d1/database/${uuid}/export`, { method: "POST", body: JSON.stringify({ output_format: "polling" }) });
  const r = body.result || {};
  if (r.status === "error" || r.error) throw new Error(`export failed: ${r.error || "unknown"}`);
  if (!r.at_bookmark) throw new Error("export did not return at_bookmark");
  return { bookmark: r.at_bookmark, ready: readyFrom(r) };
}

// Polls the job; returns { signedUrl, filename } when ready, or null while still running.
// A finished or lost job answers { success: false, error: "Not currently exporting anything." }, which throws.
export async function pollExport(env, uuid, bookmark) {
  const body = await cf(env, `/d1/database/${uuid}/export`, {
    method: "POST",
    body: JSON.stringify({ output_format: "polling", current_bookmark: bookmark }),
  });
  const r = body.result || {};
  if (r.status === "error" || r.success === false || r.error) throw new Error(`export failed: ${r.error || "unknown"}`);
  return readyFrom(r);
}

// Streams the dump into R2 (no buffering, so CPU time stays low). Returns the object key and size.
export async function storeDump(env, db, signedUrl, date) {
  const res = await fetch(signedUrl);
  if (!res.ok || !res.body) throw new Error(`dump download failed: HTTP ${res.status}`);
  const key = `d1/${db.name}/${date}.sql`;
  const length = Number(res.headers.get("content-length"));
  const body = Number.isFinite(length) && length > 0 ? res.body.pipeThrough(new FixedLengthStream(length)) : res.body;
  const obj = await env.BACKUPS.put(key, body, {
    httpMetadata: { contentType: "application/sql" },
    customMetadata: { database: db.name, uuid: db.uuid },
  });
  return { key, size: obj?.size ?? length };
}

// A small status record, read by GET /status and by uptime monitors. No database names in it.
export async function writeStatus(env, status) {
  await env.BACKUPS.put("status/last-run.json", JSON.stringify(status, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}
