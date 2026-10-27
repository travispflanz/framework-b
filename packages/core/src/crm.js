// CRM mirror (docs/SPEC.md section 10). Each new lead is copied, after it is saved in D1, to:
//   sheet    a Google Sheet in the owner's Drive, through the account's Apps Script mailer (one tab per site)
//   webhook  any HTTPS endpoint (CRM_WEBHOOK_URL): Zapier, Make, n8n, a CRM's own webhook
// D1 stays the system of record. The lead id is the idempotency key: the Apps Script skips an id the tab already
// has, and the webhook gets it as the Idempotency-Key header. So the ops "site crm sync" can resend every lead
// safely, which is how a failed copy is retried and how older leads get in.
import { hmacHex } from "./lib/crypto.js";

const ATTRIBUTION = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "src", "ref", "referrer", "landing"];

// One flat row: fixed columns first, then the form's own fields, then attribution.
export function crmRow(config, { id, form, email, createdAt, page, country, fields = {}, attribution = {} }) {
  const row = { id, created_at: createdAt, site: config.site.id, form, email };
  for (const [k, v] of Object.entries(fields)) if (!(k in row) && k !== "email") row[k] = v;
  row.page = page || "";
  row.country = country || "";
  for (const k of ATTRIBUTION) if (attribution[k]) row[`attr_${k}`] = attribution[k];
  return row;
}

async function toSheet(env, config, rows) {
  if (!env.MAILER_URL || !env.MAILER_SECRET) throw new Error("sheet: MAILER_URL or MAILER_SECRET not set");
  const res = await fetch(env.MAILER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.MAILER_SECRET, site: config.site.name, rows: { sheet: config.site.id, values: rows } }),
    redirect: "follow",
  });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) throw new Error(`sheet: ${data?.error || res.status}`);
  return data.rows;
}

async function toWebhook(env, config, row) {
  if (!env.CRM_WEBHOOK_URL) throw new Error("webhook: CRM_WEBHOOK_URL not set");
  const body = JSON.stringify({ site: config.site.id, lead: row });
  const headers = { "content-type": "application/json", "idempotency-key": row.id };
  if (env.CRM_WEBHOOK_SECRET) headers["x-framework-b-signature"] = `sha256=${await hmacHex(env.CRM_WEBHOOK_SECRET, body)}`;
  const res = await fetch(env.CRM_WEBHOOK_URL, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`webhook: ${res.status}`);
}

// Called after a lead is saved (forms.js, in waitUntil). A failure is logged; "site crm sync" catches it up.
export async function mirror(env, config, row) {
  const crm = config.crm || {};
  const jobs = [];
  if (crm.sheet) jobs.push(toSheet(env, config, [row]));
  if (crm.webhook) jobs.push(toWebhook(env, config, row));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === "rejected") console.error("crm mirror", r.reason?.message || r.reason);
}

export { toSheet, toWebhook };
