// /admin: lead list, lead detail with file download, CSV exports. Behind a Cloudflare Access app,
// and the Worker verifies the Access JWT itself. Every query is scoped to this site's id, because
// idea sites share one D1 database and one uploads bucket.

import { verifyAccessJwt } from "./lib/access.js";
import { csv, escapeHtml, page, safeJson } from "./lib/util.js";

const PAGE_SIZE = 100;

export async function handleAdmin(request, env, config) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const auth = await verifyAccessJwt(request, env);
  if (!auth.ok) return new Response("Forbidden", { status: 403, headers: { "cache-control": "no-store" } });

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  const site = config.site.id;

  if (path === "/admin/leads.csv") {
    const { results } = await env.DB.prepare(
      `SELECT created_at, form, email, name, phone, message, fields_json, page, attribution_json, upload_name, upload_status,
              notified, notify_error, confirmed, confirm_error, id
       FROM leads WHERE site = ? ORDER BY created_at DESC`,
    ).bind(site).all();
    const header = ["created_at", "form", "email", "name", "phone", "message", "fields_json", "page", "attribution_json",
      "upload_name", "upload_status", "notified", "notify_error", "confirmed", "confirm_error", "id"];
    return download(csv([header, ...results.map((r) => header.map((h) => r[h]))]), `${site}-leads.csv`);
  }

  if (path === "/admin/subscribers.csv") {
    const { results } = await env.DB.prepare(
      "SELECT email, status, source_form, consent_text, created_at, updated_at, unsubscribed_at FROM subscribers WHERE site = ? ORDER BY created_at DESC",
    ).bind(site).all();
    const header = ["email", "status", "source_form", "consent_text", "created_at", "updated_at", "unsubscribed_at"];
    return download(csv([header, ...results.map((r) => header.map((h) => r[h]))]), `${site}-subscribers.csv`);
  }

  const fileMatch = path.match(/^\/admin\/file\/([0-9a-f-]{36})$/);
  if (fileMatch) {
    const row = await env.DB.prepare("SELECT upload_key, upload_name, upload_type FROM leads WHERE id = ? AND site = ?")
      .bind(fileMatch[1], site).first();
    if (!row?.upload_key || !env.UPLOADS) return new Response("Not found", { status: 404 });
    const obj = await env.UPLOADS.get(row.upload_key);
    if (!obj) return new Response("Not found", { status: 404 });
    // Always a download, never rendered inline: uploads are untrusted content.
    return new Response(obj.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${row.upload_name.replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  }

  const leadMatch = path.match(/^\/admin\/lead\/([0-9a-f-]{36})$/);
  if (leadMatch) {
    const r = await env.DB.prepare("SELECT * FROM leads WHERE id = ? AND site = ?").bind(leadMatch[1], site).first();
    if (!r) return page("Not found", "<h1>Lead not found</h1>", 404);
    const fields = safeJson(r.fields_json, {});
    const attr = safeJson(r.attribution_json, {});
    const rows = Object.entries(fields).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td><pre>${escapeHtml(Array.isArray(v) ? v.join(", ") : typeof v === "object" && v ? JSON.stringify(v) : v)}</pre></td></tr>`).join("");
    const attrRows = Object.entries(attr).map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join("");
    const file = r.upload_name
      ? `<p>File: ${escapeHtml(r.upload_name)} (${Number(r.upload_size)} bytes, ${escapeHtml(r.upload_status)})${
          r.upload_status === "stored" ? ` <a href="/admin/file/${r.id}">Download</a>` : ""}</p>`
      : "";
    return page(
      `Lead ${r.id}`,
      `<p><a href="/admin">All leads</a></p><h1>${escapeHtml(r.name || r.email)}</h1>
<p>${escapeHtml(r.form)} · ${escapeHtml(r.created_at)} · ${escapeHtml(r.country || "")}</p>
<table>${rows}</table>${file}
<h2>Source</h2><p>Page: ${escapeHtml(r.page || "")}</p><table>${attrRows}</table>
<h2>Email</h2><p>Owner notified: ${r.notified ? "yes" : "no"} ${escapeHtml(r.notify_error || "")}</p>
<p>Auto-reply sent: ${r.confirmed ? "yes" : "no"} ${escapeHtml(r.confirm_error || "")}</p>
<p>Opt-in wording shown: ${escapeHtml(r.consent_text)}</p>`,
    );
  }

  if (path === "/admin") {
    const form = url.searchParams.get("form");
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const stmt = form && config.forms[form]
      ? env.DB.prepare(`SELECT id, created_at, form, email, name, upload_status FROM leads WHERE site = ? AND form = ? ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ?`).bind(site, form, offset)
      : env.DB.prepare(`SELECT id, created_at, form, email, name, upload_status FROM leads WHERE site = ? ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ?`).bind(site, offset);
    const { results } = await stmt.all();
    const tabs = ["", ...Object.keys(config.forms)]
      .map((f) => `<a href="/admin${f ? `?form=${f}` : ""}">${f || "all"}</a>`).join(" · ");
    const rows = results.map((r) =>
      `<tr><td>${escapeHtml(r.created_at.slice(0, 16).replace("T", " "))}</td><td>${escapeHtml(r.form)}</td>
<td><a href="/admin/lead/${r.id}">${escapeHtml(r.name || r.email)}</a></td><td>${escapeHtml(r.email)}</td>
<td>${r.upload_status ? escapeHtml(r.upload_status) : ""}</td></tr>`).join("");
    const next = results.length === PAGE_SIZE
      ? `<p><a href="/admin?${form ? `form=${form}&` : ""}offset=${offset + PAGE_SIZE}">Older</a></p>` : "";
    return page(
      `${config.site.name} leads`,
      `<h1>${escapeHtml(config.site.name)} leads</h1><p>${tabs} · <a href="/admin/leads.csv">leads.csv</a> · <a href="/admin/subscribers.csv">subscribers.csv</a></p>
<table><tr><th>When (UTC)</th><th>Form</th><th>Name</th><th>Email</th><th>File</th></tr>${rows}</table>${next}`,
    );
  }

  return page("Not found", "<h1>Not found</h1>", 404);
}

function download(body, filename) {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
