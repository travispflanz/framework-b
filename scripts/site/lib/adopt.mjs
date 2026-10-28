// The pure parts of adopt (scripts/site/adopt.mjs): checking the site's adopt.json and its mapping queries, checking
// mapped rows, and what the site's wrangler.jsonc becomes. No network access here, so it is unit-tested.
import { launchNames } from "./promote.mjs";

// adopt.json, in the site repo (site-owned):
//   worker          the existing Worker the site takes over (its name stays, so its domains, secrets and Access stay)
//   legacyDb        the existing D1 database; it is only ever read
//   leadsSql        a file with one SELECT over legacyDb returning rows in core's `leads` shape (LEAD_COLUMNS)
//   subscribersSql  optional: one SELECT returning rows in core's `subscribers` shape (SUBSCRIBER_COLUMNS)
//   uploads         "reuse" (keep the existing bucket; upload_key values stay valid) or { "copyFrom": "<bucket>" }
//   previewsApp     optional: the name of the Access application in front of the Worker's previews, when it isn't
//                   "<id> previews" (the preview phase checks the preview through it with a short-lived service token)
//   legacyBuild     written by prepare: the Worker's Workers Builds triggers before the cutover, for rollback
export const LEAD_COLUMNS = ["id", "site", "form", "email", "name", "phone", "message", "fields_json", "consent_text", "page",
  "attribution_json", "upload_key", "upload_name", "upload_type", "upload_size", "upload_status", "notified", "notify_error",
  "confirmed", "confirm_error", "country", "created_at"];
export const LEAD_REQUIRED = ["id", "form", "email", "consent_text", "created_at"];
export const SUBSCRIBER_COLUMNS = ["site", "email", "status", "source_form", "consent_text", "created_at", "updated_at", "unsubscribed_at"];
export const SUBSCRIBER_REQUIRED = ["email", "status", "created_at", "updated_at"];
const UPLOAD_STATUSES = ["pending", "uploading", "stored", "failed"];

export function checkAdoptConfig(a) {
  const errors = [];
  if (!a || typeof a !== "object") return ["adopt.json must be a JSON object"];
  for (const k of ["worker", "legacyDb", "leadsSql"]) if (typeof a[k] !== "string" || !a[k].trim()) errors.push(`adopt.json: "${k}" is required`);
  if (a.subscribersSql !== undefined && typeof a.subscribersSql !== "string") errors.push('adopt.json: "subscribersSql" must be a file path');
  if (a.previewsApp !== undefined && (typeof a.previewsApp !== "string" || !a.previewsApp.trim())) errors.push('adopt.json: "previewsApp" must be the Access application\'s name');
  const u = a.uploads ?? "reuse";
  if (!(u === "reuse" || (u && typeof u === "object" && typeof u.copyFrom === "string" && u.copyFrom))) errors.push('adopt.json: "uploads" must be "reuse" or { "copyFrom": "<bucket>" }');
  return errors;
}

// The mapping queries run against a database that must never change, so each must be a single read-only SELECT.
// D1's query endpoint runs whatever it is sent, so this is checked before anything is sent.
const WRITE_WORDS = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b/i;
export function checkSelect(sql, label = "query") {
  const body = String(sql || "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  const noStrings = body.replace(/'(?:[^']|'')*'/g, "''");
  if (!/^(select|with)\b/i.test(body)) return `${label}: must start with SELECT (or WITH)`;
  if (noStrings.includes(";")) return `${label}: one statement only`;
  if (WRITE_WORDS.test(noStrings)) return `${label}: only reads are allowed (found "${noStrings.match(WRITE_WORDS)[0]}")`;
  return null;
}

// A mapped lead row: required columns present, nothing outside core's schema, the site id forced to this site.
export function checkLeadRow(row, site) {
  const errors = [];
  const extra = Object.keys(row).filter((k) => !LEAD_COLUMNS.includes(k));
  if (extra.length) errors.push(`unknown column(s) ${extra.join(", ")}`);
  for (const k of LEAD_REQUIRED) if (row[k] === undefined || row[k] === null || (k !== "consent_text" && row[k] === "")) errors.push(`missing ${k}`);
  for (const k of ["fields_json", "attribution_json"]) {
    if (row[k] == null) continue;
    try {
      if (typeof JSON.parse(row[k]) !== "object") errors.push(`${k} isn't a JSON object`);
    } catch {
      errors.push(`${k} isn't JSON`);
    }
  }
  if (row.upload_status != null && !UPLOAD_STATUSES.includes(row.upload_status)) errors.push(`upload_status "${row.upload_status}"`);
  if (row.created_at && Number.isNaN(Date.parse(row.created_at))) errors.push(`created_at "${row.created_at}" isn't a date`);
  return { row: { ...row, site, fields_json: row.fields_json ?? "{}", attribution_json: row.attribution_json ?? "{}" }, errors };
}

export function checkSubscriberRow(row, site) {
  const errors = [];
  const extra = Object.keys(row).filter((k) => !SUBSCRIBER_COLUMNS.includes(k));
  if (extra.length) errors.push(`unknown column(s) ${extra.join(", ")}`);
  for (const k of SUBSCRIBER_REQUIRED) if (row[k] == null || row[k] === "") errors.push(`missing ${k}`);
  if (row.status && !["subscribed", "unsubscribed"].includes(row.status)) errors.push(`status "${row.status}"`);
  return { row: { ...row, site, email: String(row.email || "").toLowerCase() }, errors };
}

// The site's wrangler.jsonc after prepare: the existing Worker's name, the new production database for DB and the
// shared preview database for previews. Routes, buckets and everything else are the site's own choice and stay as written.
export function adoptWrangler(wrangler, { worker, db, previewDb, id }) {
  const names = launchNames(id);
  const out = structuredClone(wrangler);
  const swapDb = (list, value) => (list || []).map((d) => (d.binding === "DB" ? { ...d, ...value } : d));
  out.name = worker;
  out.d1_databases = swapDb(out.d1_databases, { database_name: names.db, database_id: db });
  if (out.previews?.d1_databases) out.previews = { ...out.previews, d1_databases: swapDb(out.previews.d1_databases, { database_name: names.previewDb, database_id: previewDb }) };
  return out;
}

// Fields of a Workers Builds trigger worth keeping for a rollback (API: developers.cloudflare.com/workers/ci-cd/builds/api-reference/).
export function keepTrigger(t) {
  const pick = ["trigger_name", "build_command", "deploy_command", "root_directory", "branch_includes", "branch_excludes", "path_includes", "path_excludes"];
  return Object.fromEntries(pick.filter((k) => t[k] !== undefined).map((k) => [k, t[k]]));
}
