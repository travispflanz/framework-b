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

/**
 * True when `url` is one of this Worker's preview URLs on the account's workers.dev subdomain:
 * https://<branch>-<worker>.<subdomain>.workers.dev (docs/SPEC.md, "Checking a preview (P6)"). The check reads the URL
 * from the build log, which the branch's own build also writes to, so it never sends its credentials anywhere else.
 * A preview of another Worker in the same account whose name ends in "-<worker>" also matches: the same owner's.
 */
export function isPreviewOrigin(url, { worker, subdomain }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const suffix = `-${worker}.${subdomain}.workers.dev`.toLowerCase();
  const host = u.hostname.toLowerCase();
  return u.protocol === "https:" && !u.port && host.endsWith(suffix) && /^[a-z0-9][a-z0-9-]*$/.test(host.slice(0, -suffix.length));
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs an idempotent step up to `attempts` times (clean-up: a lost DELETE is safe to send again). */
export async function retry(fn, { attempts = 3, waitMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      await pause(waitMs * i);
    }
  }
}

/**
 * The run's clean-up, in order: trash its check page (`trash` returns what it did, for the report), then delete the
 * agent user and its tokens. Each step is retried; a failed step doesn't stop the next. Returns report lines and
 * whether everything was cleaned.
 */
export async function cleanUp({ run, db, revoke, trash = null, waitMs = 2000 }) {
  const lines = [];
  let ok = true;
  if (trash) {
    try {
      const how = await retry(trash, { waitMs });
      lines.push(`Clean-up: ${how}`);
    } catch (e) {
      ok = false;
      lines.push(`**Clean-up failed:** the check page may still be published: ${e.message}`);
    }
  }
  try {
    await retry(() => db(revoke(run)), { waitMs });
    lines.push("Clean-up: the agent user and its API token are deleted");
  } catch (e) {
    ok = false;
    lines.push(`**Clean-up failed:** the agent user for run \`${run}\` may be left (its token expires within 30 minutes; the workflow's last step and the next run's sweep delete it): ${e.message}`);
  }
  return { ok, lines };
}

/**
 * Statements that clean up after a run that never reached its own clean-up (cancelled or killed): its agent user and
 * tokens, and its check page, moved to the trash the way EmDash does it (deleted_at; ContentRepository.delete in
 * EmDash 1.3.1). EmDash's cache of that page then expires on its own (maxAge 300 s, starter/editing/astro.config.mjs).
 */
export function fallbackCleanup({ run, slug, revokeAgent, now = new Date() }) {
  // The agent first: a leftover agent user is what does lasting harm (section "Agents editing content", docs/SPEC.md).
  return [...revokeAgent(run), trashBySlug(slug, now)];
}

/** Moves a page to the trash in D1 the way EmDash does (deleted_at), for when EmDash's API can't be used. */
export function trashBySlug(slug, now = new Date()) {
  return { sql: "UPDATE ec_pages SET deleted_at = ? WHERE slug = ? AND deleted_at IS NULL", params: [new Date(now).toISOString(), slug] };
}
