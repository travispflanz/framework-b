# Tokens and permissions

Three Cloudflare credentials, each with the least access it needs. The token builder labels write access **Edit**; the [API permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) calls the same thing **Write**.

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
| Access: Apps and Policies: Edit | `/admin` login and preview protection | Verified |
| Access: Organizations, Identity Providers, and Groups: Edit | Read or create the one-time PIN login method | Verified |
| Account Analytics: Edit | Create Web Analytics sites | Verified |
| Workers KV Storage: Edit | EmDash object cache (only if EmDash is used) | Unverified |
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

## 3. Registrar token (only when buying a domain)

Created by the owner when a purchase is approved, used once, then deleted.

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
| UptimeRobot API key | Agent environment | Creates monitors |
| GitHub access | Claude GitHub app (cloud sessions) or a fine-grained token (Hermes), limited to selected repos | |

Each agent environment (Hermes host, cloud session) holds its own copy of the deploy token, listed by name in each site's `SECRETS.md`. Values never go in a repo.
