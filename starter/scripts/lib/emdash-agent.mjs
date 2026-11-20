// An agent's EmDash identity: an EmDash user and a short-lived EmDash API token (a personal access token, `ec_pat_…`)
// written straight into a site's content database (CMS_DB), so an agent can read, draft and publish pages through
// EmDash's REST API, CLI or MCP server with no person signing in and no long-lived secret.
// Framework B's docs/research/2026-11-20-agent-editing.md has the research and the plan (roadmap 3d).
//
// Pure code, no secrets: it makes the token in memory and returns SQL statements with bound parameters,
// `{ sql, params }`. It lives in the starter so the starter's own test needs nothing outside it; Framework B's ops
// scripts import it from a checkout (join(FRAMEWORK, "starter/scripts/lib/emdash-agent.mjs"), as they do jsonc.mjs).
// - The D1 query API takes a statement as it is: POST /accounts/<id>/d1/database/<uuid>/query with { sql, params }
//   (stage B, the preview check; not built yet).
// - `wrangler d1 execute --local --command` takes no parameters, so `inlineSql` writes them in as SQL literals
//   (stage A, the CI test scripts/test/editing-agent-api.mjs).
//
// EmDash 1.3.1's format (editing/packages.json pins the version), read in its npm packages on 2026-11-20:
// - Token: "ec_pat_" + 32 random bytes in base64url without padding. Stored hash: base64url, no padding, of SHA-256 of
//   the whole raw token. Display prefix: its first 11 characters. `hashPrefixedToken` and `generatePrefixedToken` in
//   @emdash-cms/auth src/tokens.ts. Framework B's scripts/site/test/emdash-agent.test.mjs compares this file with the
//   installed EmDash's own functions, so an EmDash update that changes the format fails CI.
// - Tables: `users` (emdash src/database/migrations/008_auth.ts and 009_user_disabled.ts) and `_emdash_api_tokens`
//   (016_api_tokens.ts; its user_id cascades on delete). EmDash refuses a token past `expires_at` (an ISO time; null
//   never expires) and a token whose user is disabled or missing (src/api/handlers/api-tokens.ts,
//   src/astro/middleware/auth.ts).
// - Roles (@emdash-cms/auth src/rbac.ts): Contributor 20, Author 30, Editor 40, Admin 50. Seeded pages have no
//   author, so editing and publishing them needs Editor.
//
// Agent users are never Admins, so their tokens never carry `admin`, `mcp:tools` or the site transfer scopes: an agent
// edits content; it doesn't make tokens, manage users or move the site. EmDash makes the first user in an empty `users`
// table its Admin, so an agent user must only ever be written where a person will not sign in first, or after an
// Admin exists (research, section 5).
import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PREFIX = "ec_pat_";
// Every agent row's id starts with this, so a sweep finds only rows this file wrote.
export const AGENT_ID_PREFIX = "fb-agent-";
// RFC 2606 reserves .invalid, so the address can never be anyone's Access identity.
export const AGENT_EMAIL_DOMAIN = "framework-b.invalid";
export const AGENT_NAME = "Framework B agent";
// The longest a token may live, in minutes: a run's token outlives the run only by what is left of this.
export const MAX_TOKEN_MINUTES = 120;
export const ROLES = { SUBSCRIBER: 10, CONTRIBUTOR: 20, AUTHOR: 30, EDITOR: 40, ADMIN: 50 };
// EmDash 1.3.1's scopes and the lowest role that may hold each (SCOPE_MIN_ROLE in @emdash-cms/auth src/rbac.ts). EmDash
// clamps a token's scopes to its user's role when it issues one; a token written straight into the database skips
// that, so this file refuses a scope the role may not hold. The unit test checks this table against the installed
// EmDash.
export const SCOPE_MIN_ROLE = {
  "content:read": 10, "content:write": 20, "media:read": 10, "media:write": 20, "schema:read": 40, "schema:write": 50,
  "taxonomies:manage": 40, "menus:manage": 40, "settings:read": 40, "settings:manage": 50, "mcp:tools": 50,
  "transfer:export": 50, "transfer:analyze": 50, "transfer:execute": 50, admin: 50,
};

/** EmDash's stored hash of a raw API token. */
export function hashApiToken(raw) {
  return createHash("sha256").update(raw, "utf8").digest("base64url");
}

/** A new raw token, its stored hash and its display prefix. `bytes` (32) only for tests. */
export function makeApiToken(bytes = randomBytes(32)) {
  if (bytes.length !== 32) throw new Error("an EmDash API token is 32 random bytes");
  const raw = TOKEN_PREFIX + Buffer.from(bytes).toString("base64url");
  return { raw, hash: hashApiToken(raw), prefix: raw.slice(0, TOKEN_PREFIX.length + 4) };
}

const RUN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const checkRun = (run) => {
  if (!RUN.test(String(run))) throw new Error(`run id "${run}": use 1 to 48 lowercase letters, digits and hyphens`);
  return String(run);
};
const iso = (d) => new Date(d).toISOString();

/** The agent user for a run: its id, email and name. */
export function agentUser(run) {
  run = checkRun(run);
  return { id: `${AGENT_ID_PREFIX}${run}`, email: `agent-${run}@${AGENT_EMAIL_DOMAIN}`, name: AGENT_NAME };
}

function checkRole(role) {
  if (![ROLES.SUBSCRIBER, ROLES.CONTRIBUTOR, ROLES.AUTHOR, ROLES.EDITOR].includes(role)) {
    throw new Error(`role ${role}: an agent is at most an Editor (${ROLES.EDITOR})`);
  }
  return role;
}

function checkScopes(scopes, role) {
  if (!Array.isArray(scopes) || !scopes.length) throw new Error("give the token at least one scope");
  for (const s of scopes) {
    if (!(s in SCOPE_MIN_ROLE)) throw new Error(`scope "${s}" is not one of EmDash's`);
    if (SCOPE_MIN_ROLE[s] > role) throw new Error(`scope "${s}" needs role ${SCOPE_MIN_ROLE[s]}; the agent is ${role}`);
  }
  return [...new Set(scopes)];
}

/** Inserts the agent user (the role defaults to Editor). */
export function insertAgentUser({ run, role = ROLES.EDITOR, disabled = false, now = new Date() }) {
  const u = agentUser(run);
  const at = iso(now);
  return {
    sql: "INSERT INTO users (id, email, name, avatar_url, role, email_verified, disabled, data, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 0, ?, NULL, ?, ?)",
    params: [u.id, u.email, u.name, checkRole(role), disabled ? 1 : 0, at, at],
  };
}

/**
 * A token for the run's agent user: the raw token (only in memory; give it only to the site's own origin), its row,
 * and the statement that inserts the row. `role` is the user's (its scopes must be ones that role may hold); `label`
 * tells a run's tokens apart; `minutes` is how long it lives, at most MAX_TOKEN_MINUTES (negative makes an expired
 * one, for tests).
 */
export function agentToken({ run, scopes, role = ROLES.EDITOR, minutes = 30, label = "check", now = new Date(), bytes } = {}) {
  const u = agentUser(run);
  const held = checkScopes(scopes, checkRole(role));
  if (!/^[a-z0-9-]{1,24}$/.test(label)) throw new Error(`token label "${label}": 1 to 24 lowercase letters, digits and hyphens`);
  if (!Number.isFinite(minutes)) throw new Error("give the token a lifetime in minutes");
  if (minutes > MAX_TOKEN_MINUTES) throw new Error(`a token lives at most ${MAX_TOKEN_MINUTES} minutes, not ${minutes}`);
  const t = makeApiToken(bytes);
  const id = `${u.id}-${label}`;
  const expiresAt = iso(new Date(now).getTime() + minutes * 60_000);
  return {
    raw: t.raw,
    id,
    hash: t.hash,
    prefix: t.prefix,
    expiresAt,
    statement: {
      sql: "INSERT INTO _emdash_api_tokens (id, name, token_hash, prefix, user_id, scopes, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      params: [id, `framework-b agent ${label} ${checkRun(run)}`, t.hash, t.prefix, u.id, JSON.stringify(held), expiresAt, iso(now)],
    },
  };
}

/** The agent user and one token for a run, in the order to run them. */
export function mintAgent({ run, role = ROLES.EDITOR, scopes = ["content:read", "content:write"], minutes = 30, now = new Date(), bytes } = {}) {
  const user = insertAgentUser({ run, role, now });
  const token = agentToken({ run, scopes, role, minutes, now, bytes });
  return { user: agentUser(run), token, statements: [user, token.statement] };
}

/** Disables (or enables) the run's agent user. EmDash refuses every token of a disabled user. */
export function setAgentDisabled(run, disabled = true, now = new Date()) {
  return { sql: "UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?", params: [disabled ? 1 : 0, iso(now), agentUser(run).id] };
}

/** Deletes the run's tokens, then its user. */
export function revokeAgent(run) {
  const { id } = agentUser(run);
  return [
    { sql: "DELETE FROM _emdash_api_tokens WHERE user_id = ?", params: [id] },
    { sql: "DELETE FROM users WHERE id = ?", params: [id] },
  ];
}

/**
 * Deletes agent users (and their tokens) older than `olderThanMinutes`: what a crashed run left. Only per-run rows:
 * an id that starts with AGENT_ID_PREFIX and a per-run address (agent-<run>@AGENT_EMAIL_DOMAIN), so a persistent agent
 * user with another address (stage C's agent@framework-b.invalid) is never swept. created_at is the ISO time this file
 * wrote.
 */
export function sweepAgents({ olderThanMinutes = 60, now = new Date() } = {}) {
  const cutoff = iso(new Date(now).getTime() - olderThanMinutes * 60_000);
  const stale = `SELECT id FROM users WHERE substr(id, 1, ${AGENT_ID_PREFIX.length}) = ? AND email LIKE ? AND created_at < ?`;
  const params = [AGENT_ID_PREFIX, `agent-%@${AGENT_EMAIL_DOMAIN}`, cutoff];
  return [
    { sql: `DELETE FROM _emdash_api_tokens WHERE user_id IN (${stale})`, params },
    { sql: `DELETE FROM users WHERE id IN (${stale})`, params },
  ];
}

/**
 * A statement with its parameters written in as SQL literals, for `wrangler d1 execute --command`, which takes none.
 * Only strings, finite numbers and null; the SQL itself must have no "?" other than its placeholders.
 */
export function inlineSql({ sql, params = [] }) {
  const parts = sql.split("?");
  if (parts.length - 1 !== params.length) throw new Error(`${parts.length - 1} placeholders, ${params.length} parameters`);
  const literal = (v) => {
    if (v === null) return "NULL";
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof v === "string") return `'${v.replaceAll("'", "''")}'`;
    throw new Error(`can't write ${typeof v} into SQL`);
  };
  return parts.reduce((out, part, i) => out + literal(params[i - 1]) + part);
}
