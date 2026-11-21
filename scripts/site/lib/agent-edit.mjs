// Helpers for the agent edit check (scripts/site/agent-edit-check.mjs; roadmap 3d, stage B): which content database
// a site's previews use, and running the agent's SQL there through the D1 query API.
// API: POST /accounts/<id>/d1/database/<uuid>/query with { sql, params } (used live by promote, adopt and newsletter).
import { cf } from "./api.mjs";

/**
 * The previews' content database for a site with client editing on, read from its site.config.json and wrangler.jsonc.
 * Throws unless editing is on and the previews bind CMS_DB to `<id>-cms-preview`, a database that isn't production's.
 * The check writes only there.
 */
export function previewContentDb({ id, config, wrangler }) {
  if (!config?.editing?.enabled) throw new Error("client editing is off in site.config.json; the agent edit check needs EmDash");
  const prod = (wrangler?.d1_databases || []).find((d) => d.binding === "CMS_DB");
  const preview = (wrangler?.previews?.d1_databases || []).find((d) => d.binding === "CMS_DB");
  const want = `${id}-cms-preview`;
  if (!preview) throw new Error("wrangler.jsonc gives previews no CMS_DB; previews would share production's content database");
  if (preview.database_name !== want) throw new Error(`the previews' CMS_DB is "${preview.database_name}", not "${want}"`);
  if (prod && (prod.database_name === preview.database_name || (prod.database_id && prod.database_id === preview.database_id))) {
    throw new Error("the previews' CMS_DB is production's content database");
  }
  return { name: want, id: preview.database_id || null, production: prod?.database_name || `${id}-cms` };
}

/** Runs statements ({ sql, params }) one at a time on a D1 database; returns each one's rows. */
export function d1(A, uuid) {
  return async (statements) => {
    const out = [];
    for (const { sql, params = [] } of statements) {
      const r = await cf(`${A}/d1/database/${uuid}/query`, { method: "POST", body: { sql, params } });
      out.push(r?.[0]?.results || []);
    }
    return out;
  };
}

/** A run id for the agent's rows and the check page: lowercase, at most 48 characters, unique enough per run. */
export function runId(label, now = Date.now()) {
  const base = String(label || "check").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "check";
  return `${base}-${now.toString(36)}`.slice(0, 48);
}
