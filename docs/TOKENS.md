# Tokens and permissions

Four Cloudflare credentials, each with the least access it needs. The token builder labels write access **Edit**; the [API permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) calls the same thing **Write**.

"Verified" means a call needing this permission succeeded on the first live build (October 2026). "Unverified" means it is listed in Cloudflare's docs but no build has exercised it yet.

## 1. Deploy token (account-owned or user-owned API token)

Used by the builder agent for everything except Workers Builds. Scope it to the one account and, for zone permissions, to the zones Framework B sites use.

### Account permissions

| Permission | Used for | Status |
|---|---|---|
| Workers Scripts: Edit | Deploy Workers, enable `workers.dev` and preview URLs | Verified |
| D1: Edit | Create databases, run migrations, read leads | Verified |
| Workers R2 Storage: Edit | Upload and backup buckets, CORS | Verified |
| Turnstile Sites: Edit | Create the widget and add hostnames | Verified |
| Email Routing Addresses: Edit | Destination addresses (verification click is still human) | Verified |
| Access: Apps and Policies: Edit | `/admin` login and preview protection; the reusable `framework-b agent` Service Auth policy on each site's previews application | Verified |
| Access: Service Tokens: Edit | Create and yearly refresh of the one `framework-b agent` service token, which lets QA open Access-protected previews ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), checked 2026-10-23: creating, refreshing and deleting need `Access: Service Tokens Write`) | Verified 2026-10-26 (ops copy). Only the ops repo's copy needs it: preview checks run there. Without it the create call returned `auth.forbidden` (2026-10-23) |
| Access: Organizations, Identity Providers, and Groups: Edit | Read or create the one-time PIN login method | Verified |
| Account Analytics: Edit | Create Web Analytics sites | Verified |
| Workers KV Storage: Edit | EmDash session storage (only for sites with client editing); `create` makes the namespaces | Required for client editing. Checked by the ops repo's `verify secrets` workflow |
| Email Sending: Edit | Cloudflare Email Sending (only on Workers Paid) | Unverified |

### Zone permissions (launch-mode zones only)

| Permission | Used for | Status |
|---|---|---|
| Zone: Read | Find zone IDs | Verified |
| DNS: Edit | Resend records, verification records | Verified |
| Workers Routes: Edit | Custom domains | Verified |
| Zone Settings: Edit | Always Use HTTPS, minimum TLS | Verified |
| Single Redirect: Edit | `www` → apex rule | Verified |
| Email Routing Rules: Edit | `hello@` forwarding | Verified |
| Analytics: Read | Email Routing logs over GraphQL (`emailRoutingAdaptive`) | Verified |

### Never in the deploy token

- **Registrar** permissions. Domain purchases use a separate token, created only when a purchase is approved.
- Anything not listed above. In particular, "Cloudflare One Connector: cloudflared" and "Bulk URL Redirects" are not used by Framework B.

## 2. Workers Builds token (user-owned API token)

The Builds API rejects account-owned tokens. It needs a **user** token with:

- Workers Builds Configuration: Edit (shown as "Workers CI Write" in the API reference)
- Workers Scripts: Read

Status: verified.

## 3. D1 backup token (account-owned API token)

Used only by the `framework-backups` Worker (`ops/backup-worker`) to call D1's export API for every database in the account.

- Account → D1 → Edit. Nothing else.

It's stored once as the `D1_BACKUP_TOKEN` repository secret in `framework-b`. The deploy workflow copies it into the Worker as a secret. Status: unverified until the first scheduled run.

The deploy token (section 1) also deploys this Worker and its Workflow, and creates the `framework-backups` bucket and its expiry rule. Whether Workers Scripts: Edit and Workers R2 Storage: Edit cover the Workflow and the lifecycle rule is unverified until the first deploy.

## 4. Registrar token (only when buying a domain)

Created by the owner when a purchase is approved, used once, then deleted.

## GitHub: site repo token (fine-grained personal access token)

Lets the ops repo create each site's private repo and push the starter into it, and lets `site update` open a pull request in it.

- Resource owner: the owner's account. Repository access: **All repositories**, because the token has to reach repos that don't exist yet.
- Permissions:
  - Administration: Read and write (create repositories)
  - Contents: Read and write (push the starter and update branches)
  - Workflows: Read and write (push files under `.github/workflows/`)
  - Pull requests: Read and write (`site update` opens a pull request in the site repo)
  - Metadata: Read (added automatically)
- Expiration: up to 1 year. Rotate it, then update the `GH_SITES_TOKEN` secret in the ops repo.
- To add a permission later: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → the token. If GitHub only offers "Regenerate token", update the `GH_SITES_TOKEN` secret with the new value. Whether the value stays the same after an edit is untested.

Sources:
- [Permissions required for fine-grained tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) (`POST /user/repos` needs Administration write; contents and workflow files need Contents and Workflows write), checked 2026-10-22. Site repos have been created with it since then.
- [Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request) needs "Pull requests" repository permissions (write), checked 2026-10-23. Without it, the first live `site update` pushed its branch but got HTTP 403 on the pull request.

## Where secrets live

In the owner's **private** ops repo, never in `framework-b`. `framework-b` is public, so its Actions logs are public, and a run that names a site or an inbox would leak it. See `ops/ops-repo/README.md`.

## Settings no token can reach

These are dashboard-only or third-party. The agent lists them with direct links, and the owner confirms them; they are recorded as owner-attested in each site's `HANDOFF.md`:

- Crawler Hints (API tokens are rejected with `10405`)
- Registrar auto-renew (deliberately outside the deploy token)
- Two-factor authentication on Cloudflare and GitHub
- Search Console sitemap submission and the Bing Webmaster import

## Other credentials

| Credential | Where it lives | Notes |
|---|---|---|
| Resend full-access key | Created by the owner for setup, used once, then deleted | Creates the sending domain and a domain-restricted sending key |
| Resend sending key | Worker secret `RESEND_API_KEY` | Restricted to one sending domain |
| Apps Script mailer secret | Worker secret `MAILER_SECRET` and the script's properties | Only Framework B Workers can call the mailer |
| UptimeRobot main API key | Ops repo secret `UPTIMEROBOT_API_KEY` | `create` adds each site's two monitors, `teardown` deletes them, and the self-test checks them. Must be the account's main key: monitor-specific and read-only keys cannot create monitors ([v3 API](https://uptimerobot.com/api/v3/), checked 2026-10-23) |
| GitHub access | Claude GitHub app (cloud sessions) or a fine-grained token (Hermes), limited to selected repos | |

Each agent environment (Hermes host, cloud session) holds its own copy of the deploy token, listed by name in each site's `SECRETS.md`. Values never go in a repo.
