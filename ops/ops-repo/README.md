# Ops repo template

Your **private** ops repo holds every secret and runs every workflow that changes your Cloudflare account or creates
site repos. `framework-b` is public, and so are its Actions logs, so anything that names a site, an idea or an inbox
runs in the private ops repo instead.

The ops repo contains only thin caller workflows (this folder's `.github/workflows/`). Each one calls a reusable
workflow in `framework-b`, at a branch or tag you choose with its `framework_ref` input (default `main`).

## Set it up (once)

1. Create a **private** GitHub repo, for example `framework-b-ops`.
2. Copy this folder's `.github/workflows/` into it. In every file, replace `OWNER` with the GitHub account that owns
   `framework-b` (your fork, or the original). In `site-selftest.yml`, also replace `owner@example.com` with the inbox
   that should own the self-test sites.
3. Add the secrets below (GitHub → the repo → **Settings → Secrets and variables → Actions → New repository secret**).
   How to create each Cloudflare and GitHub token: `docs/TOKENS.md`.
4. Run **verify secrets** (Actions → verify secrets → Run workflow). Every check should say `true` or `HTTP 200`; an optional secret you skipped says `not set`.
5. Run **deploy backup worker** once. It backs up every D1 database in the account every Monday.

## Secrets

| Secret | Needed for | What it is |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | everything | Deploy token (`docs/TOKENS.md` section 1) |
| `CLOUDFLARE_ACCOUNT_ID` | everything | Your Cloudflare account ID (dashboard → **Workers & Pages** → **Account Details** → copy **Account ID**; [Cloudflare's guide](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/), checked 2026-10-27) |
| `CF_BUILDS_TOKEN` | create, connect builds, preview check, park, teardown, selftest | Workers Builds user token (`docs/TOKENS.md` section 2) |
| `GH_SITES_TOKEN` | create, update, promote, newsletter, … | GitHub fine-grained token that creates site repos and opens pull requests in them (`docs/TOKENS.md`, GitHub section) |
| `D1_BACKUP_TOKEN` | deploy backup worker | D1 Edit only (`docs/TOKENS.md` section 3) |
| `MAILER_URL`, `MAILER_SECRET` | optional: owner notifications on idea sites, the CRM Google Sheet | The Apps Script mailer's web app URL and secret (`ops/apps-script-mailer/README.md`) |
| `UPTIMEROBOT_API_KEY` | optional: uptime monitors for every site | UptimeRobot **main** API key (free plan) |
| `RESEND_ADMIN_KEY` | optional: launch sites' auto-replies, newsletter and drips | A full-access Resend key (`docs/TOKENS.md`, Resend section) |
| `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET` | optional, rarely | Only to resend old leads to one site's CRM webhook with **site crm sync**; the live copy uses the site's own Worker secrets |

Without an optional secret, the matching feature is skipped and the run says so.

## Workflows

Run any of them from GitHub → the ops repo → **Actions** → the workflow → **Run workflow**, or from an agent session
with `gh workflow run "<name>" -R <you>/<ops repo> -f site_id=...`.

| Workflow | Inputs | What it does |
|---|---|---|
| **verify secrets** | none | Checks every secret works (pass or fail; never prints a value) |
| **deploy backup worker** | none (also runs monthly) | Deploys the account-wide backup Worker |
| **site create** | `brief` (the kickoff brief JSON), or `site_id`, `site_name`, `site_tagline`, `owner_email`, `editing`, `indexing` | Makes a new idea site: Worker, data, spam check, logins, private repo `site-<id>`, Workers Builds, monitors |
| **site connect builds** | `site_id` | Retries just the Workers Builds connection, if `site create` couldn't make it |
| **site preview check** | `site_id`, `branch` | Runs the QA gate on a branch's preview (through Access) and posts the result on its pull request |
| **site update** | `site_id`, `base` (only for very old sites) | Brings a site up to the current framework on a branch, tests it, opens a pull request |
| **site mailer** | `site_id`, `check_only` | Connects a site made before the mailer existed; `check_only: yes` just sends a test notification |
| **site promote** | `site_id`, `domain`, `phase` (`prepare` then `finish`), `postal_address`, `dry_run` | Moves an idea site to its own domain (launch mode). Merge the pull request `prepare` opens before `finish` |
| **site newsletter** | `site_id`, `issue`, `mode` (`test` or `send`), `to`, `site_ref`, `force` | Test-sends a newsletter issue (also from a draft branch), or sends it to every subscriber (launch sites) |
| **site crm sync** | `site_id`, `days` | Copies a site's leads to its CRM mirror (Google Sheet, webhook); safe to rerun |
| **site editing** | `site_id`, `mode` (`off`) | Switches client editing off and brings the content back into files, as a pull request |
| **site snapshot** | `worker`, `zone`, `repo` | Read-only copy of everything needed to restore any Worker and its zone |
| **site park** | `worker`, `zone`, `action` (`park` or `undo`) | Takes any Worker off its domain without deleting anything, or puts it back. Snapshot first |
| **site teardown** | `site_id`, `confirm` (`delete <site_id>`), `delete_repo` | Exports a site's data to backups, then deletes it and archives its repo |
| **site selftest** | none (also runs weekly) | Creates a throwaway site, tests it live end to end, and tears it down |

Most workflows also take `framework_ref` (a `framework-b` branch or tag; default `main`). Pin it to a release tag,
such as `v1.0.0`, to stay on a tested version.
