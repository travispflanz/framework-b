# Agents editing content through EmDash behind Cloudflare Access (research, 2026-11-20)

Roadmap step 3d: "An agent editing content through EmDash's API with an Access service token." This is the research
and the plan. Nothing here has been run against a live site or account yet. Stage A of the plan (section 7) ran in
CI on 2026-11-20, against the real EmDash 1.3.1 on a local Worker: what it proved is marked "proven in CI" below, and
section 10 lists the results and what this document changed after it. Everything else is read in source or docs and
is **untested** until stage B runs on a preview.

- EmDash version: 1.3.1 (`emdash` and `@emdash-cms/cloudflare`, pinned in `starter/editing/packages.json`).
- EmDash source was read in the published npm packages at 1.3.1, on unpkg (each file below was compared byte for byte
  with an npm install of the same version on 2026-11-20). EmDash's GitHub repository could not be read from this
  session (GitHub access to it isn't enabled here), so no file is cited from a git tag.
- Every source below was checked on 2026-11-20 unless it says otherwise.

## 1. Summary

1. **EmDash does not accept an Access service token as an identity.** Its `access()` provider checks the Access JWT,
   then asks Access's `get-identity` endpoint for the person and finds or creates the EmDash user **by email**. A
   service token's JWT has no email (`sub` is empty, `common_name` is the client ID), so the request fails with 401
   "Authentication failed". EmDash has no setting for service tokens; the only service-token code in EmDash is in
   its CLI, which adds the two Access headers to the requests it makes.
2. **EmDash has its own API tokens, and checks them before Access.** On every `/_emdash` route the middleware tries
   `Authorization: Bearer ec_pat_…` (a personal access token) or `ec_oat_…` (an OAuth token) first. A valid one sets
   the user and its scopes and **skips the Access JWT check entirely** (proven in CI against EmDash's own Access
   check: with the token, a bad Access JWT is never looked at). So an agent sends both: the service token's
   headers get the request past Cloudflare Access, and the API token makes it an EmDash user. Access still has to let
   the request through, and EmDash still checks the user's role.
3. **API tokens are tied to a user, scoped, and optionally expire.** Admins make them in the admin (Settings > API
   Tokens) or with `POST /_emdash/api/admin/api-tokens`. Only a SHA-256 hash is stored, in `_emdash_api_tokens`, so a
   token can also be written straight into the content database (proven in CI). That is the plan's way to make one
   per run, with no person and no long-lived secret.
4. **REST, the CLI and MCP all take the same pair of credentials.** REST is the simplest for a scripted check. The
   CLI takes `EMDASH_TOKEN` and `EMDASH_HEADERS`. The MCP server at `/_emdash/api/mcp` accepts only Bearer tokens.
   `emdash login` is no use in Access mode, because EmDash offers no device flow there.
5. **The first live test needs no Access change.** On a preview URL, `/_emdash` sits behind the site's previews
   application, which already admits the preview check's 30-minute service token through the reusable
   "framework-b agent" Service Auth policy. Previews have their own content database (`<id>-cms-preview`), so no live
   content changes. Production needs a Service Auth policy on the `<id> editor` application, which is an access change
   the owner must approve.
6. **Cost: none.** Service tokens don't use Zero Trust seats; a run adds a few rows to D1 and about twenty Worker
   requests; no new database, bucket, Access application or Cron Trigger.

## 2. How EmDash authenticates requests behind Access

### People: the Access JWT

`@emdash-cms/cloudflare` 1.3.1, [cloudflare-access.ts](https://unpkg.com/@emdash-cms/cloudflare@1.3.1/src/auth/cloudflare-access.ts):

- Reads the JWT from the `Cf-Access-Jwt-Assertion` header, or from the `CF_Authorization` cookie.
- Verifies it with `jose` against `https://<team>/cdn-cgi/access/certs`, with issuer `https://<team>`, audience
  `CF_ACCESS_AUDIENCE` (or `audience`) and 60 s clock tolerance.
- Fetches `https://<team>/cdn-cgi/access/get-identity` with the JWT as the `CF_Authorization` cookie, and returns
  `{ email: identity.email, name: identity.name ?? identity.email.split("@")[0], role, subject: payload.sub }`. The
  role comes from `roleMapping` on the identity's groups, or `defaultRole` (30, Author).

`emdash` 1.3.1, [astro/middleware/auth.ts](https://unpkg.com/emdash@1.3.1/src/astro/middleware/auth.ts),
`handleExternalAuth`:

- Looks the user up by `authResult.email`. With `autoProvision` (the default) it creates a missing user, and the
  first user in an empty `users` table becomes Admin (50).
- A disabled user gets 403. Any error gets 401 "Authentication failed".
- It saves the user in EmDash's session, so public pages can show the editing toolbar.

EmDash's [authentication guide](https://docs.emdashcms.com/guides/authentication/) agrees: "In production,
Cloudflare Access is the exclusive authentication method", "The first user to access the site always becomes Admin",
and "A disabled user will be rejected even if Access allows them through." The guide doesn't mention API tokens.

### Service tokens

Cloudflare's [application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
page (last updated 2026-11-17):

- A service token's JWT carries `common_name` ("The Client ID of the service token") and `sub` ("Contains an empty
  string when authentication was through a service token"). Its example has no `email`.
- `get-identity` lists `service_token_id` and `service_token_status` among its fields. The page doesn't say what it
  returns for a service token, or that it returns an email.

What EmDash 1.3.1 then does, read in the two files above:

- The JWT itself would pass: same team, same application audience.
- `identity.email` is missing. With no `name` either, `identity.email.split` throws. With a name, the user lookup by
  an undefined email finds nothing, and creating a user with no email breaks `users.email NOT NULL`
  ([008_auth.ts](https://unpkg.com/emdash@1.3.1/src/database/migrations/008_auth.ts)). Either way the request
  gets 401.
- `access()` has no option for service tokens: its settings are `teamDomain`, `audience`, `audienceEnvVar`,
  `defaultRole`, `roleMapping`, `autoProvision`, `syncRoles` and `syncName`
  ([auth/types.ts](https://unpkg.com/emdash@1.3.1/src/auth/types.ts)).

So EmDash does not accept a service-token identity. Expected result: 401. Untested; check 2 in section 7 asserts it.

### EmDash's own tokens

Same middleware, `onRequest` and `handleBearerAuth`:

- On every `/_emdash/admin` and `/_emdash/api` route that isn't public, `Authorization: Bearer <token>` is tried first.
  `ec_pat_` is looked up in `_emdash_api_tokens`, `ec_oat_` in `_emdash_oauth_tokens`. Any other Bearer value is 401
  "Invalid or expired token".
- A valid token sets the user (a disabled or missing user makes it invalid: 401 `INVALID_TOKEN`, proven in CI) and its
  scopes. Then
  `enforceTokenScope` runs, and **session and external (Access) auth are skipped**. CSRF checks are skipped too,
  because a token is not an ambient credential.
- `/_emdash/api/mcp` is Bearer only: "Session/external auth should never be consulted for this endpoint."
- Scope rules, by path and method (first match wins; anything unmatched needs `admin`):
  - `/_emdash/api/content`: GET needs `content:read`; POST, PUT, PATCH and DELETE need `content:write`.
  - `/_emdash/api/media`: GET needs `media:read`; writes need `media:write`.
  - `/_emdash/api/admin`: everything needs `admin`, token management included.

Token format, from [@emdash-cms/auth tokens.ts](https://unpkg.com/@emdash-cms/auth@1.3.1/src/tokens.ts):

- The raw token is `ec_pat_` plus 32 random bytes in base64url without padding.
- The stored hash is base64url, without padding, of SHA-256 of the whole raw token.
- The display prefix is the first 11 characters.
- Valid scopes: `content:read`, `content:write`, `media:read`, `media:write`, `schema:read`, `schema:write`,
  `taxonomies:manage`, `menus:manage`, `settings:read`, `settings:manage`, `mcp:tools`, three transfer scopes, and
  `admin`. `admin` grants everything, and `content:write` also grants `menus:manage` and `taxonomies:manage`.
- Each scope has a lowest role that may hold it (`SCOPE_MIN_ROLE` in
  [@emdash-cms/auth rbac.ts](https://unpkg.com/@emdash-cms/auth@1.3.1/src/rbac.ts)): `content:read` and `media:read`
  Subscriber, `content:write` and `media:write` Contributor, `schema:read`, `taxonomies:manage`, `menus:manage` and
  `settings:read` Editor, and `schema:write`, `settings:manage`, `mcp:tools`, the transfer scopes and `admin` Admin.
  EmDash clamps a token's scopes to its user's role (`clampScopes`) when it issues one through the device flow or an
  OAuth code; a token written straight into the database skips that, so `starter/scripts/lib/emdash-agent.mjs`
  refuses a scope the agent's role may not hold. (Added after stage A, 2026-11-20.)

The table, from [016_api_tokens.ts](https://unpkg.com/emdash@1.3.1/src/database/migrations/016_api_tokens.ts):

- `_emdash_api_tokens` has `id`, `name`, `token_hash` (unique), `prefix`, `user_id`, `scopes` (a JSON array),
  `expires_at` (null means it never expires), `last_used_at` and `created_at`.
- A foreign key to `users` cascades on delete.
- [api/handlers/api-tokens.ts](https://unpkg.com/emdash@1.3.1/src/api/handlers/api-tokens.ts) refuses a token past
  `expires_at`, and records `last_used_at` after the response.

How a token is made:

- In the admin, by an Admin: Settings > API Tokens (the `settings/api-tokens` route in `@emdash-cms/admin` 1.3.1's
  bundle). EmDash's [MCP server reference](https://docs.emdashcms.com/reference/mcp-server/) says personal access
  tokens "use the `ec_pat_` prefix and are created in the admin". The page has no last-updated date.
- Over REST, `POST /_emdash/api/admin/api-tokens` with `{ name, scopes, expiresAt? }`. It needs an Admin user, and a
  token caller also needs the `admin` scope. The raw token is returned once
  ([route](https://unpkg.com/emdash@1.3.1/src/astro/routes/api/admin/api-tokens/index.ts)). A service token can't
  reach it, because it isn't a user.
- By writing the row directly: an id, the hash, the prefix, the user id, the scopes and an expiry. EmDash only ever
  compares hashes. This is what the plan does, through the D1 API, as each check run starts. Proven in CI with ids
  that aren't ULIDs (`fb-agent-<run>` for the user, `fb-agent-<run>-<label>` for the token).

The token's user still needs the role. Routes and MCP tools check both scope and role ("A scope never grants a
permission the user lacks", MCP reference). Role levels, from
[@emdash-cms/auth rbac.ts](https://unpkg.com/@emdash-cms/auth@1.3.1/src/rbac.ts):

| Action | Permission | Lowest role |
|---|---|---|
| Read drafts | `content:read_drafts` | Contributor (20) |
| Create a page | `content:create` | Contributor (20) |
| Edit a page someone else owns | `content:edit_any` | Editor (40) |
| Publish a page someone else owns | `content:publish_any` | Editor (40) |
| Trash your own page | `content:delete_own` | Author (30) |
| Empty the trash | `content:delete_permanent` | Admin (50) |
| Make API tokens | admin route | Admin (50) |

Seeded pages have no author, so editing and publishing them needs **Editor (40)**. The agent's user is an Editor.

### The CLI behind Access

[cli/client-factory.ts](https://unpkg.com/emdash@1.3.1/src/cli/client-factory.ts) and
[client/cf-access.ts](https://unpkg.com/emdash@1.3.1/src/client/cf-access.ts):

- The token comes from `--token`, then `EMDASH_TOKEN`, then stored credentials.
- Extra headers come from `EMDASH_HEADERS` (one `Name: Value` per line) and `--header`/`-H`, and are sent with every
  request. The file's own example is `CF-Access-Client-Id` and `CF-Access-Client-Secret`.

[cli/commands/login.ts](https://unpkg.com/emdash@1.3.1/src/cli/commands/login.ts) and
[.well-known/auth](https://unpkg.com/emdash@1.3.1/src/astro/routes/api/well-known/auth.ts):

- `emdash login` uses the OAuth device flow. In external auth mode, discovery advertises no device flow and no
  authorization code flow, only `api_tokens: true`.
- So `login` prints "Device Flow is not available for this instance. Generate an API token in Settings > API
  Tokens". In CI, use `EMDASH_TOKEN` and `EMDASH_HEADERS`, never `login`.
- EmDash's `emdash-cli` agent skill gives the same advice
  ([SKILL.md on main](https://cdn.jsdelivr.net/gh/emdash-cms/emdash@HEAD/skills/emdash-cli/SKILL.md); that is
  main, not 1.3.1). It says "Prefer environment-provided headers in CI so a service secret is not written to the
  credential file or shell history."

## 3. Which interface fits an agent

| Task | REST (`/_emdash/api`) | CLI (`npx emdash …`) | MCP (`/_emdash/api/mcp`) |
|---|---|---|---|
| Read a page | `GET /content/pages/<id or slug>`: the item and its `_rev` | `content get pages <id>` | `content_get` |
| Change a field in a section | `PUT /content/pages/<id>` with `{ data: { sections: [...] }, _rev }`: the whole `sections` array, same `_key`s, one field changed | `content update pages <id> --rev <rev> --data '…' --draft` | `content_update` with `_rev` |
| Save a draft | That same `PUT`: a change to a published page is kept as a draft until it is published | `--draft` (without it, `update` publishes) | Default: "a change to a published item is staged as a draft" |
| Publish | `POST /content/pages/<id>/publish`, optionally with `{ _rev }` ([publish route](https://unpkg.com/emdash@1.3.1/src/astro/routes/api/content/%5Bcollection%5D/%5Bid%5D/publish.ts); stage A sends the `PUT`'s) | `content publish pages <id>` | `content_publish` with `_rev` |
| Scope | `content:read`, `content:write` | the same | the same, per tool |
| Lowest role (seeded pages) | Editor | Editor | Editor (`requireRole` too) |

Sources: [content routes](https://unpkg.com/emdash@1.3.1/src/astro/routes/api/content/%5Bcollection%5D/%5Bid%5D.ts),
[content schemas](https://unpkg.com/emdash@1.3.1/src/api/schemas/content.ts),
[mcp/server.ts](https://unpkg.com/emdash@1.3.1/src/mcp/server.ts),
[routes/api/mcp.ts](https://unpkg.com/emdash@1.3.1/src/astro/routes/api/mcp.ts), and the MCP reference above.

- **For the framework's own check: REST.** It is plain `fetch` with the headers, it needs no package in the workflow,
  and each assertion is one status code.
- **For an AI agent editing a site: MCP.** Its tool descriptions explain `_rev`, drafts and locks. Its client must be
  able to send the two Access headers as well as the Bearer token (untested with any MCP client).
  - EmDash's MCP server is stateless: each `POST` gets a fresh server, so `tools/list` and `tools/call` work without
    an `initialize` on the same request (proven in CI: 72 tools listed). Stage A sends
    `Accept: application/json, text/event-stream`: "The client MUST include an Accept header, listing both
    application/json and text/event-stream" (MCP specification 2025-06-18,
    [Transports, Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
    checked 2026-11-20). Without it is untested.
  - EmDash's own tools need no `mcp:tools` scope (an Admin-only scope, for plugin tools): the content tools check
    `content:read` or `content:write` and the user's role (proven in CI for `content_get` with an Editor's token).
- **For a shell agent: the CLI.** It is REST underneath.
- A page's sections are a `blocks` field (`starter/scripts/editing.mjs` writes the collection). A hero is
  `{ "_type": "fb_hero", "_key": "hero", "headline": "…" }`, as `starter/scripts/test/editing-round-trip.mjs` writes it.

## 4. The Access side

Cloudflare's [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
page (last updated 2026-11-17):

- A request authenticates with `CF-Access-Client-Id: <CLIENT_ID>` and `CF-Access-Client-Secret: <CLIENT_SECRET>`. The
  policy must use the Service Auth action: "otherwise, Access will prompt for an identity provider login."
- **Single header:** an application can instead read the token from one header (`read_service_tokens_from_header`,
  for example `Authorization`). **Don't set it on the editor application.** EmDash needs `Authorization` for its own
  Bearer token.
- **Strict service token authentication:** for requests with service token headers, "Access ignores Allow policies
  and any `CF_Authorization` cookie", returns 401 or 403 instead of a redirect, and "does not return a
  `CF_Authorization` cookie". It is on by default for Zero Trust organizations created on or after 2026-10-05, and
  can't be turned off there.
  - So every request must carry the headers. QA already does this for previews (`docs/DECISIONS.md`, 2026-10-26).
  - The email Allow policy and a Service Auth policy can sit on the same application; each kind of request is matched
    by its own policy. The previews applications have run this way since 2026-10-26.
- **Tags** (Cloudflare One [changelog](https://developers.cloudflare.com/changelog/product/cloudflare-one/), 2026-11-02):
  - A token can carry up to five key-value tags.
  - A Service Auth policy can include `service_token_tag: { key, value }`. It matches only valid tokens with that exact
    pair, "including tokens you create later".
  - That allows a policy narrower than "any valid service token" with no long-lived token. Untested here.
- [Common policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/):
  Service Auth is `decision: "non_identity"`, and making a policy needs `Access: Apps and Policies Write`.

What the editor application would need:

- One more policy, next to its `editors` email policy: a Service Auth policy, added the way
  `scripts/site/lib/access-agent.mjs` `attachAgentPolicy` adds one to a previews application.
- That helper does a PUT with the application's own type, name, destinations and session duration. On a throwaway
  application on 2026-10-23, this kept its other policies and its audience tag, so `CF_ACCESS_AUDIENCE` stays right.
- Requests carry `CF-Access-Client-Id`, `CF-Access-Client-Secret` and `Authorization: Bearer ec_pat_…`.
- Cloudflare's [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
  page (last updated 2026-11-17) says Access adds `Cf-Access-Jwt-Assertion` to requests to the origin. EmDash never
  reads it once a Bearer token has authenticated.
- None of these pages says whether Access passes an `Authorization` header to the origin unchanged when the
  single-header option is off. That is the one Access-side assumption, and the preview check is its first test.

What a service token alone could reach on production, if the policy admitted any valid one: only EmDash's public
routes (setup, which answers 409 once done; sign-in endpoints; health; public search; media files). Everything else
would answer 401, because a service token is not an EmDash user (section 2). An Access policy for tagged tokens
narrows this further.

## 5. Testing on a preview

A preview is the right place: no live content changes, and no Access change.

- **Where `/_emdash` is protected on a preview:** a preview URL is `https://<branch>-<worker>.<subdomain>.workers.dev`.
  `create` protects it with the `<id> previews` application (destination type `preview_worker`, so the whole host,
  `/_emdash` included). That application already has the "framework-b agent" Service Auth policy (`docs/SPEC.md`,
  "Checking a preview (P6)").
- **Where its content lives:** previews bind `CMS_DB` to `<id>-cms-preview`, never `<id>-cms`
  (`scripts/site/editing-on.mjs`). One preview database serves all of a site's previews.
- **Preview databases may never have been set up.** Cloudflare's
  [Previews resources](https://developers.cloudflare.com/workers/previews/resources/) page says "the scheduler does
  not call a Preview's `scheduled()` handler today". So the hourly pages sync (`starter/editing/src/pages/fb-sync-pages.js`)
  never runs on a preview, and a preview database has pages only after someone ran EmDash's setup there.
  - The check runs that setup itself when it is missing: `POST /_emdash/api/setup` with `includeContent: true`, as the
    wizard does when the owner chooses the sample content. The endpoint is public in EmDash, so it sits behind Access
    only; in Access mode it marks setup complete
    ([setup route](https://unpkg.com/emdash@1.3.1/src/astro/routes/api/setup/index.ts)).
  - It also records `emdash:site_url` once, as the preview's host. The wizard does the same on a preview.
- **The first user becomes Admin.** EmDash makes the first user in an empty `users` table its Admin. An agent user
  left in an empty preview database would stop the owner's first sign-in there from becoming Admin. So the check
  deletes its user at the end, and on production the agent user is only ever created after an Admin exists.
- **The smallest end-to-end proof** that "an agent edited and published a page through the API", with no person, on a
  page nobody else uses:
  1. Create a draft page.
  2. Publish it.
  3. See it rendered.
  4. Change its hero headline as a draft; the rendered page doesn't change.
  5. Publish.
  6. See the new headline rendered.
  7. Trash the page.

  Editing the home page and putting it back would take two fewer calls, but every preview of the site would show the
  test headline meanwhile.

## 6. Free plan limits and costs

| Resource | What a run uses | Limit | Source (checked 2026-11-20) |
|---|---|---|---|
| Access service tokens | 1, deleted at the end (30 minutes; the API refuses less than 10, seen 2026-10-26) | 50 per account | [Account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/) (last updated 2026-11-17) |
| Zero Trust seats | 0: "use Access service tokens to allow access to applications without consuming seats" | | [Seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/) (last updated 2026-05-01) |
| Access applications and policies | None new for the preview check. Production: one reusable policy, attached to an existing application | 500 applications per account | Account limits |
| D1 | A few dozen rows written (agent user, token, page, revisions, indexes) and read; no new database | Free: 100,000 rows written and 5 million read a day; 10 databases | [Workers pricing, D1](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers requests | About 20 | Free: 100,000 a day (every request counts while Workers Cache is on, `docs/SPEC.md` section 9) | Section 9's citation |
| Cron Triggers | None | 5 per account | |

Nothing is bought or upgraded. The D1 query API the plan uses (`POST /accounts/<id>/d1/database/<uuid>/query`) is
already used live by `scripts/site/promote.mjs`, `adopt.mjs` and `newsletter.mjs`. The deploy token already has
D1: Edit, Access: Apps and Policies: Edit and Access: Service Tokens: Edit (`docs/TOKENS.md`), so no token change is
needed. Cloudflare's own D1 query API reference and D1 pricing pages could not be fetched from this session tonight;
the D1 Free limits above come from the Workers pricing page.

## 7. Plan

### Stage A: prove the EmDash half in CI (no account, no approval) (done 2026-11-20; results in section 10)

Add a starter test, `starter/scripts/test/editing-agent-api.mjs`, to the editing CI job:

- It runs with the full-site fixture, on the local Worker (`wrangler dev`), the same way `editing-round-trip.mjs` does.
- It uses the real EmDash. It applies the seed, then writes an Editor agent user and an API token into the **local**
  content database with `wrangler d1 execute --local`, using the same minting code as stage B.

It asserts:

1. `GET /_emdash/api/content/pages/home` with the token: 200, and a `_rev`.
2. `PUT` of a new hero headline as a draft: the rendered `/` still shows the old one. `POST …/publish`: `/` shows the
   new one.
3. A token with only `content:read` gets 403 `INSUFFICIENT_SCOPE` on the `PUT`.
4. An expired token gets 401. A token whose user is disabled gets 401.
5. `POST /_emdash/api/mcp` with `tools/list`, then `content_get`, works with the same token. Without a Bearer token it
   gets 401 with `WWW-Authenticate`.

Also unit-test `starter/scripts/lib/emdash-agent.mjs` (below; first planned in `scripts/site/lib/`, moved after
stage A): its token and hash must equal what the installed EmDash's own `hashPrefixedToken` gives for the same
input. That way an EmDash update that changes the format fails CI, not a live run.

### Stage B: the preview check (live; no Access change)

New files in framework-b:

- `starter/scripts/lib/emdash-agent.mjs` (built in stage A as pure statement builders, `{ sql, params }`:
  `mintAgent`, `agentToken`, `setAgentDisabled`, `revokeAgent`, `sweepAgents`, and `inlineSql` for
  `wrangler d1 execute`. It is in the starter, not `scripts/site/lib/` as first planned, so no starter file imports
  from outside `starter/`; stage B imports it with `join(FRAMEWORK, "starter/scripts/lib/emdash-agent.mjs")`, as the
  ops scripts import `jsonc.mjs`. A token lives at most 120 minutes. Stage B sends the same statements to the D1
  query API; the wrappers below are what it adds):
  - `mintAgentToken(A, dbUuid, { role: 40, scopes, minutes: 30 })` makes the raw token in memory, writes the user
    (`fb-agent-<run>`, email `agent-<run>@framework-b.invalid`, name "Framework B agent", role 40) and the token row
    (name "framework-b agent check `<run>`", `expires_at` 30 minutes ahead) with the D1 query API and bound parameters.
    `.invalid` is reserved (RFC 2606), so the address can't be anyone's Access identity.
  - `revokeAgent(A, dbUuid, run)` deletes the token row, then the user.
  - `sweepAgents(A, dbUuid)` removes rows from crashed runs older than 60 minutes, as `sweepCheckTokens` does for
    service tokens. It matches only per-run rows: an id starting `fb-agent-` and an `agent-<run>@framework-b.invalid`
    address.
- `scripts/site/agent-edit-check.mjs --site <checkout> --site-id <id> --branch <branch> [--report <file.md>]`.
- `.github/workflows/site-agent-edit-check.yml` (reusable), shaped like `site-preview-check.yml`.
  - Inputs: `framework_repo`, `framework_ref`, `site_id`, `branch`.
  - Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_BUILDS_TOKEN`, `GH_SITES_TOKEN`.
- Its caller in `ops/ops-repo/.github/workflows/` (the ops workflow "site agent edit check"), a README row, and
  `docs/SPEC.md` section 9.
- Then `node scripts/docs-check.mjs --ops <ops clone>` keeps the owner's copy in step.

What the script does, in order:

1. **Refuses** unless editing is on in `site.config.json`, the previews' `CMS_DB` in `wrangler.jsonc` is
   `<id>-cms-preview`, and that database is not the production `<id>-cms`. It looks the database's id up by name.
2. **Previews application:** `ensureAgentPolicy` and `attachAgentPolicy`, as the preview check does. They are already
   there, so this changes nothing.
3. **Preview URL:** waits for the branch's build, and reads the URL from its log (`scripts/site/lib/builds.mjs`).
4. **Service token:** sweeps stale check tokens, then mints a 30-minute one (`mintCheckToken`) and waits until Access
   accepts it (`waitForToken`). It warms `/`, because EmDash's first request on a fresh database can take over a
   minute.
5. **Setup if needed:** `GET /_emdash/api/setup/status`. If setup isn't complete, it posts `/_emdash/api/setup` with
   the site's name, its tagline and `includeContent: true`, repeating until `seedComplete`. The report says so.
6. **Check 1 (Access still gates):** a request with only an API token, and no service token headers, is refused by
   Access (302 to the login, or 401/403).
7. **Check 2 (no service-token identity):** `GET /_emdash/api/content/pages` with only the service token headers
   gets 401 from EmDash. This answers the roadmap's question live.
8. **Agent:** `sweepAgents`, then `mintAgentToken` with `content:read` and `content:write`. The raw token is masked in
   the log (`::add-mask::`), never written to a file, and sent only to the preview's own origin.
9. **Check 3 (the edit), with both credentials** on `/_emdash/api/content/pages`:
   1. `POST` a draft page `fb-agent-check-<run>` whose hero headline is "Agent check A".
   2. `POST …/publish`. `/fb-agent-check-<run>` on the preview shows "A".
   3. `GET` the item, for its `_rev`.
   4. `PUT` the headline "Agent check B" as a draft. The page still shows "A".
   5. `POST …/publish`. The page shows "B" (EmDash invalidates the cached page when content is published; a first
      response showing "A" is retried for up to 30 s).
   6. MCP `content_get` returns "B".
   7. `DELETE` (trash). The page answers 404.
10. **Always, at the end:** `revokeAgent`, then `deleteCheckToken`. The report lists every check, with its status
    codes and timings.

What it makes and deletes:

| Made | Where | Lives | Deleted by |
|---|---|---|---|
| An Access service token | Account | 30 minutes | The run, or the next run's sweep |
| An agent user (Editor) and its API token | `<id>-cms-preview` | 30 minutes | The run, or the next run's sweep |
| A test page | `<id>-cms-preview` | Trashed at the end | Stays in the preview admin's trash. Emptying the trash needs Admin, and the agent is an Editor on purpose; the owner can empty it |
| EmDash setup, when the preview database had none | `<id>-cms-preview` | Stays | Kept: it is what the owner's first preview sign-in would do |

It changes no production resource, no Access application or policy, and no secret.

### Stage C: production (later; waits for the owner)

What changes:

- **Access:** a reusable Service Auth policy "framework-b editor agent" (`decision: non_identity`, include
  `service_token_tag: { key: "framework-b", value: "editor-agent" }`) is attached to `<id> editor` next to its
  `editors` email policy, with `attachAgentPolicy`.
  - With the tag, the preview check's untagged tokens can't reach the editor, and the agent's tagged tokens can.
  - If tags don't work in practice, the fallback is the existing "framework-b agent" policy (any valid service token).
    Section 4 says what that exposes.
- **Content database:** one persistent agent user in `<id>-cms`: role Editor, email `agent@framework-b.invalid`,
  `disabled = 1` between runs.
  - It must never be sweepable: the sweep matches only per-run addresses (`agent-<run>@framework-b.invalid`), and
    `agent@` is not one (the unit test keeps such a user through a sweep). Its tokens are deleted by each run, not
    by the sweep.
  - It is created only if an Admin already exists, so the owner stays the first Admin.
  - Its edits show in the revision history under "Framework B agent".

Each run:

1. Mint a tagged 30-minute service token.
2. Enable the agent user, and mint a 30-minute API token for it.
3. Make the change.
4. Delete the API token, disable the user, and delete the service token.

The workflow that carries a change to a live site's copy, and who approves that change, is designed when the owner
wants it. A copy change on a live site is the owner's call.

### What the owner must approve

- **Before stage B's first live run (a new kind of credential, preview only):**
  - The run writes an EmDash agent user and a 30-minute EmDash API token into a site's **preview** content database,
    and deletes both at the end.
  - If that database was never set up, the run sets it up with the site's sample content.
  - It mints and deletes a 30-minute Access service token, exactly as the preview check already does.
  - It makes **no** Access application or policy change.
- **Before stage C (an access change on production):**
  - Adding a Service Auth policy to the `<id> editor` Access application.
  - Creating the persistent agent user in the production content database.
  - Minting tagged service tokens that this policy admits, one per run.

## 8. Alternatives set aside

| Alternative | Why not |
|---|---|
| A service token as the identity: a Framework B auth provider in front of `access()` that maps the JWT's `common_name` to an agent user | Each run's token has a new client ID, so the Worker would need a new allowlist secret each time. It also adds a framework-owned auth module to a vendored EmDash setup |
| A long-lived API token, made by the owner in Settings > API Tokens and stored as an ops secret | Needs a person, and leaves a long-lived secret to rotate, against `docs/DECISIONS.md` 2026-10-26 (no long-lived secret) |
| `emdash login` | No device flow in Access mode (section 2) |
| A site route that mints tokens | A new attack surface on every editing site; the ops repo can already reach D1 |

## 9. Proven, untested, not verified

- **Proven earlier in this account:**
  - A minted service token with the "framework-b agent" Service Auth policy on a previews application, next to the
    email policy (2026-10-26).
  - The application PUT that keeps an application's policies and audience (2026-10-23).
  - The D1 query API, in `promote`, `adopt` and `newsletter`.
  - EmDash invalidating cached pages when an editor publishes in the admin (2026-10-27).
- **Proven in CI, 2026-11-20 (stage A, section 10):**
  - EmDash taking an API token written straight into its database.
  - The Bearer token being checked before EmDash's own Access check.
  - Scope checks; an Editor editing and publishing a seeded page; expired tokens and disabled users refused.
  - MCP with a Bearer token, and its 401 without one.
- **Read in source or docs, untested:**
  - EmDash refusing a service-token identity.
  - Roles below Editor being refused on seeded pages.
  - Publishing through the API invalidating the cache (the local Worker serves no cache: a change written straight
    into the database shows on the next request).
  - MCP through Access with custom headers.
  - The tag-based policy.
- **Not verified tonight:**
  - Whether Access passes `Authorization` to the origin unchanged. No page says so; check 3 tests it.
  - What `get-identity` returns for a service token. Either way EmDash gets no email.
  - EmDash's GitHub source at a tag (the npm package source on unpkg was used instead).
  - Cloudflare's D1 query API reference and D1 pricing pages (fetches blocked in this session).

## 10. Stage A results (CI, 2026-11-20)

`starter/scripts/test/editing-agent-api.mjs` runs in the starter tests' editing job (`.github/workflows/starter-test.yml`),
before the round trip switches editing off. It builds the full-site fixture with editing on, starts the local Worker,
brings the seed's pages into the local content database with EmDash's CLI, and writes agent users and tokens with
`wrangler d1 execute --local` from `starter/scripts/lib/emdash-agent.mjs`. Every assertion of section 7's stage A passed
on the real EmDash 1.3.1:

| Check | Result |
|---|---|
| `GET /_emdash/api/content/pages/home`, Editor's `content:read` + `content:write` token | 200, `data._rev` and `data.item` |
| The same with a bad `Cf-Access-Jwt-Assertion` header; then that header alone; then nothing | 200; 401; 401 |
| `PUT /content/pages/<id>` with `{ data: { sections }, _rev }` (the hero's headline changed), no `X-EmDash-Request` | 200: `item.status` stays `published`, `item.draftRevisionId` is set; EmDash's live row and the rendered `/` keep the old headline; `GET` shows the draft to the Editor |
| `POST /content/pages/<id>/publish` with the `PUT`'s `_rev` | 200; `/` shows the new headline |
| `content:read`-only token: `GET`, then the `PUT` | 200; 403 `INSUFFICIENT_SCOPE` |
| Expired token, disabled user's token, unknown `ec_pat_` token | 401 `INVALID_TOKEN` each |
| MCP `initialize`, `tools/list`, `tools/call content_get` with the token | 200 each; 72 tools including `content_get`, `content_update`, `content_publish`; `content_get` returns the new headline and a `_rev` |
| MCP `tools/list` without a Bearer token | 401, `WWW-Authenticate: Bearer resource_metadata="…"` |
| Sweep (an agent made 2 hours earlier), then revoke | The older agent's token 401, the current one 200; after revoking, 401 and no agent rows left |

`scripts/site/test/emdash-agent.test.mjs` (site scripts tests) compares the lib with the installed
`@emdash-cms/auth`, at the version the pinned `emdash` depends on: the token's encoding, its hash for the same input
(`hashPrefixedToken`), the hash and display prefix of tokens EmDash makes itself (`generatePrefixedToken`), the role
levels, and the scopes each role may hold (`scopesForRole`). CI installs only that package (about 11 MB, a few
seconds, without its Astro peer).

Where the real EmDash differed from this document: nowhere on the points asserted. What this document changed after
stage A, each marked where it is:

- Section 2: the scope-to-role table, and that a token written into the database skips EmDash's clamping, so the lib
  refuses a scope the role may not hold. `mcp:tools` is Admin-only, and EmDash's own MCP tools don't need it.
- Section 2: ids that aren't ULIDs work for the agent user and its token.
- Section 3: publish takes an optional `_rev`; MCP is stateless, needs no `initialize` per request, and is sent
  `Accept: application/json, text/event-stream`, as the MCP specification's Streamable HTTP transport requires (cited
  there).
- Section 7, stage B: the lib's functions are statement builders; stage B's wrappers send them to the D1 API. The
  lib moved to `starter/scripts/lib/`, a token lives at most 120 minutes, and the sweep matches only per-run
  addresses.
- Section 7, stage C: the persistent agent user must never be sweepable.
- Section 9: what stage A proved, and why the cache purge on an API publish is still untested (the local Worker
  serves no cache).
