# Framework B specification

How an AI agent builds, launches and hands off a website with this framework, and the evidence for each part. Written 2026-10-22, current as of v1.0.0 (2026-10-27). Vendor facts carry the date they were checked. The design phase (P2) follows `docs/research/design-layer.md`, approved by the owner on 2026-10-22. For a human overview, read `README.md` first.

## 1. What a Framework B site is

- **Pages:** Astro 7, mostly static, served as Workers static assets.
- **Runtime:** one Cloudflare Worker per site, built from `packages/core`. It handles:
  - form submissions and file uploads
  - `/api/health`
  - `/u` unsubscribe
  - `/admin` behind Cloudflare Access
- **Data:** D1 is the system of record for leads and subscribers. R2 holds uploads and backups.
- **Protection:** Turnstile on every form, a honeypot field, an origin check, size limits, a per-IP rate limit (Workers rate limiting binding; it deploys on the Free plan, but whether it limits there is untested), and Access on `/admin` and previews. The Worker also verifies the Access JWT itself.
- **Deploys:** Workers Builds. A push to `main` deploys production; any other branch deploys a preview URL.
- **State:** each site has its own repo holding `site.config.json`, `DESIGN.md`, `DECISIONS.md`, `HANDOFF.md` and `SECRETS.md` (names only). Any agent can resume a site from its repo.
- **Owner's machine:** nothing a site needs runs there.

## 2. Modes

| | Idea | Launch |
|---|---|---|
| Address | `<site>.<account>.workers.dev` | Own domain; `www` → apex via a Single Redirect rule |
| D1 | Shared `fb-ideas` database, `site` column (previews: `fb-previews`) | Own `<id>-prod` + `<id>-staging` databases |
| R2 uploads | Shared `fb-ideas-uploads`, prefix `<site>/` (previews: `fb-previews`) | Own `<id>-uploads` bucket |
| Owner notification | Apps Script mailer (owner's Gmail) | Cloudflare `send_email` from `notify@<domain>` when the site owns the whole zone; otherwise the Apps Script mailer |
| Lead auto-reply | Optional, Apps Script mailer | Resend on `mail.<domain>` |
| Newsletter / drips | Test sends only; forms already collect subscribers | Optional modules; Resend on `mail.<domain>` |
| Indexing | Owner's choice, default `noindex` | Indexed; Search Console + Bing; the `workers.dev` twin is `noindex` |
| EmDash | Optional; its own D1, R2 bucket, KV namespace and Cron Trigger | Optional |
| Access | `/admin` and previews | `/admin` and previews |
| Backups | Account-wide backup Worker | Same |

Why ideas share resources: the Workers Free plan allows 10 D1 databases and 5 Cron Triggers per account ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), checked 2026-10-21).

`promote` moves an idea to launch mode (`scripts/site/promote.mjs`, run by the ops repo's `site promote` workflow; run live on a one-level subdomain and on a whole zone, 2026-10-27). It takes a domain that is an active zone in the account, or a one-level subdomain of one (Universal SSL covers one level), and a postal address (CAN-SPAM). On a subdomain of a zone the owner uses for other things, promote leaves that zone's settings, mail and `www` alone.

- **prepare**, before a pull request in the site's repo:
  1. Checks: the site is in idea mode; the zone is active; the owner's inbox is a verified Email Routing destination; the D1 budget has room for two more databases (Free plan: 10 per account, so each launch site uses 2 of them).
  2. Zone: Always Use HTTPS, TLS 1.2 minimum, Email Routing on, a proxied `www` record and a `www` → apex Single Redirect (301, path and query kept).
  3. Data: `<id>-prod` and `<id>-staging` databases with migrations; the site's leads and subscribers copied from `fb-ideas` with `INSERT OR IGNORE`; an `<id>-uploads` bucket with every stored upload the leads point at. The idea-mode rows stay in `fb-ideas` until the owner approves deleting them.
  4. Mail: when the site owns the whole zone and its apex has no other mail provider, owner notifications go out through the `send_email` binding from `notify@<domain>` to the verified inbox, which is free on Workers Free ([Email Service](https://developers.cloudflare.com/email-service/), checked 2026-10-27). With the owner's full-access Resend key (the ops secret `RESEND_ADMIN_KEY`), it also sets up `mail.<domain>` in Resend (domain, DNS records, verification) and stores a sending-only key restricted to that domain as the Worker secret `RESEND_API_KEY`; lead auto-replies then come from `hello@mail.<domain>`. Without the key, auto-replies stay off. Otherwise (a subdomain, or an apex that already receives mail elsewhere, because Email Routing would take over its MX records) notifications keep going through the account's Apps Script mailer.
  5. Access and Turnstile: the domain's `/admin` (and `/_emdash` with editing on) join the existing Access applications, which keeps their audience tags; the domain joins the site's Turnstile widget.
  6. The domain becomes a Custom Domain of the Worker through the API ([Workers domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/), checked 2026-10-27). The deploy token needs Workers Routes for the zone; later Workers Builds deploys keep the same route, which needs no zone permission ([Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/), checked 2026-10-27).
  7. Files: `site.config.json` (launch mode, canonical host, postal address, indexing on, mailers) and `wrangler.jsonc` (Custom Domain route, own databases and bucket, `send_email` bound to the owner's inbox), plus `DECISIONS.md` and `HANDOFF.md` with the owner checklist.
- **finish**, after the owner merges and Workers Builds deploys: copies anything that reached `fb-ideas` in between, checks the domain (health, indexable, `www` redirect, `/admin` locked, noindex on the `workers.dev` twin), moves the uptime monitors to the domain and runs the launch QA gate. Then the owner sends one real lead to prove the notification.

`teardown` first exports an idea's leads and uploads to the backup bucket. Then it deletes the idea's Worker, rows, objects and Access app.

### Creating and removing an idea site

Both run as workflows in the owner's private ops repo, because this repo's Actions logs are public. The ops workflows call the reusable `site-create.yml` and `site-teardown.yml` here, which run `scripts/site/create.mjs` and `scripts/site/teardown.mjs`.

`create` (input: the kickoff brief, or id, name, tagline, owner inbox, editing, indexing; Turnstile mode for self-tests):

1. Checks that the Worker name and the repo `site-<id>` are free.
2. Creates the shared idea resources once: D1 `fb-ideas` and `fb-previews`, R2 `fb-ideas-uploads` and `fb-previews`.
3. Creates a Turnstile widget on `<subdomain>.workers.dev`, which also covers preview URLs. A self-test uses the documented test keys instead.
4. Creates the Access app on `<host>/admin`. After the first deploy it creates a second one for the Worker's previews.
5. Copies `starter/`, vendors core, and writes `site.config.json` and `wrangler.jsonc` with real IDs. Previews get their own database and bucket.
6. Runs migrations on both databases, builds, and deploys with the secrets.
7. Creates the private repo `site-<id>`, pushes `main`, and connects Workers Builds: `main` deploys production, other branches deploy previews. This needs the Cloudflare GitHub app to have access to all repositories. If it fails, the `site connect builds` workflow retries just this step.
8. Checks `/api/health`, and checks that `/admin` asks for a login.

`teardown` refuses unless the id starts with `selftest-` or the owner types `delete <id>`.

1. Exports the site's leads and subscribers to `framework-backups/teardown/<id>/`, then deletes the rows and uploaded files.
2. Deletes the Builds triggers, both Access apps, the Turnstile widget and the Worker.
3. Archives the repo. It deletes the repo only when asked.
4. For a launch site (after promote; read from the repo's `site.config.json`): first removes its own monitors on the domain (matched by name, so another site's monitors there are kept). It detaches the Custom Domain, and removes the `www` record and redirect rule that promote added (other redirect rules stay). It exports `<id>-prod` and `<id>-staging` to `framework-backups/teardown/<id>/` and deletes them. It copies the `<id>-uploads` files there, then empties and deletes the bucket. It deletes the `<id> sending` Resend key. The zone, its other records and settings, Email Routing and the Resend domain stay, because they belong to the zone's owner. Tested 2026-10-27 on the whole-zone promote test site: every item above was removed, and the parked site's monitors on the same domain were kept.

Self-test on 2026-10-22 (`selftest-1022`):
- create, live QA (103 checks), a live lead with a file upload, a production build from the repo, and teardown all passed.
- Preview-branch builds were proven from 2026-10-26 by the preview check below.

`site selftest` runs the whole path weekly, and on demand, from the ops repo. It runs as one job:
1. Creates `selftest-<run id>` with Turnstile test keys.
2. Runs the QA gate on the live URL, from the site's own folder.
3. Sends one lead with a file through the live form (`starter/scripts/live-lead.mjs`). That script fills any form schema.
4. Checks the row, the subscription, the attribution and the file through the Cloudflare API (`scripts/site/verify-lead.mjs`). It also checks that both uptime monitors exist and report UP (`scripts/site/verify-monitors.mjs`).
5. Always tears the site down at the end, including when an earlier step failed.

R2 objects are written and deleted with Wrangler. The Builds calls follow the [Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/) (checked 2026-10-22). They need a user-scoped token (`CF_BUILDS_TOKEN`).

### Updating a site to a newer framework

A copied starter never gets later fixes on its own, so `site update` brings an existing site up to a framework ref. It runs from the ops repo (input: site id, framework ref, optional base commit) and calls the reusable `site-update.yml`, which runs `scripts/site/update.mjs`.

- Starting point: `framework.lock.json` in the site, written by `create` and by every update (framework commit, core version, editing on or off). Sites made before the lock existed pass `base`, the framework commit they were created from.
- Ownership (`scripts/site/lib/framework-files.mjs`):
  - site-owned, never touched: `site.config.json`, `wrangler.jsonc`, `DESIGN.md`, `PRODUCT.md`, `DECISIONS.md`, `HANDOFF.md`, `SECRETS.md`, `README.md`, `src/content/`, `public/`, `.githooks/`;
  - generated, rebuilt after the update: `tokens.css`, `seed/`, `package-lock.json`;
  - `package.json`: merged key by key in dependencies, devDependencies and scripts;
  - framework-owned: everything else from `starter/`, the editing overlay when editing is on (with the `prerender` line on other pages, as `editing on` writes it), and `core/`.
- Each framework-owned file gets a three-way merge between the base version, the site's file and the new version. Unchanged files are replaced; a file equal to any framework version between base and the new ref counts as unchanged. Site-only changes are kept. Changes on both sides are merged with `git merge-file`; overlapping changes keep the site's file, write the framework's as `<file>.framework-new` and are reported as conflicts. Files the site deleted stay deleted. `core/` is always replaced.
- Afterwards it runs `npm install`, regenerates tokens.css (and the EmDash seed when editing is on), checks the content and writes the new lock. A changed EmDash content model is reported, because a deployed content database keeps its model until it is migrated.
- The workflow commits on `framework/update-<commit>`, tests a copy of the site with Turnstile test keys (build, e2e, QA gate), and opens a pull request in `site-<id>` with the report and the test results. The preview build runs on that branch; production changes only when the owner merges.

Fixture tests (`scripts/site/test/update.test.mjs`, run by `site-scripts-test.yml`) cover a static site and an editing site. First live run (2026-10-23, an editing site created before the lock existed): 4 files updated or added, no conflicts; build, e2e and QA passed on the copy; the branch was pushed, but opening the pull request needed `GH_SITES_TOKEN` to have "Pull requests: write" (docs/TOKENS.md). The step now fails when the pull request can't be opened. After the permission was added, a second run (lock-only change) opened its own pull request, with 14 e2e and 80 QA checks passing. A static site was updated live on 2026-10-27 (27 files, opened and merged as a pull request, no conflicts). A live run with a conflict is untested; conflicts are covered by the fixture tests.

### Adopting an existing site

For a site that runs on its own Worker but wasn't built with Framework B (`scripts/site/adopt.mjs`, ops workflow
`site adopt`; built 2026-10-28, untested end to end until the first adoption). The new site is a normal Framework B
site in its own repo, in launch mode on the old site's domain. It takes over the old Worker by name, so the Worker's
custom domains, secrets, Access applications and Turnstile widget stay as they are.

- `adopt.json` in the site repo names the Worker, the old D1 database and the mapping queries: one read-only `SELECT`
  each for leads and subscribers that returns rows in core's schema (format in `scripts/site/lib/adopt.mjs`). Each
  query is checked to be a single statement with no writing keyword before it is sent, and every mapped row is
  checked before any is written.
- `prepare` creates `<id>-prod` and `<id>-staging` with core's migrations, copies the mapped rows (`INSERT OR
  IGNORE`), keeps or copies the uploads bucket, adds `SIGNING_SECRET` to the Worker, records the Worker's Workers
  Builds triggers in `adopt.json` and writes the new database ids into `wrangler.jsonc`.
- `preview` uploads the branch as a preview version of the Worker (`wrangler preview`) and runs the QA gate on it,
  while production still runs the old code.
- `cutover`, after the owner merges: copies new arrivals, deletes the Worker's Builds triggers and connects the new
  repo (the API documents deleting and creating triggers; whether `PATCH` can change a trigger's repo isn't
  documented, checked 2026-10-28), builds main, copies anything that reached the old database during the switch,
  and checks `/`, `/go`, `/api/health` and `/admin` before the launch QA gate.
- `rollback` connects the old repo again with its recorded triggers and builds its main.
- The old database is never written to. Deleting it, and anything else the old site used, needs the owner's approval.
- Older unsubscribe links keep working through core's `legacyUnsubSecret` (the Worker's own secret, by name).

### Checking a preview (P6)

`site preview check` (ops repo; inputs: site id, branch) calls the reusable `site-preview-check.yml`, which runs `scripts/site/preview-check.mjs`:

1. Makes sure the site's previews Access application has the reusable "framework-b agent" Service Auth policy (include: any valid service token). `create` adds it to new sites.
2. Waits for the Workers Builds build of the branch's head commit, and reads the preview URL from its log (`npx wrangler preview` prints `Preview URL: https://<branch>-<worker>.<subdomain>.workers.dev`, with `/` in the branch name turned into `-`).
3. Mints an Access service token that lives 30 minutes (the API refuses less than 10: "must be greater than or equal to 10m", 2026-10-26), waits until Access accepts it, and runs the site's QA gate on the preview. A new token is refused with a redirect to the login page for a few seconds (3–4 s seen on 2026-10-26).
4. Deletes the token, uploads the screenshots, and comments on the branch's pull request.

QA sends the token headers only to the preview's own origin: on `fetch`, on Playwright requests (a context route), and in Lighthouse (a Puppeteer page with CDP Fetch interception limited to that origin). Third-party requests such as the Turnstile script never carry them. This also works with Access's "strict service token authentication", which issues no cookie ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), checked 2026-10-23). `starter/scripts/test/access-auth.test.mjs` proves the scoping with two local origins.

No long-lived service token or secret is stored. The deploy token needs Access: Service Tokens Edit (docs/TOKENS.md). The check runs the site's own QA script, so a site made before it needs `site update` first.

Tested live on 2026-10-26: on the first real site's update branch (editing on), the QA gate passed with 81 checks, twice; in the self-test, on a static site's preview (108 checks) and an editing site's preview (107 checks), neither with a pull request. On the fresh editing preview the first request to the home page gave no response within 25 s (EmDash's first-request setup is the likely cause), so the check now waits up to 2 minutes for that first response before QA. Not tested yet: a preview whose build fails.

## 3. Kickoff questions

Asked once, in one message. Every question has a default, so an unanswered one never blocks the run. The agent writes the answers to the site's `brief.json` (format: `scripts/site/lib/brief.mjs`), each marked stated, inferred or default; `create` turns them into `site.config.json` values and `DECISIONS.md` rows. Runbook: `docs/BUILD.md`.

| # | Question | Default |
|---|---|---|
| 1 | Business basics: name, one-line offer, audience, owner inbox; postal address for launch mode | Required: name, inbox |
| 2 | Mode: idea, or launch on an existing domain or a new one. `create` always makes an idea site; `site promote` launches it | Idea |
| 3 | Site shape: landing page, full site, or hybrid | From the design intake |
| 4 | Forms: kinds and fields; consent `auto` (every form opts in) or `checkbox` (brief `consent`) | One contact form with a file field; `checkbox` for an EU, UK or Canadian audience |
| 5 | Lead auto-reply on or off; launch sender | Idea: off. Launch: Resend |
| 6 | Index now? | Idea: no (`create` input `indexing: on` makes the workers.dev address indexable; previews stay noindex). Launch: yes |
| 7 | Client editing (EmDash) | Off |
| 8 | CRM mirror: `none`, `sheet` (the owner's Google Sheet, through the Apps Script mailer), `webhook`, or `sheet+webhook` (brief `crm`; `create` sets `site.config.json` `crm`, and the webhook URL is set later as a secret) | None |
| 9 | Newsletter or drips (launch only) | None |
| 10 | Design intake | Required |

## 4. Phases and gates

| Phase | What happens | Gate |
|---|---|---|
| P0 Preflight | Read the account's ceilings (D1, Workers, Turnstile, Cron, Web Analytics); check tokens and GitHub access; ask kickoff questions | Stop if a ceiling is hit; offer `teardown` of an old idea |
| P1 Repo | Create the site's new repo from `starter/`; write `DECISIONS.md`; work on a branch | |
| P2 Design | Infer → confirm → personality sliders → references → suggested styles → this-or-that pairs → three style tiles → five-word check → lock `PRODUCT.md` and `DESIGN.md` (section 12) | **Owner picks a tile**; on autopilot the judge picks (section 12), marked `inferred` |
| P3 Build | Pages, copy, JSON-LD, sitemap, `robots.txt`, forms from the schema, privacy page matching what is collected | |
| P4 Data | `site create`: D1, R2, Turnstile hostname, secrets, Access apps, Builds triggers, monitors. No registry: ops services find sites through the Cloudflare API | |
| P5 Integrations | Mailers, unsubscribe, optional modules | |
| P6 Staging | Preview behind Access; end-to-end lead and upload test with Turnstile test keys; QA gate on the deployed preview (`site preview check`) | **Owner approves the preview** |
| P7 Domain | Idea: none. Launch: existing zone, or check → price → approval → register | **Owner approves any purchase** |
| P8 Go-live | Merge to `main`; QA gate on production; custom domain and redirect (launch, by `site promote`). DMARC and Web Analytics are not built | **QA gate passes** (automatic) |
| P9 Handoff | `HANDOFF.md`: URLs, renewal dates, monitors, backups, secrets inventory, owner-attested checklist | |

## 5. Forms

- **Schema:** forms are defined as JSON in `site.config.json` and rendered by the core form engine (multi-step, inline validation, progress shown).
- **Auto opt-in:** every form is a sign-up form, and submitting it subscribes the visitor. Someone who unsubscribed and later fills in a form again is subscribed again; each lead row keeps the opt-in wording shown that time.
- **Two consent modes** (`optIn.mode`, core 0.5.0). `auto`, the default, is described in this bullet and the one above. `checkbox` shows a consent box before the submit button (`optIn.label`). Only a ticked box subscribes, and an address that unsubscribed is subscribed again only by ticking it. A form's `consent` is `required` (the box must be ticked to send) or `optional`. The brief defaults to `checkbox` for an EU, UK or Canadian audience. Tested in workerd; *untested* live.
- **Opt-in line (auto mode):** every form subscribes the visitor. There is no checkbox, just one line under the submit button: "You'll get occasional emails from us. Unsubscribe anytime." This is allowed under US CAN-SPAM, which requires a working unsubscribe honored within 10 business days and a postal address in marketing email ([FTC guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)). For an EU, UK or Canadian audience the brief chooses the checkbox mode, because GDPR and CASL generally require prior consent; choosing `auto` there is a warning shown to the owner.
- **What each lead stores:** consent wording, page and timestamp, plus attribution (`utm_*`, `src`, `ref`, first off-site referrer without its query string, landing page). Thank-you URLs carry no parameters.
- **File field:** on the contact form by default ("Do you need to send us something?"). Upload flow (`packages/core/src/forms.js`):
  1. The form submit carries the file's name, size and type, never the file. The Worker checks Turnstile, the size cap (10 MB by default) and the type allow-list, then saves the lead with `upload_status = pending`.
  2. The response returns a signed, single-use upload URL that is valid for 15 minutes.
  3. The browser PUTs the file to it. The Worker checks that the size and type match the signature, claims the ticket, and streams the body to R2 at `<site>/<lead>/<file name>`.
  4. The lead row records the key and `stored`. A failed or abandoned upload stays visible in `/admin` as `failed` or `pending`.
  5. Previews use their own bucket.
  - Why not presigned R2 URLs? They need an R2 S3 API key pair as one more secret per site, plus bucket CORS. Streaming through the Worker needs neither. It also keeps CPU time low: the Workers Free plan allows 10 ms of CPU per request ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-10-22), and parsing a multipart file body would spend it. Request bodies are capped at 100 MB on Free and Pro zones (same page).
- **No JavaScript:** a plain HTML form post gets a 303 redirect to the thank-you page. The file field needs JavaScript.

## 6. Email

- **Transactional vs marketing:** confirmations are plain transactional mail: text plus minimal HTML, one unsubscribe link, no tracking, and no `List-Unsubscribe` headers. Marketing (newsletters, drips) carries `List-Unsubscribe` and `List-Unsubscribe-Post`, plus the postal address.
- **Idea mode:** the Apps Script mailer (`ops/apps-script-mailer`). Free; 100 recipients a day per personal Gmail, shared across all idea sites.
- **Launch mode:**
  - Notifications use Cloudflare `send_email` to the verified owner inbox when the site owns the whole zone; on a subdomain, or an apex with mail elsewhere, they stay on the Apps Script mailer (section 2).
  - Confirmations use Resend Free (3,000 a month, 100 a day) on `mail.<domain>`, with a sending-only key restricted to that domain.
  - Cloudflare Email Sending is the alternative, on Workers Paid.
- **New domains:** reputation starts at zero, and some filters block domains under 24 hours old. Tell the owner, test after 24–48 hours, and send no marketing for about 30 days.
- **Forwarding (`hello@`):**
  - Test from a third-party account. Gmail silently drops a message that comes back to the account that sent it.
  - Point DMARC `rua` at a reporting service, not at a forwarded inbox.
- **Never** submit made-up addresses to a form that sends mail. Bounces hurt the sender.

## 7. Admin, backups and monitoring

- **`/admin`:** lead list, lead detail (with upload links) and CSV export. Behind an Access app with email one-time PIN; the Worker also verifies the JWT. CSV cells are protected against spreadsheet formula injection.
- **Backups:** one account-wide Worker (`ops/backup-worker`) starts a Workflow every Monday from a Cron Trigger. Workflow `schedules` need a paid plan, so they are not used. It exports every D1 database in the account through D1's export API (a full SQL dump) and streams each dump to the `framework-backups` bucket, which deletes dumps after 90 days. New sites are covered with no registration step. `GET /status` on the Worker feeds an uptime keyword monitor. The monitor alerts when `"ok":true` is missing, which happens when a run fails or no run has finished in 8 days. D1 Time Travel separately covers the last 7 days on the Free plan.
- **Snapshot and park (any Worker, Framework B or not; built 2026-10-27):**
  - `scripts/site/snapshot.mjs` (ops repo **site snapshot**) is read-only. It saves everything needed to put a site back into `framework-backups/snapshots/<worker>/<time>/`:
    - the Worker: settings and bindings, cron, secret names, deployments, versions, Custom Domains, Builds triggers and its code;
    - the zone: settings, DNS (JSON and BIND), rulesets with their rules, page rules, Email Routing settings, rules and catch-all;
    - the Access apps and their policies on the zone's hostnames, and the Turnstile widgets that list them (without secrets);
    - every bound D1 database (production and previews, `wrangler d1 export`) and every object in each bound R2 bucket;
    - UptimeRobot monitors, and a git bundle of the site's repo.
  - Secret values can't be read back from Cloudflare, so park never deletes the Worker that holds them. Preview bindings have no read API, so they come from the repo's Wrangler file ([Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/), checked 2026-10-27).
  - `scripts/site/park.mjs` (ops repo **site park**) takes a Worker off its domain and deletes nothing:
    - pauses its monitors (UptimeRobot v2 `editMonitor`, status 0);
    - points its Builds production trigger at a branch that doesn't exist, so a push can't put it back on the domain (`PATCH /builds/triggers/{uuid}`, [Builds API](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/), checked 2026-10-27);
    - detaches its Custom Domains;
    - moves each Access app on the zone to a `/_parked` path, keeping its policies and AUD (checked after the change).
  - Every change goes to a record (`framework-backups/park/<worker>.json`), and `undo` reverses exactly that.
  - First use (2026-10-27), on the first real site's Worker, to free its whole zone for the promote test:
    - snapshot: 17 DNS records, 2 databases with row counts matching production, 6 R2 objects, the repo bundle (clone checked);
    - park: 2 monitors paused, 1 trigger held, 2 domains detached, 1 Access app moved with the same AUD.
  - `undo` (2026-10-27): domains, Access app (same AUD), Builds trigger and monitors restored. DNS (17 records), redirect rules and zone settings matched the snapshot exactly.
- **Monitoring:** `/api/health` checks the Worker and D1. `create` gives every site two UptimeRobot keyword monitors: the homepage must show the site's name, and `/api/health` must say `"ok":true`. Both alert every active alert contact, and `teardown` deletes them first. They are skipped when the ops repo has no `UPTIMEROBOT_API_KEY` secret. The calls follow UptimeRobot's v3 OpenAPI spec (in `@uptimerobot/cli` 1.0.0, checked 2026-10-23). The Free plan allows 50 monitors at 5-minute checks ([UptimeRobot CLI page](https://uptimerobot.com/cli), checked 2026-10-23).

## 8. QA gate

Runs on the preview (P6) and on production (P8). The build fails if any check fails. Implemented in `starter/scripts/qa.mjs` (axe-core 4.14.0, Lighthouse 13.5.0, Playwright 1.64.1). Template mode skips the placeholder rules; `--launch` adds them and the performance tripwire.

- **Content check:**
  - placeholders, `TODO`, lorem
  - example addresses
  - the wrong domain
  - brand values hard-coded in code instead of read from `site.config.json`
- **Rendering:** Playwright at 360, 768, 1280 and 1920 px: no horizontal scroll, no console errors, computed-style checks for banned fonts and hues.
- **Accessibility:** axe by WCAG 2.2 AA tags, plus a structural scan (landmarks, a single `<main>`, heading order).
- **Lighthouse (mobile):**
  - Accessibility, Best Practices and SEO: 100
  - CLS below 0.1
  - Performance: a 90 tripwire measured on production
- **Design checks:** `design.md lint`, `impeccable detect` on the source and on every page at 1280 and 390 px, a copy lint, and the truth gate (no testimonial, logo, statistic or face without an owner source). Then at most three rounds of vision-model critique, keeping a revision only if it wins a side-by-side comparison both ways round (`design-critique.mjs`, section 12).
  - Impeccable 4.8.0 (Apache-2.0; its engine binary ships as an npm optional dependency, so CI needs no download) runs 62 deterministic rules ([catalog](https://impeccable.style/slop); [npm](https://www.npmjs.com/package/impeccable), checked 2026-10-26). Rendered pages are scanned with `--cdp` in the browser QA already has open, so previews behind Access work and the detector never launches its own browser.
  - It reads `DESIGN.md`: a font outside it is a warning, and a colour, radius or font size outside it is an advisory. QA fails on all four, because they break the design contract (tested 2026-10-26 by adding an off-palette font, colour and radius to a component). This replaces the planned Stylelint check.
  - A deliberate exception goes in the site's `.impeccable/config.json` with a reason: `npx impeccable ignores add-value <rule> <value> --reason "..."` ([config and ignores](https://www.impeccable.style/docs/config), checked 2026-10-26).
  - `starter/scripts/test/impeccable-cdp.test.mjs` proves the rendered scan isn't vacuous: a page with known tells fails, a plain page passes.

## 9. Client editing (EmDash)

EmDash 1.3.1 is an Astro-based CMS ([docs](https://docs.emdashcms.com/deployment/cloudflare/), checked 2026-10-23). It is a per-site switch, off by default.

- **Switching it on:**
  - `node scripts/editing.mjs on` in a site (`create` runs it when `EDITING=on`) does the following:
    - Copies `starter/editing/` over the site: the Astro config, the Worker, the live collection and the home page.
    - Marks every other page prerendered.
    - Writes `seed/seed.json`: the content model, plus the current copy.
    - Adds the EmDash packages, pinned to exact versions.
    - Adds the bindings EmDash needs.
    - Keeps the static versions of the files it replaces in `editing/static/`. Site updates keep them current; a site switched on before `off` existed gets them from its next update.
- **Switching it off:**
  - `node scripts/editing.mjs off --remote` (or `--local`, or `--database <file.sqlite>`) in a site:
    - Reads the content database. `--remote` runs `wrangler d1 export` on `CMS_DB` and loads the SQL into a temporary SQLite file ([D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), checked 2026-10-27: a running export blocks other requests to that database, and a database with virtual tables can't be exported; the section model creates none).
    - Runs EmDash's own `emdash export-seed --with-content pages` on it and writes the published home page to `src/content/home.json`, dropping EmDash's `_version`. Other EmDash pages are listed, not exported, because only the home page was served from EmDash. Unpublished drafts are listed too. With no published home page, `home.json` stays as it was, since that is what the site was showing.
    - Copies each media-library image the home page uses from the `MEDIA` bucket (`wrangler r2 object get`) or `--media-dir` into `src/assets/images/`, and credits it in `design/credits.json` as the owner's, with a note to confirm the source. Images from other providers keep their URL.
    - Puts back `editing/static/`, removes `src/live.config.ts`, the added prerender lines, the EmDash packages and the `emdash` key, the `CMS_DB`/`MEDIA`/`SESSION` bindings (previews too), the cron, `nodejs_compat` and `seed/`, restores the assets 404 page, removes `editing` from `site.config.json`, then runs the content check.
    - Deletes nothing in Cloudflare. It lists the content database, media bucket, session namespace, the editor Access application and the two editing secrets for the owner to remove.
  - CI switches the starter on, edits the content database the way an editor would (new headline, a media-library image), switches off, checks every file `on` changed is back byte for byte, then runs the build, e2e and QA gate on the static site (`starter/scripts/test/editing-round-trip.mjs`). It was also run against a copy of a live editing site's deployed content on 2026-10-27; `--remote` with media-library images is untested.
- **How the Worker is wired:**
  - Core runs first: `createWorker(config, { fallback })` (since core 0.2.0). `/api/*`, `/admin` and `/u` behave exactly as on a static site.
  - Everything else goes to the Astro/EmDash handler, including the pages and `/_emdash`.
  - The `noindex` rule still applies to every response.
- **Where content lives:**
  - EmDash content has its own D1 database (`CMS_DB`, `<id>-cms`) and media bucket (`MEDIA`, `<id>-media`).
  - Sessions go in a KV namespace (`SESSION`).
  - Leads stay in `DB`/`UPLOADS`.
  - Previews get their own database, bucket and namespace. Production content is never bound to a preview.
- **Sign-in:**
  - Cloudflare Access on `<host>/_emdash`, with the application `<id> editor`. EmDash's `access()` mode checks the Access JWT, so there are no passkeys and no email is needed.
  - The first person to open the admin becomes its administrator and runs the setup wizard. Choosing the sample content there brings in the site's current copy.
  - To add an editor, add their email to the `<id> editor` policy.
  - On preview URLs, the previews Access application signs people in, and its audience is set as the previews' `CF_ACCESS_AUDIENCE`.
- **Performance on the Free plan (10 ms CPU a request):**
  - Only pages that read EmDash content render on request: the home page in the starter.
  - They are cached in Workers Cache (`maxAge` 300 s, `swr` 1 day). EmDash invalidates the `pages` tag on publish.
  - With Workers Cache on, every request, including static assets, counts toward the Free plan's 100,000 requests a day ([Workers Cache pricing](https://developers.cloudflare.com/workers/cache/), checked 2026-10-23).
- **Account budget on the Free plan:** each editing site uses 1 Cron Trigger (EmDash's hourly maintenance and scheduled publishing; 5 per account) and 2 D1 databases (10 per account). `create` checks both before it creates anything ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-10-23).
- **Worker size:** about 19 MiB uncompressed, under the 64 MiB limit, which has applied to all plans since 2026-09-04 ([changelog](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/), checked 2026-10-23).
- **Tested:**
  - Local end-to-end test and QA gate with editing on, in CI. This includes a round trip: content written to EmDash's database shows on the home page.
  - Live self-test with editing on: passed on 2026-10-23. The site deployed (Worker startup 26 ms) and passed the QA gate (102 checks). The live lead and upload were stored. Both uptime monitors reported UP. The checks confirmed that:
    - `/_emdash/admin` and EmDash's API ask for a Cloudflare Access login;
    - the home page renders through EmDash;
    - the content model is applied to the site's own database;
    - the hourly Cron Trigger is set.
    Teardown exported both content databases to `framework-backups`, then removed every editing resource: databases, buckets, KV namespaces and the Access app.
- **Tested live 2026-10-27:**
  - An editor signed in through Access (email code), changed the home page's hero headline in the live admin and published. The live page showed the new headline on the next request (cache invalidated on publish), on core 0.4.0.
  - A framework update's preview of the same editing site passed the preview check through Access (119 checks).
- **Not tested yet:**
  - Sandboxed plugins (Workers Paid only) and Cloudflare email sign-in (sending to arbitrary recipients needs Workers Paid).
- **Agents editing content:** EmDash has a CLI (`emdash login --url … -H …`), a REST API and an MCP server at `/_emdash/api/mcp`. Behind Access, an agent would need an Access service token. Untested.

## 10. Modules

- **CRM mirror** (built 2026-10-27; core 0.3.0; Google Sheet proven live 2026-10-27: a new lead was copied as it arrived, and `site crm sync` added the 5 older ones; webhook proven live 2026-10-27 against `ops/webhook-check`: a resend of the 7 older leads (`scripts/site/crm-sync.mjs`) and a new booking 0.2 s after it was saved all arrived with valid signatures and the lead id as the Idempotency-Key; resending to the webhook from the ops workflow needs the ops secrets `CRM_WEBHOOK_URL` and `CRM_WEBHOOK_SECRET` for that site, a path that is untested): `site.config.json` `"crm": { "sheet": true, "webhook": false }`.
  - After a lead is saved, the Worker copies one flat row (lead id, time, form, email, the form's fields, page, country, attribution) in `waitUntil`, so D1 is never blocked by a mirror.
  - `sheet`: a Google Sheet in the owner's Drive, through the account's Apps Script mailer: the spreadsheet "Framework B leads", one tab per site, created on first use. New fields add columns; values that would start a formula are stored as text.
  - `webhook`: a POST to the Worker secret `CRM_WEBHOOK_URL` (Zapier, Make, n8n or a CRM's own webhook), with `Idempotency-Key: <lead id>` and, with `CRM_WEBHOOK_SECRET`, an `X-Framework-B-Signature: sha256=<hmac of the body>` header.
  - The lead id is the idempotency key, so the ops `site crm sync` workflow can resend every lead: it brings in older leads when the mirror is switched on and retries a copy that failed.
  - Why not a Cloudflare Queue, as first designed: Queues are on the Free plan (10,000 operations a day, 24-hour retention; [changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/), checked 2026-10-27), but a Worker consumer is registered by `wrangler deploy`, and the token Workers Builds creates has no Queues permission ([Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token), checked 2026-10-27). D1 already holds every lead durably, and both targets dedupe by id, so a resend replaces the queue's retry.
- **Newsletter** (built 2026-10-27; a test send of a draft issue from its branch arrived 2026-10-27 with sender, postal address and unsubscribe link correct; a real `send` (a Resend Broadcast to the site's segment) reached both subscribers' main inboxes the same day): `scripts/site/newsletter.mjs`, run by the ops repo's `site newsletter` workflow.
  - An issue is a Markdown file in the site's repo (`newsletter/<date>-<slug>.md`, front matter `subject` and optional `preview`), written on a branch and merged by the owner like any other change.
  - `test` sends it to one inbox, from `main` or from the issue's pull request branch, so the owner can read a draft before approving it. Before the site has a domain it goes from Resend's test sender, which only delivers to the Resend account's own address.
  - `send` (launch mode only) mirrors the site's subscribers from D1 into its Resend segment `<id> newsletter`, records in D1 anyone who used a newsletter's unsubscribe link, and sends one Resend Broadcast from `news@mail.<domain>`. Resend adds the one-click `List-Unsubscribe` headers and fills the unsubscribe link per recipient. Someone who unsubscribes on the site is removed from the segment; the contact's global unsubscribe flag is never set by us, because other sites in the same Resend account share it. An issue already sent is refused unless forced.
  - It sends from `mail.<domain>`, the same Resend domain as auto-replies, because Resend Free allows 3 verified domains per account; a separate `updates.<domain>` would halve the number of launch sites. Resend Free covers marketing email to 1,000 contacts a month ([quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits), checked 2026-10-27).
- **Drips** (built 2026-10-27; core 0.4.0; live on a launch site 2026-10-27: Workers Builds deployed the Workflow, and a real booking started its instance 2 seconds later, sleeping until the first email; with the first wait set to 20 minutes for the test, the email arrived in the inbox on time): a short email series after a form, one Cloudflare Workflow instance per lead.
  - `site.config.json`: `"drips": { "forms": ["contact"], "emails": [{ "after": "1 day", "subject": "...", "text": "..." }] }`. `after` is the wait since the previous email (minutes, hours, days or weeks; at most 365 days). Up to 10 emails. `text` is plain text: blank lines make paragraphs and URLs become links. Optional `from` (default `news`) is the part before `@mail.<domain>`.
  - Launch mode and `email.confirm: "resend"` are required; `config.js` refuses anything else.
  - The site's Worker exports `DripWorkflow = dripWorkflow(config)` (it does nothing until configured), and `wrangler.jsonc` binds it: `"workflows": [{ "name": "<id>-drips", "binding": "DRIPS", "class_name": "DripWorkflow" }]`. The content check fails if drips are configured without the binding.
  - After a lead is saved, the Worker creates instance `drip-<lead id>` (a repeat is a no-op). For each email the instance sleeps, reads the subscriber's status in D1 and stops if they unsubscribed, then sends through Resend with the idempotency key `drip-<lead>-<n>` (Resend keeps keys 24 hours; [idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), checked 2026-10-27). Each email carries `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` ([unsubscribe headers](https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails), checked 2026-10-27), the postal address and an unsubscribe link. `/u` accepts the one-click POST.
  - Workflows on Workers Free ([limits](https://developers.cloudflare.com/workflows/reference/limits/), page updated 2026-09-21, checked 2026-10-27): 1,024 steps, sleeps up to 365 days, 100 instances running at once (sleeping instances don't count), 10 ms CPU per step, 3-day retention of finished instances. Deploying a Workflow needs only Workers Scripts Write ([API](https://developers.cloudflare.com/api/resources/workflows/methods/update/), checked 2026-10-27), which the Workers Builds token has; confirmed when Builds deployed one on 2026-10-27.
  - Tested in workerd: config checks, the message, starting one instance per lead, a subscriber getting both emails in order, an unsubscribed person getting none, and the one-click POST.

## 11. Rules learned from the first live build

| Rule | Evidence |
|---|---|
| Plain transactional confirmations, no bulk headers | Styled confirmations with `List-Unsubscribe` landed in Gmail Promotions |
| Warn about new-domain reputation; `mail.` subdomain | Corporate inboxes spam-filtered a same-day domain |
| Thank-you URLs carry no parameters; first off-site referrer only | Thank-you URLs nested inside later leads' referrers |
| axe plus a structural scan | axe reported 0 violations while Lighthouse found a missing `<main>` |
| Performance is a tripwire, not a 100 target | Production scored 94–98 run to run on identical code |
| Replaced assets get new file names | `/assets/*` is cached for a day |
| Branch protection on `main` | An agent committed straight to `main` |
| List manual-only settings up front, with links | 2FA, Crawler Hints, Search Console, Bing and auto-renew had to be set by hand |
| Wait about a minute after a build before checking production | A check 5 s after a build saw the old version |
| Deploy token includes Zone → Analytics: Read | Needed to read Email Routing logs |

## 12. Design phase (P2)

Full rationale, sources and tool versions: `docs/research/design-layer.md`. Summary:

| Step | Agent | Owner | Output |
|---|---|---|---|
| P2.0 Infer | Reads prompt, assets, existing copy; drafts `PRODUCT.md` with `inferred` flags | — | `PRODUCT.md` draft |
| P2.1 Confirm + shape | 4–6 confirm-or-correct questions; proposes landing, full site or hybrid from the traffic source | Confirms | `PRODUCT.md`, `design/sitemap.md` |
| P2.2 Personality | Metaphor prompt and 5–6 sliders with defaults; plays back a one-sentence brand vision | Adjusts or accepts | Slider values, vision |
| P2.3 References | Asks for 2–3 liked and 1–2 disliked sites, with why; offers thumbnails if none | Answers or thumbs | References, anti-references |
| P2.4 Suggest styles | 3 named styles from the menu, with industry reasons as suggestions; pre-checked avoid list | Keeps or swaps | Shortlist, avoid list |
| P2.5 This-or-that | 4–6 two-option pairs rendered on the real headline, on an Access-gated preview | Picks A or B | `design/intake.json` |
| P2.6 Tiles | 3 `DESIGN.md` drafts, linted, rendered as HTML style tiles | Picks or combines one | `design/tiles/` |
| P2.7 Check | Five-word check; one refine round at most | Picks five words | Final draft |
| P2.8 Lock | Writes `DESIGN.md` (Google format), `tokens.css` (Tailwind 4 `@theme`), image plan and credits | — | Locked contract |

### What's built (2026-10-23, tools added 2026-10-26)

The design phase's foundation and its tools are in `starter/`. The intake conversation (P2.1–P2.4) is run by the agent by hand; this-or-that pairs (P2.5), tiles, the judge, the critique rounds and the credits ledger (P2.6–P2.8) are scripts.

- **`DESIGN.md` → tokens:** `scripts/design-tokens.mjs` reads Google's DESIGN.md format.
  - It lints with `@google/design.md` 0.4.0 ([repo](https://github.com/google-labs-code/design.md), checked 2026-10-23); errors fail.
  - It checks Framework B's token contract:
    - colours: bg, surface, ink, ink-muted, line, field, accent, accent-ink, highlight, highlight-ink, error, focus;
    - type levels: display, headline, title, body, small, label;
    - radii: control, card;
    - spacing: gutter, section, content, prose.
  - It checks WCAG 2.2 AA contrast for the pairs the sections use. Text needs 4.5:1. Input borders and the focus ring need 3:1 (1.4.11).
  - It writes `tokens.css` as a Tailwind 4 `@theme` with:
    - Tailwind's default palette reset (`--color-*: initial`, verified on Tailwind 4.3.3);
    - fluid type from `<level>-mobile` tokens;
    - self-hosted Fontsource fonts (OFL);
    - DESIGN.md components as classes, such as `.button-primary` and its `-hover` state.
  - The CLI's own `export --format css-tailwind` drops line-heights and font fallbacks, which is why the framework writes its own export.
- **Section library (`src/sections/`):**
  - The sections are hero (with an optional image), steps, features, pricing, area, faq, cta, form, text, split (text beside an image) and gallery.
  - Pages: `home.json` is `/`; every other `src/content/<slug>.json` is `/<slug>`, rendered by `src/pages/[page].astro` and checked like the home page (title required, hero first, no clash with a page in `src/pages/`). With client editing on, only the home page comes from EmDash; the others stay static.
  - Each is defined once in `schema.js`, in EmDash's block-type format. That one definition:
    - checks static content (`scripts/check-content.mjs`);
    - renders the Astro component (`Sections.astro`, which takes `{ value }` props, the same shape EmDash blocks use);
    - becomes the EmDash block types when editing is on (`editing.mjs` writes them into the seed).
  - Pages are JSON files in `src/content/`.
  - There are deliberately no testimonial, logo or statistics sections.
- **Icons:** 30 Lucide line icons vendored inline (`lucide-static` 1.61.0, ISC).
- **Header:** a nav item with `cta: true` becomes the header button. On phones only the name and that button show.
- **QA additions:**
  - tokens.css must match DESIGN.md;
  - content must match the schema;
  - truth gate: no reviews, ratings, customer counts or percentages unless listed under "Approved claims" in `PRODUCT.md`;
  - copy lint for generic AI words;
  - Lighthouse "is-crawlable" only on the canonical host of an indexed site, for pages that don't opt out.
- **Style tiles (`scripts/design-tiles.mjs`, P2.6):** each DESIGN.md draft is built as this site, into a scratch folder, after the same lint, token-contract and contrast checks as the real `design-tokens.mjs`. It builds in place because a copy can't share `node_modules` (Astro mis-resolves EmDash's own pages through a symlink, seen in CI on 2026-10-26). The site's DESIGN.md, tokens.css and adapter redirect file are restored afterwards, on Ctrl-C, and, after a hard kill, on the next run (tested). A draft that fails gets no tile, and the report says why. The tile page (`scripts/design-tile/tile.astro`, never part of the site) shows the real hero, the colour tokens, the type scale, the site's real form and its first section after the hero. Each is screenshotted at 1280 and 390 px into `design/tiles/`, with a side-by-side `index.html`. The fonts a draft names must already be installed in the site. Tested 2026-10-26 on the first real site (editing on): two drafts rendered, and a low-contrast draft was rejected for WCAG AA. CI renders tiles on every starter change, static and editing.
- **Autopilot judge (`scripts/design-judge.mjs`):** run exactly as calibrated (docs/research/trials.md). `prepare` makes first-screen ballots for every pair, both ways round, in shuffled order. The agent's own vision model answers each with LEFT or RIGHT; no outside API or key is used. `tally` counts a win only when a tile wins both ways round and treats a split as a tie. When the top tiles tie, the agent takes the one closer to the intake answers and records why in DESIGN.md. Another judge model must pass the calibration set first.
- **Images:** image fields use EmDash's media shape (`{ src, alt, ... }`). On a static site `src` is a file in `src/assets/images/`, served through Astro's `<Image>` as WebP at 480–1600 px with `sizes` (sharp 0.35.5). Alt text is required. `editing.mjs` leaves local images out of the EmDash seed, so editors add them in EmDash's media library instead; images on editing sites are untested.
- **Open-licensed photos (`scripts/images.mjs`):** searches Openverse ([API](https://api.openverse.org/v1/), no key, checked 2026-10-27; anonymous use is 20 results a page and about one request a second, [Openverse](https://make.wordpress.org/openverse/2022/06/17/mitigating-out-of-terms-api-usage/)) for CC0, Public Domain Mark, CC BY and CC BY-SA images (the licences that allow commercial use and resizing) at least 1000 px on the long side. It makes a numbered contact sheet to look at before choosing, then downloads, resizes to at most 2000 px, strips metadata and writes the credit. Flickr and Wikimedia want a descriptive User-Agent. Wikimedia rate-limited this agent's address (429, `retry-after: 600`, 2026-10-27), so the download waits once for Retry-After. `/credits` lists every credited image with its licence, as CC BY requires, and the footer links to it.
- **Image credits (`design/credits.json`):** every image in `public/` or `src/` needs an entry giving its source (owner, openverse, stock, generated, brand or framework) and its alt text. Openverse and stock images also need the creator, licence and link; a generated image must be marked `illustrative` (or `abstract`). `check-content.mjs`, and so the QA gate, fails on an image without an entry. The ledger is seeded once into existing sites by `site update` and is site-owned from then on. Where images go is decided per page in the content files.
- **First use:** the first real site (idea site, editing on), with autopilot direction from research. Its local end-to-end test and QA gate pass with editing on.
- **This-or-that (`scripts/design-pairs.mjs`, P2.5, built 2026-10-27):** the agent writes 4–6 pairs in `design/pairs.json`; each option sets one or more of display and body font, colours, radius, density and imagery over the current DESIGN.md, so A and B differ only where the pair says. `render` draws each pair on the home page's real hero copy into `design/pairs/<id>.png` plus an `index.html`; fonts the site lacks are fetched from Fontsource into `node_modules/.cache` (never added to `package.json`), and the QA gate's banned fonts are refused. `pick <id> a|b` records the owner's answer in `design/intake.json`; `defaults` fills the rest with the recommended side, marked inferred. The pairs go to the owner as images in chat (the research's "link, or screenshots"), so no preview deploy is needed. Tested 2026-10-27 on the starter with four pairs; 3 unit tests.
- **Critique rounds (`scripts/design-critique.mjs`, section 8 of the research, built 2026-10-27):** after the gates pass, in the same test-key copy. `start` screenshots every page except 404, thanks, privacy and credits at 1280 and 390 px; the agent fills the five-dimension rubric (hierarchy and clarity, subject-specificity, named tells, consistency with DESIGN.md, trust), its tells and at most three located fixes; `score` ends the loop when every score is 4 or more with at most one tell. `compare` rebuilds and runs the QA gate (a failure reverts the fixes and ends the loop), then makes ballots for every changed page and width (the first screen if it changed, else the full page), both ways round. `decide` keeps the fixes only if "after" wins both ways on every changed page, otherwise reverts them, and ends the loop after a round with no accepted revision or after three rounds. The critic and the judge are the agent's own vision model, as with the tile judge. First run on the starter (2026-10-27): round 1 found the form section printing its heading twice; the fix won all four ballots and is in this change. A second round with a deliberately worse change was reverted. 4 unit tests.

### Design upgrade (2026-10-28)

Why: every site had the same skeleton (one layout per section, the same order, long stacked phone pages: 8.4 and 9.2
phone screens on two real sites), so only the skin changed between them. Research and recommendations: the
"Framework B design upgrade" document (2026-10-28). Owner decisions the same day: generated imagery is allowed and its
style is a kickoff question; fonts from any OFL source; no single animation library, the lightest thing that fits;
free first.

- **Composition and imagery in DESIGN.md.** Two Framework B blocks (the `@google/design.md` linter accepts extra
  blocks). `composition`: align (left, center), density (airy, compact), separation (bands, hairlines, none), cards
  (filled, outlined, flat), imageShape (rounded, square, full-bleed), motion (none, subtle, expressive) and
  phoneBudget (2–20 phone screens for the home page, default 6). `imagery`: style (owner-photo, documentary-stock,
  photoreal-generated, line-art, flat-illustration, watercolor, 3d, isometric, collage, cartoon, abstract,
  icon-led), an optional secondary style, treatment (none, duotone, tint, warm, cool, mono), grain, and a one-line
  art direction. `design-tokens.mjs` checks every value and writes them to `src/styles/design.json`, which the
  sections, the layout and the QA gate read. The brief asks the imagery question (`design.imagery`).
- **Section layouts.** Every section has a `variant` (hero: split, full-bleed, statement, editorial, bento; steps:
  cards, timeline, numerals; features: grid, bento, list, cards; faq: stack, two-column; cta: card, band; form:
  stacked, split; split: side, overlap; gallery: grid, masonry, strip; area: chips, columns; text: prose, lead) and,
  except the hero, a `phone` setting: stack, swipe (a scroll-snap row), collapse (an exclusive `<details name>`
  accordion) or hide. `auto` uses a per-section default (`PHONE_AUTO`). Both are optional EmDash fields, so editors
  can change them.
- **Phone layout.** A fixed bottom action bar with the CTA (and a Call button when `site.phone` is set) on every page
  but the CTA's own; a row of page links under the header. The QA gate measures the home page at 390×844 and fails
  it above the phone budget, and fails a first screen without the `<h1>` or a missing action bar.
- **Motion, CSS only.** Hover lift and press states, a scroll-driven reveal (`animation-timeline: view()`, inside
  `@supports`), a timeline line that draws, parallax on a full-bleed hero (expressive only), and cross-document view
  transitions (`@view-transition`). All of it sits under `prefers-reduced-motion: no-preference`; the QA gate checks
  that nothing animates with reduced motion. No animation library ships; one may be added per site when a design
  needs JavaScript-driven motion.
- **Logo (`scripts/brand-kit.mjs`).** Six layouts (wordmark, mark and name, stacked, badge, monogram, tracked with a
  rule) set in the design's display font and converted to outlines with opentype.js 2.0.0 (MIT); the mark is the
  initials or a filled Phosphor icon (`@phosphor-icons/core`, MIT). `pick` writes the logo, favicon, Apple touch icon,
  192 and 512 px icons, a 1200×630 share image and the web manifest, and sets `site.logo`. Fonts and icons are fetched
  into `node_modules/.cache`, never into `package.json`. CI runs it on every starter change.
- **Imagery treatment (`scripts/lib/treatment.mjs`).** `images.mjs add` and `generate-image.mjs use` apply the
  design's treatment so stock and generated images match; `images.mjs treat` applies it once to an owner photo. The
  credit records the change.
- **Generated images (`scripts/generate-image.mjs`).** Cloudflare Workers AI, FLUX.2 [klein] 4B (Apache 2.0, [BFL
  licensing](https://help.bfl.ai/articles/9272590838-self-serve-dev-license-overview-pricing), checked 2026-10-28);
  width and height 256–1920, 4 fixed steps, 26.05 neurons per output 512×512 tile against 10,000 free neurons a day
  ([model](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/),
  [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), checked 2026-10-28). The prompt is the
  style's description, the subject, the design's art direction and palette, and "no text or logos". `draft` makes
  numbered candidates and a contact sheet; `use` applies the treatment and writes a credit with the model, prompt and
  seed. Rules from the research ([Getty Images VisualGPS](https://newsroom.gettyimages.com/en/getty-images/nearly-90-of-consumers-want-transparency-on-ai-images-finds-getty-images-report),
  checked 2026-10-28: nearly 90% of people want to know whether an image was made with AI, and AI pictures of people
  or products read as more misleading than other subjects): a generated image never shows the business's own people, premises, products, work or results; a
  photorealistic one shows no faces and carries a visible "Generated image" label; every one is listed on
  `/credits`. Untested against the live API: no build has had a Workers AI token yet.

Rules:

- **No invented proof.** No testimonials, logos, counts, statistics or faces without an owner source. The agent never generates the business's own people, premises, products or work, and never a recognisable face.
- **Ban list in `AGENTS.md`:** purple or indigo gradients; cyan on dark; cream + serif + terracotta; near-black + acid accent; broadsheet hairlines; reflex Inter, Geist, Space Grotesk or Instrument Serif. A style may still use one of these if `DESIGN.md` records it as a deliberate choice.
- **Sections follow the page's argument,** not one fixed order. Sections come from the framework's own token-driven section library. Starwind UI is the candidate for interactive components; it is not used yet and is untested on Astro 7.
- **Performance threshold:** the research proposed 0.95. The framework keeps the 90 tripwire, because a real production build measured 94–98 run to run on identical code.

Owner-approved on 2026-10-22: the nine-step intake, paid reference libraries as an option only, and autopilot.

Supporting tools from the second research round (`docs/research/apify-huggingface-design.md`). They feed the steps above and add no questions. All are free. **None of them is built yet** (reference capture, `dembrandt`, palette extraction and the extended ban list are proposals); the rules on proof and Apify apply now.

- **P2.3 References:** the owner pastes URLs. The agent captures each one with Playwright at 390, 768 and 1440 px into private R2 under the site's brief, never into a repo. Gallery sites (Dribbble, Behance, Awwwards, Land-book) are not scraped; when the owner names a gallery entry, the agent follows it to the live site.
- **P2.3 → P2.6 Tokens from references:** `dembrandt` (MIT) extracts the palette and font families of liked references as inputs to the tiles. Its type scale is too noisy to use (trial, `docs/research/trials.md`). In launch-mode QA, its drift gate checks rendered colours, radii and font sizes against tokens exported from `DESIGN.md`.
- **Autopilot judge:** pairwise, both orders; a pick between near-equal tiles counts as a tie. Any judge model must first pass the calibration set in `docs/research/trials.md` (at least 14 of 16 clear pairs, full order consistency).
- **P2.4 and P2.6 Directions:** each tile is written as a structured direction (style, palette, type pair, density, imagery) with a typicality score, so the three tiles are deliberately different and autopilot picks a direction on purpose instead of drifting to the average.
- **Fonts:** chosen from the Fontsource catalog (no key; licence and subset data), OFL faces only, self-hosted.
- **Colours:** palettes start from the owner's logo and photos (`node-vibrant`), then go through Huemint, with the CC0 `palettevault` set as the offline fallback.
- **"Generic" list:** the top Google Fonts by popularity, the Web Almanac font shares, and the Tailwind and shadcn default tokens extend the ban list as "needs a reason in `DESIGN.md`".
- **Proof:** testimonials come from the owner, with the reviewer's consent, linked to the public review. Reviews are never scraped from Google, Yelp or Trustpilot.
- **QA extra (optional):** CrUX real-user speed for the reference sites, beside the site's own Lighthouse result. Needs a free Google API key.
- **Apify:** never required. Allowed only for screenshots when the agent has no browser, with a per-run spending cap. Finding local competitors on Google Maps needs the owner's sign-off for each run.

Checked when adopted: the `@google/design.md` CLI (0.4.0, 2026-10-23), the Tailwind 4 `--color-*: initial` palette reset (4.3.3), and Impeccable's own ignores (`npx impeccable ignores add-value`, used instead of a waiver wrapper). Still unverified, because they are not used yet: Starwind on Astro 7, and an OKLCH scale library.
