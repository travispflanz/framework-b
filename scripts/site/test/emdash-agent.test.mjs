// An agent's EmDash user and API token (starter/scripts/lib/emdash-agent.mjs): the token and its hash are what EmDash's
// own code makes, the scopes follow EmDash's role table, and the statements do what they say on EmDash's two tables.
//   node --test scripts/site/test/emdash-agent.test.mjs
// The comparison with EmDash needs @emdash-cms/auth at the version the pinned emdash depends on: CI installs it into a
// folder of its own and sets EMDASH_AUTH_DIR and EMDASH_AUTH_VERSION (.github/workflows/site-scripts-test.yml), and the
// installed version must be that one. Locally, a starter with client editing on has it in starter/node_modules.
// Without either, those tests are skipped, except in CI, where they fail.
// The statements run against the real EmDash in starter/scripts/test/editing-agent-api.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  AGENT_EMAIL_DOMAIN, MAX_TOKEN_MINUTES, ROLES, SCOPE_MIN_ROLE, TOKEN_PREFIX, agentToken, agentUser, hashApiToken, inlineSql,
  insertAgentUser, makeApiToken, mintAgent, revokeAgent, setAgentDisabled, sweepAgents,
} from "../../../starter/scripts/lib/emdash-agent.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXED = Uint8Array.from({ length: 32 }, (_, i) => i);

// EmDash's auth package, as installed for CI or in a starter with editing on.
async function emdashAuth() {
  for (const dir of [process.env.EMDASH_AUTH_DIR, join(repo, "starter")].filter(Boolean)) {
    const req = createRequire(join(dir, "noop.js"));
    let entry;
    try {
      entry = req.resolve("@emdash-cms/auth");
    } catch {
      continue;
    }
    const pkg = JSON.parse(readFileSync(join(entry.slice(0, entry.lastIndexOf("/dist/")), "package.json"), "utf8"));
    const encoding = await import(pathToFileURL(createRequire(entry).resolve("@oslojs/encoding")));
    return { auth: await import(pathToFileURL(entry)), encoding, version: pkg.version };
  }
  if (process.env.CI) throw new Error("@emdash-cms/auth is not installed: set EMDASH_AUTH_DIR (see site-scripts-test.yml)");
  return null;
}
const installed = await emdashAuth();
const pinned = JSON.parse(readFileSync(join(repo, "starter/editing/packages.json"), "utf8")).dependencies.emdash;
const withEmdash = installed ? `EmDash's @emdash-cms/auth ${installed.version} (emdash ${pinned} pinned)` : "EmDash (skipped: @emdash-cms/auth not installed)";

test("a token is ec_pat_ and 32 bytes in base64url, hashed whole with SHA-256 (a fixed vector from EmDash 1.3.1)", () => {
  const t = makeApiToken(FIXED);
  assert.equal(t.raw, "ec_pat_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  assert.equal(t.hash, "YUL-AkD3Tbs9Ao3Ee3VthXGgtdgjpPx1nE3zKFud_J0");
  assert.equal(t.prefix, "ec_pat_AAEC");
  assert.match(makeApiToken().raw, /^ec_pat_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(makeApiToken().raw, makeApiToken().raw);
  assert.throws(() => makeApiToken(new Uint8Array(16)), /32 random bytes/);
});

test(`the token, hash and prefix match ${withEmdash}`, { skip: !installed }, () => {
  const { auth, encoding } = installed;
  if (process.env.EMDASH_AUTH_VERSION) assert.equal(installed.version, process.env.EMDASH_AUTH_VERSION, "the auth package the pinned emdash depends on");
  assert.equal(auth.TOKEN_PREFIXES.PAT, TOKEN_PREFIX);
  // The same bytes encode the same way as EmDash's encoder, and the same raw token hashes the same.
  assert.equal(makeApiToken(FIXED).raw, TOKEN_PREFIX + encoding.encodeBase64urlNoPadding(FIXED));
  for (const t of [makeApiToken(FIXED), makeApiToken(), makeApiToken()]) assert.equal(auth.hashPrefixedToken(t.raw), t.hash);
  // A token EmDash makes itself: this file hashes it and finds its display prefix as EmDash does.
  for (let i = 0; i < 5; i++) {
    const own = auth.generatePrefixedToken("ec_pat_");
    assert.match(own.raw, /^ec_pat_[A-Za-z0-9_-]{43}$/);
    assert.equal(hashApiToken(own.raw), own.hash);
    assert.equal(own.raw.slice(0, TOKEN_PREFIX.length + 4), own.prefix);
  }
});

test(`roles and scopes match ${withEmdash}`, { skip: !installed }, () => {
  const { auth } = installed;
  assert.deepEqual(ROLES, { ...auth.Role });
  assert.deepEqual(Object.keys(SCOPE_MIN_ROLE), [...auth.VALID_SCOPES]);
  for (const role of Object.values(ROLES)) {
    const ours = Object.keys(SCOPE_MIN_ROLE).filter((s) => SCOPE_MIN_ROLE[s] <= role);
    assert.deepEqual(ours, auth.scopesForRole(role), `scopes for role ${role}`);
  }
  // The scopes an agent gets by default are ones EmDash would leave on an Editor's token.
  assert.deepEqual(auth.clampScopes(["content:read", "content:write"], ROLES.EDITOR), ["content:read", "content:write"]);
});

test("an agent is at most an Editor, and its token holds only scopes that role may hold", () => {
  assert.throws(() => insertAgentUser({ run: "r1", role: ROLES.ADMIN }), /at most an Editor/);
  assert.throws(() => mintAgent({ run: "r1", role: ROLES.ADMIN }), /at most an Editor/);
  for (const s of ["admin", "mcp:tools", "schema:write", "settings:manage", "transfer:export"]) {
    assert.throws(() => agentToken({ run: "r1", scopes: [s] }), /needs role 50/, s);
  }
  assert.throws(() => agentToken({ run: "r1", scopes: ["schema:read"], role: ROLES.AUTHOR }), /needs role 40/);
  assert.throws(() => agentToken({ run: "r1", scopes: ["content:everything"] }), /not one of EmDash's/);
  assert.throws(() => agentToken({ run: "r1", scopes: [] }), /at least one scope/);
  for (const run of ["", "Has Caps", "a'b", "x".repeat(49)]) assert.throws(() => agentUser(run), /run id/);
  assert.throws(() => agentToken({ run: "r1", scopes: ["content:read"], label: "Bad label" }), /token label/);
});

test(`a token lives at most ${MAX_TOKEN_MINUTES} minutes`, () => {
  assert.equal(MAX_TOKEN_MINUTES, 120);
  const now = new Date("2026-11-20T10:00:00.000Z");
  assert.equal(agentToken({ run: "r1", scopes: ["content:read"], minutes: 120, now }).expiresAt, "2026-11-20T12:00:00.000Z");
  assert.throws(() => agentToken({ run: "r1", scopes: ["content:read"], minutes: 121 }), /at most 120 minutes/);
  assert.throws(() => mintAgent({ run: "r1", minutes: 24 * 60 }), /at most 120 minutes/);
  assert.throws(() => agentToken({ run: "r1", scopes: ["content:read"], minutes: Infinity }), /lifetime in minutes/);
  assert.equal(agentToken({ run: "r1", scopes: ["content:read"], minutes: -1, now }).expiresAt, "2026-11-20T09:59:00.000Z", "an expired one, for tests");
});

test("the statements carry their values as parameters, and inlineSql writes them in as literals", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");
  const { user, token, statements } = mintAgent({ run: "r1", now, bytes: FIXED });
  assert.deepEqual(user, { id: "fb-agent-r1", email: `agent-r1@${AGENT_EMAIL_DOMAIN}`, name: "Framework B agent" });
  assert.equal(token.expiresAt, "2026-11-20T10:30:00.000Z");
  for (const s of [...statements, setAgentDisabled("r1"), ...revokeAgent("r1"), ...sweepAgents({ now })]) {
    assert.equal(s.sql.split("?").length - 1, s.params.length, s.sql);
    assert.ok(!/fb-agent-r1|ec_pat_/.test(s.sql), "values are parameters, never in the SQL text");
  }
  assert.equal(statements[1].params[5], '["content:read","content:write"]');
  assert.equal(inlineSql({ sql: "SELECT ?, ?, ?", params: ["it's", 40, null] }), "SELECT 'it''s', 40, NULL");
  assert.throws(() => inlineSql({ sql: "SELECT ?", params: [] }), /1 placeholders, 0 parameters/);
  assert.throws(() => inlineSql({ sql: "SELECT ?", params: [true] }), /can't write boolean/);
});

test("minted, disabled, swept and revoked on EmDash's users and _emdash_api_tokens tables", () => {
  // The two tables as EmDash 1.3.1's migrations 008_auth, 009_user_disabled and 016_api_tokens leave them.
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, name text, avatar_url text, role integer NOT NULL DEFAULT 10,
      email_verified integer NOT NULL DEFAULT 0, data text, created_at text DEFAULT CURRENT_TIMESTAMP, updated_at text DEFAULT CURRENT_TIMESTAMP,
      disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE _emdash_api_tokens (id text PRIMARY KEY, name text NOT NULL, token_hash text NOT NULL UNIQUE, prefix text NOT NULL,
      user_id text NOT NULL, scopes text NOT NULL, expires_at text, last_used_at text, created_at text DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT api_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE);
    INSERT INTO users (id, email, role) VALUES ('01OWNER', 'owner@example.com', 50);
    INSERT INTO users (id, email, role, disabled, created_at) VALUES ('fb-agent-persistent', 'agent@framework-b.invalid', 40, 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO _emdash_api_tokens (id, name, token_hash, prefix, user_id, scopes) VALUES ('01OWNTOKEN', 'mine', 'h', 'ec_pat_xxxx', '01OWNER', '["admin"]');`);
  const exec = (statements) => db.exec(statements.map(inlineSql).join(";\n"));
  const now = new Date("2026-11-20T10:00:00.000Z");
  const old = new Date("2026-11-20T08:00:00.000Z");
  exec(mintAgent({ run: "r1", now }).statements);
  exec([agentToken({ run: "r1", label: "read", scopes: ["content:read"], now }).statement]);
  exec(mintAgent({ run: "r0", now: old }).statements);
  exec([setAgentDisabled("r1", true, now)]);
  const users = () => db.prepare("SELECT id, role, disabled FROM users ORDER BY id").all().map((u) => ({ ...u }));
  const tokens = () => db.prepare("SELECT id, user_id FROM _emdash_api_tokens ORDER BY id").all().map((t) => t.id);
  assert.deepEqual(users(), [{ id: "01OWNER", role: 50, disabled: 0 }, { id: "fb-agent-persistent", role: 40, disabled: 1 }, { id: "fb-agent-r0", role: 40, disabled: 0 }, { id: "fb-agent-r1", role: 40, disabled: 1 }]);
  assert.deepEqual(tokens(), ["01OWNTOKEN", "fb-agent-r0-check", "fb-agent-r1-check", "fb-agent-r1-read"]);
  exec(sweepAgents({ now, olderThanMinutes: 60 }));
  assert.deepEqual(tokens(), ["01OWNTOKEN", "fb-agent-r1-check", "fb-agent-r1-read"], "the sweep takes only the older run's agent");
  assert.ok(users().some((u) => u.id === "fb-agent-persistent"), "a persistent agent user (not a per-run address) is never swept");
  exec(revokeAgent("r1"));
  assert.deepEqual(users().map((u) => u.id), ["01OWNER", "fb-agent-persistent"], "the owner is never touched");
  assert.deepEqual(tokens(), ["01OWNTOKEN"]);
  db.close();
});

test("CI installs EmDash's auth package at the version the pinned emdash uses", () => {
  const wf = readFileSync(join(repo, ".github/workflows/site-scripts-test.yml"), "utf8");
  assert.match(wf, /EMDASH_AUTH_DIR/);
  assert.match(wf, /EMDASH_AUTH_VERSION/);
  assert.match(wf, /lists no @emdash-cms\/auth dependency/, "an empty version fails rather than installing the latest");
  assert.match(wf, /starter\/editing\/packages\.json/);
  assert.ok(existsSync(join(repo, "starter/scripts/test/editing-agent-api.mjs")), "the statements are run against the real EmDash");
});
