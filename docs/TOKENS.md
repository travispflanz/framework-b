# Tokens and permissions

Five Cloudflare credentials, each with the least access it needs. The token builder labels write access **Edit**; the [API permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) calls the same thing **Write**.

"Verified" means a call needing this permission succeeded on a live build (October 2026). "Unverified" means it is listed in Cloudflare's docs but no build has exercised it yet.

How to create a Cloudflare token: an **account** token at **Manage Account → API Tokens** ([direct link](https://dash.cloudflare.com/?to=/:account/api-tokens)), a **user** token at **My Profile → API Tokens**; then **Create Token**, choose the custom token instead of a template, add the permissions, choose the account (and zones), **Continue to summary**, **Create Token** ([Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/), checked 2026-10-27). Scope it to your one account (and, for zone permissions, the zones your launch sites use), and paste the value straight into the ops repo secret: it is shown only once.

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
| Access: Service Tokens: Edit | **site preview check** mints a 30-minute service token for each run and deletes it at the end, so QA can open Access-protected previews ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), checked 2026-10-23: creating, refreshing and deleting need `Access: Service Tokens Write`) | Verified 2026-10-26. Only the ops repo's copy needs it. Without it the create call returned `auth.forbidden` (2026-10-23) |
| Access: Organizations, Identity Providers, and Groups: Edit | Read or create the one-time PIN login method | Verified |
| Account Analytics: Edit | Create Web Analytics sites | Verified |
| Workers KV Storage: Edit | EmDash session storage (only for sites with client editing); `create` makes the namespaces | Required for client editing. Checked by the ops repo's `verify secrets` workflow |
| Email Sending: Edit | Cloudflare Email Sending (only on Workers Paid). Not used: leave it out | Not needed |

### Zone permissions (launch-mode zones only)

| Permission | Used for | Status |
|---|---|---|
| Zone: Read | Find zone IDs | Verified |
| DNS: Edit | Resend records, verification records | Verified |
| Workers Routes: Edit | Custom domains (promote attaches the domain through the Workers domains API) | Verified |
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

It's stored once as the ops repo secret `D1_BACKUP_TOKEN`. The **deploy backup worker** workflow copies it into the Worker as a secret. Status: verified; the scheduled runs export every database in the account (7 of 7 on the run of 2026-10-25, read from its `/status` on 2026-10-27).

The deploy token (section 1) also deploys this Worker and its Workflow, and creates the `framework-backups` bucket and its expiry rule. Verified: Workers Scripts: Edit and Workers R2 Storage: Edit cover both (deployed 2026-10-23).

## Resend admin key (ops repo only)

One **full-access** Resend API key, stored only as the ops repo secret `RESEND_ADMIN_KEY`. Resend keys are either full access or sending only ([API keys](https://resend.com/docs/api-reference/api-keys/create-api-key), checked 2026-10-27), and adding a domain, managing contacts and sending broadcasts all need full access. Promote uses it to add `mail.<domain>` and create a sending-only key restricted to that domain, which becomes the Worker secret `RESEND_API_KEY`; the newsletter module uses it for contacts and broadcasts. Workers never get it. Rotate it in Resend (https://resend.com/api-keys) and update the secret. Status: verified 2026-10-27 (two promotes set up `mail.<domain>` and per-site keys; a newsletter test and a broadcast were sent with it).

## Per-site Worker secrets for the CRM webhook

Only for a site with `"crm": { "webhook": true }`: `CRM_WEBHOOK_URL` (where leads are POSTed) and optionally `CRM_WEBHOOK_SECRET` (signs each body). Set them with `wrangler secret put` on the site's Worker; they are listed by name in the site's `SECRETS.md`.

## 4. Registrar token (only when buying a domain)

Created by the owner when a purchase is approved, used once, then deleted.

## 5. Workers AI token (only for generated images)

Used by `scripts/generate-image.mjs` to make images with Workers AI, from the ops repo's **site images** workflow (or an agent's own environment). Unlike the deploy token it can't change anything in the account: it can only run models.

- Account → Workers AI → Read, and Account → Workers AI → Edit. Nothing else. The Workers AI page has a ready-made template: **Workers AI → Use REST API → Create a Workers AI API Token** ([REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), checked 2026-10-28: "that token will need permissions for both `Workers AI - Read` and `Workers AI - Edit`").
- Store it as the ops repo secret `WORKERS_AI_TOKEN`; the **site images** workflow uses it (`draft`, then `use`), so no agent ever holds it. For faster drafting, an agent can also run the script itself: in a Claude cloud session, add it as a network secret on the session's cloud environment (**Edit cloud environment → Network secrets → Add secret**: type Bearer, allowed website `api.cloudflare.com`, header `Authorization` with prefix `Bearer`); Anthropic's proxy adds it to requests for that host only ([Cloud environments](https://code.claude.com/docs/en/cloud-environments#add-network-secrets), checked 2026-10-28). Any other agent gets it as the environment variable `WORKERS_AI_TOKEN`. Either way the agent also needs the account id (`CLOUDFLARE_ACCOUNT_ID` or `--account`), which isn't secret.
- Cost: Workers AI includes 10,000 neurons a day on both plans. On Workers Free, a request over that fails; on Workers Paid it is billed at $0.011 per 1,000 neurons ([Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), checked 2026-10-28). A 1536×1024 image from FLUX.2 [klein] 4B costs about 156 neurons (26.05 per 512×512 output tile), so the free allowance covers roughly 60 a day.
- Status: unverified. No build has generated an image with it yet.

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
| Workers AI token | Ops repo secret `WORKERS_AI_TOKEN` for **site images**; optionally a network secret on an agent's cloud environment (section 5) | Runs image models only; never stored in a repo or a Worker |
| Resend full-access key | Ops repo secret `RESEND_ADMIN_KEY` (above) | Creates each launch site's sending domain and domain-restricted key; newsletter contacts and broadcasts. Can be deleted between uses |
| Resend sending key | Worker secret `RESEND_API_KEY` | Restricted to one sending domain |
| Apps Script mailer secret | Worker secret `MAILER_SECRET` and the script's properties | Only Framework B Workers can call the mailer |
| UptimeRobot main API key | Ops repo secret `UPTIMEROBOT_API_KEY` | `create` adds each site's two monitors, `teardown` deletes them, and the self-test checks them. Must be the account's main key: monitor-specific and read-only keys cannot create monitors ([v3 API](https://uptimerobot.com/api/v3/), checked 2026-10-23) |
| GitHub access for the agent | Claude GitHub app (cloud Claude sessions), or a fine-grained token / signed-in `gh` CLI for any other agent, limited to `framework-b`, the ops repo and the site repos | It needs to clone, push branches, open pull requests and dispatch the ops workflows (Actions: write on the ops repo) |

Agents don't need the Cloudflare deploy token: every change to the account runs as an ops workflow, which holds the secrets. The only Cloudflare credential an agent may hold is the Workers AI token (section 5), for generated images. An agent that wants to read the account for diagnostics can be given a separate read-only token. Values never go in a repo.
