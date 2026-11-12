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
| D1 | Shared `fb-ideas` database, `site` column (previews: `fb-previews`) | Own `<id>-prod` database; previews keep the shared `fb-previews` (sites launched before 2026-10-28 keep their `<id>-staging`) |
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
  1. Checks: the site is in idea mode; the zone is active; the owner's inbox is a verified Email Routing destination; the D1 budget has room for one more database (Free plan: 10 per account, https://developers.cloudflare.com/d1/platform/limits/, checked 2026-10-28; each launch site uses 1).
  2. Zone: Always Use HTTPS, TLS 1.2 minimum, Email Routing on, a proxied `www` record and a `www` → apex Single Redirect (301, path and query kept).
  3. Data: an `<id>-prod` database with migrations (previews keep `fb-previews`, which gets the same migrations; core keeps every site's rows apart by `site`); the site's leads and subscribers copied from `fb-ideas` with `INSERT OR IGNORE`; an `<id>-uploads` bucket with every stored upload the leads point at. The idea-mode rows stay in `fb-ideas` until the owner approves deleting them.
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
4. For a launch site (after promote; read from the repo's `site.config.json`): first removes its own monitors on the domain (matched by name, so another site's monitors there are kept). It detaches the Custom Domain, and removes the `www` record and redirect rule that promote added (other redirect rules stay). It exports `<id>-prod` and `<id>-staging` to `framework-backups/teardown/<id>/` and deletes them. It copies the `<id>-uploads` files there, then empties and deletes the bucket. It deletes the `<id> sending` Resend key. On a zone the site owns, the zone, its other records and settings, Email Routing and the Resend domain `mail.<domain>` stay, because they belong to the zone's owner. Tested 2026-10-27 on the whole-zone promote test site: every item above was removed, and the parked site's monitors on the same domain were kept.
5. For a launch site on a one-level subdomain of a zone it shares (`shop.example.com` in `example.com`), `mail.<domain>` and its DNS records exist only for that site, so teardown also removes them (`scripts/site/lib/teardown.mjs`). Left behind, each kept one of the 3 verified domains Resend Free allows ([quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits), checked 2026-11-12). With the ops secret `RESEND_ADMIN_KEY`, after the key:
   - It reads the domain's records from Resend, then deletes the domain. `GET /domains` lists every domain when no `limit` is given ([List Domains](https://resend.com/docs/api-reference/domains/list-domains), checked 2026-11-12). `GET /domains/{id}` returns `records[]` with `record`, `name`, `type`, `ttl`, `status`, `value` and, for MX, `priority` ([Retrieve Domain](https://resend.com/docs/api-reference/domains/get-domain), checked 2026-11-12). `DELETE /domains/{id}` answers `{ "object": "domain", "id": ..., "deleted": true }` ([Delete Domain](https://resend.com/docs/api-reference/domains/delete-domain), checked 2026-11-12).
   - Resend doesn't document what happens to a key restricted to a deleted domain ([API keys](https://resend.com/docs/dashboard/api-keys/introduction), checked 2026-11-12), so the key goes first.
   - Then it deletes only the DNS records promote added for that domain. A record must carry promote's comment `Framework B: Resend` and sit at or under `mail.<domain>`, and its type, name, content and MX priority must match one of the domain's Resend records, placed by the same `resendRecordName`. TXT quotes are ignored, as promote's own check ignores them.
   - A record that was already in place when promote ran has no comment, so it stays. So does a commented record Resend no longer lists, which the report names.
   - If Resend no longer has the domain, every MX, TXT or CNAME record with the comment at or under `mail.<domain>` goes.
   - The zone's records are listed with the `name.endswith` filter ([List DNS Records](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/), checked 2026-11-12).
   - If the domain can't be deleted, its records stay, so a rerun matches them again. Each step is reported; a Resend or DNS error is reported, and teardown goes on.
   - Resend allows 10 requests a second per team and answers 429 with `retry-after` beyond that ([rate limit](https://resend.com/docs/api-reference/rate-limit), checked 2026-11-12); a 429 is retried twice.
   - Without the key, the run reports the domain it left.

   Untested against the live account: unit tests only (`scripts/site/test/teardown.test.mjs`).
6. A leftover sending domain whose site is already gone (removed before step 5 existed, or without the key): `MAIL_DOMAIN=mail.<host>` (ops input `mail_domain`) runs only this removal. Nothing else of `SITE_ID` is touched. It refuses, before deleting anything, unless all of these hold:
   - `CONFIRM` is exactly `delete <MAIL_DOMAIN>`. A site's `delete <id>` doesn't match, and no API is called before this check.
   - The name is `mail.<host>` with `<host>` one level below a zone of the account. A zone's own `mail.<zone>` is refused.
   - `RESEND_ADMIN_KEY` is set.
   - `<host>` is no Worker's Custom Domain, and the Worker `SITE_ID` (the site that used it) is gone.
   - No other Worker's site repo is launched on `<host>`. A parked site keeps its Worker but has no Custom Domain.

   Then it deletes the `<SITE_ID> sending` key if it is still there, the Resend domain and its records, as in step 5. Untested against the live account.

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
- A rerun for the same framework version finds the earlier run's branch: the push was refused, because the new commit doesn't build on it (three of four runs on one site on 2026-11-06). A rerun now takes the next free name (`framework/update-<commit>-2`, `-3`, ...), never force-pushes, and its report names the earlier branch to close. The branch naming was tested against a local remote; a live rerun is untested.
- Every workflow that installs Playwright's browser bounds it at 10 minutes and tries once more after clearing a stale lock: on 2026-11-11 a site update's test step hung for 40 minutes in `npx playwright install --with-deps chromium` and the job was cancelled (a known hang after the download finishes, [microsoft/playwright#41133](https://github.com/microsoft/playwright/issues/41133), checked 2026-11-11, with no confirmed cause).

Fixture tests (`scripts/site/test/update.test.mjs`, run by `site-scripts-test.yml`) cover a static site and an editing site. First live run (2026-10-23, an editing site created before the lock existed): 4 files updated or added, no conflicts; build, e2e and QA passed on the copy; the branch was pushed, but opening the pull request needed `GH_SITES_TOKEN` to have "Pull requests: write" (docs/TOKENS.md). The step now fails when the pull request can't be opened. After the permission was added, a second run (lock-only change) opened its own pull request, with 14 e2e and 80 QA checks passing. A static site was updated live on 2026-10-27 (27 files, opened and merged as a pull request, no conflicts). A live run with a conflict: 2026-11-11, an editing site built on the v1 framework (core 0.4.0) brought up to the
design layer (94 commits): one conflict (its own thanks page), the content model change reported, build and e2e
passed (14 checks), and the QA gate failed 3 checks, all things the newer rules ask of a site built before them: the
generated thanks page's title (the site's older copy, in conflict), a home page 7.1 phone screens long against the
budget of 6, and the Website assets page with no pictures to list, unbalanced at 1280 px (a framework bug, fixed: the
line now sits beside the title). The pull request's report now lists each failed check, not just their number.

### Adopting an existing site

For a site that runs on its own Worker but wasn't built with Framework B (`scripts/site/adopt.mjs`, ops workflow
`site adopt`; built and proven live on 2026-10-28 on the first adopted site: `prepare` copied its 4 leads and 9
subscribers, checked one for one; `preview` passed the QA gate on the Worker's preview through the site's own previews
Access application (376 checks); `cutover` connected the new repo to Workers Builds, built and deployed main, found
nothing new in the old database during the switch, checked `/`, `/go`, `/api/health` and `/admin`, and passed the
launch QA gate (418 checks). `rollback` is untested, and needs the old database, which the first adopted site's owner
had deleted on 2026-11-11 (its weekly backups stay in `framework-backups`). The new site is a normal Framework B
site in its own repo, in launch mode on the old site's domain. It takes over the old Worker by name, so the Worker's
custom domains, secrets, Access applications and Turnstile widget stay as they are.

- `adopt.json` in the site repo names the Worker, the old D1 database and the mapping queries: one read-only `SELECT`
  each for leads and subscribers that returns rows in core's schema (format in `scripts/site/lib/adopt.mjs`). Each
  query is checked to be a single statement with no writing keyword before it is sent, and every mapped row is
  checked before any is written.
- `prepare` creates `<id>-prod` with core's migrations (previews use the shared `fb-previews`, brought up to the same migrations), copies the mapped rows (`INSERT OR
  IGNORE`), keeps or copies the uploads bucket, adds `SIGNING_SECRET` to the Worker, records the Worker's Workers
  Builds triggers in `adopt.json` and writes the new database ids into `wrangler.jsonc`.
- `preview` uploads the branch as a preview version of the Worker (`wrangler preview`) and runs the QA gate on it,
  while production still runs the old code. An existing site's previews are usually behind Access already: QA goes
  through the application named in `adopt.json` `previewsApp` (default `<id> previews`) with the same short-lived
  service token as the preview check, after the `framework-b agent` Service Auth policy is added to it.
- `cutover`, after the owner merges: copies new arrivals, deletes the Worker's Builds triggers and connects the new
  repo (the API documents deleting and creating triggers; whether `PATCH` can change a trigger's repo isn't
  documented, checked 2026-10-28), builds main, copies anything that reached the old database during the switch,
  and checks `/`, `/go`, `/api/health` and `/admin` before the launch QA gate.
- `rollback` connects the old repo again with its recorded triggers and builds its main.
- The old database is never written to. Deleting it, and anything else the old site used, needs the owner's approval.
- Older unsubscribe links keep working through core's `legacyUnsubSecret` (the Worker's own secret, by name).

### Checking a preview (P6)

`site preview check` (ops repo; inputs: site id, branch) calls the reusable `site-preview-check.yml`, which runs `scripts/site/preview-check.mjs`:

1. Makes sure the site's previews Access application (`<id> previews`, or the one named in an adopted site's `adopt.json` `previewsApp`) has the reusable "framework-b agent" Service Auth policy (include: any valid service token). `create` adds it to new sites.
2. Waits for the Workers Builds build of the branch's head commit, and reads the preview URL from its log (`npx wrangler preview` prints `Preview URL: https://<branch>-<worker>.<subdomain>.workers.dev`, with `/` in the branch name turned into `-`).
3. Mints an Access service token that lives 30 minutes (the API refuses less than 10: "must be greater than or equal to 10m", 2026-10-26), waits until Access accepts it, and runs the site's QA gate on the preview. A new token is refused with a redirect to the login page for a few seconds (3–4 s seen on 2026-10-26).
4. Deletes the token, uploads the screenshots, and comments on the branch's pull request.

QA sends the token headers only to the preview's own origin: on `fetch`, on Playwright requests (a context route), and in Lighthouse (a Puppeteer page with CDP Fetch interception limited to that origin). Third-party requests such as the Turnstile script never carry them. This also works with Access's "strict service token authentication", which issues no cookie ([service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), checked 2026-10-23). `starter/scripts/test/access-auth.test.mjs` proves the scoping with two local origins.

No long-lived service token or secret is stored. The deploy token needs Access: Service Tokens Edit (docs/TOKENS.md). The check runs the site's own QA script, so a site made before it needs `site update` first.

Tested live on 2026-10-26: on the first real site's update branch (editing on), the QA gate passed with 81 checks, twice; in the self-test, on a static site's preview (108 checks) and an editing site's preview (107 checks), neither with a pull request. On the fresh editing preview the first request to the home page gave no response within 25 s (EmDash's first-request setup is the likely cause), so the check now waits up to 2 minutes for that first response before QA. The QA gate itself does the same for any `--url` since 2026-11-11, after the weekly self-test's editing site timed out on its first page load (30 s) on the live site, where no preview check had warmed it. Not tested yet: a preview whose build fails.

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

- **Schema:** forms are defined as JSON in `site.config.json` and rendered by the core form engine (multi-step, inline validation, progress shown). Field types: text, email, tel, url, textarea, select, radio, checkboxes (a group whose answer is stored as a list; options may carry a `group` heading), checkbox and hidden. `steps` gives each step a visible title and intro (core 0.6.0, added for adopting an existing site's forms; tested in workerd and the starter's browser test of every variant).
- **Auto opt-in:** every form is a sign-up form, and submitting it subscribes the visitor. Someone who unsubscribed and later fills in a form again is subscribed again; each lead row keeps the opt-in wording shown that time.
- **Two consent modes** (`optIn.mode`, core 0.5.0). `auto`, the default, is described in this bullet and the one above. `checkbox` shows a consent box before the submit button (`optIn.label`). Only a ticked box subscribes, and an address that unsubscribed is subscribed again only by ticking it. A form's `consent` is `required` (the box must be ticked to send) or `optional`; in either mode `none` makes a plain message form that never subscribes anyone and shows no opt-in (core 0.6.0). The brief defaults to `checkbox` for an EU, UK or Canadian audience. Tested in workerd; *untested* live.
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
- **Photos in a card set:** at 1280 px, in any list of three or more cards where some carry a photo, more than half must (a type-only card is an accent, not where the photos ran out; three of six failed the owner's eye on the first adopted site). A content page with no picture at all is listed in the report as a note, not yet a failure.
- **Text over pictures:** at 360 and 1280 px, every line of text that overlaps an image or a CSS background (a photo, a gradient) is measured against the picture behind it: the text is made transparent, the page screenshotted, and the 99th-percentile lightest pixel behind light text (1st-percentile darkest behind dark text) must give 4.5:1, or 3:1 for large text (24 px, or 18.5 px bold). WCAG's failure F83 checks "the area of the image that is darkest (for dark text) or lightest (for light text)" ([F83](https://www.w3.org/WAI/WCAG22/Techniques/failures/F83); ratios and large text: [Understanding 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), both checked 2026-11-03); the percentile keeps specks of grain or JPEG noise from deciding. Text shadows don't count as background. Sideways flex strips are unrolled into rows first, so cards that start off screen are measured too; text in fixed or sticky elements, video and the off-screen part of a grid strip are not measured. `design-tokens.mjs` only checks DESIGN.md's colour pairs, and axe and Lighthouse didn't flag text on a picture: phone poster titles at 1.2:1 passed all 375 checks on a real site (2026-11-03). `starter/scripts/lib/image-text.mjs`; `starter/scripts/test/image-text.test.mjs` proves loose light text on a bright picture fails and the same text on a scrim passes. Its first run found the split section's `overlap` card transparent with outlined or flat cards (text on the picture at 2.72:1); that card now keeps a solid background (`card-over-image`).
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
    - Copies `starter/editing/` over the site: the Astro config, the Worker, the live collection, the page-content
      helper (`src/lib/page-content.js`), the home page, the content pages' route (`src/pages/[page].astro`) and the
      pages sync (`starter/editing/src/pages/fb-sync-pages.js`).
    - Marks every other page prerendered, except privacy, contact and 404, which read their content through the
      helper and render on request.
    - Writes `seed/seed.json`: the content model, plus every page in `src/content` (the home page first).
    - Adds the EmDash packages, pinned to exact versions.
    - Adds the bindings EmDash needs.
    - Keeps the static versions of the files it replaces in `editing/static/`. Site updates keep them current; a site switched on before `off` existed gets them from its next update.
- **Switching it on for a site that exists** (built 2026-11-11; `scripts/site/editing-on.mjs`, ops **site editing** with
  `mode: on`): checks the budget (D1 and Cron Triggers, the site's own schedule excepted, because the deploy replaces
  it), makes the six resources, the "<id> editor" Access application on `<host>/_emdash` for each of the site's hosts
  (the owner and any `editors`), and the secrets (`CF_ACCESS_AUDIENCE`; `EMDASH_ENCRYPTION_KEY` generated once, never
  replaced; for previews the same key and the previews application's audience), with the site's wrangler config as it
  was. Then it runs the site's `editing.mjs on`, fills in the resource ids and opens a pull request. Proven live on
  2026-11-11 on the first adopted site, a launch site on its own domain. The run made the resources, the editor
  application and the secrets, and opened the pull request. The preview check passed (501 checks) once the motion fix
  below was in. After the merge, `/_emdash/admin` redirected to the Access login, the site's pictures were served
  from `/media/` and through the Images binding, and launch QA on the domain passed (541 checks). The first request
  after the deploy took over 60 seconds and was dropped, while EmDash prepared its database; the next ones took
  0.5 to 2.3 seconds. That is why the QA gate warms the home page first. The setup wizard and an editor's first
  edit are untested until the owner's editor runs them.
- **The site's own pictures in the seed** (2026-11-11): EmDash refuses an image value without a media id ("image.id:
  expected string", EmDash 1.3.1), so `on` used to leave a static site's images out of the seed. Each now goes in as an
  external media value: `id` "local:<file>", `src` "/media/<file>", with its alt text and focal point (EmDash keeps
  both; seeded and exported with EmDash's CLI, 2026-11-11). The editing build copies those files to `/media/`, so the
  admin can show them (`editing/astro.config.mjs`), and `Picture.astro` still serves them through Astro's image
  pipeline. On a page rendered on request that is the Cloudflare adapter's default runtime image service, the Images
  binding: up to 5,000 unique transformations a month on the Free plan, after which new ones fail with error 9422 and
  cached ones keep working ([Images pricing](https://developers.cloudflare.com/images/pricing/), checked 2026-11-11; a
  home page of a dozen pictures at four widths uses about 50). `off` turns them back into `{ "src": "<file>" }` with
  their focal points. EmDash's own `$media` import was not used: it downloads each picture from a URL while the seed is
  applied, which the site doesn't serve until it is deployed ([seed files](https://docs.emdashcms.com/themes/seed-files),
  checked 2026-11-11).
- **The home page's title and description** stay as the static home page has them until an editor sets a title (the
  editing home page used the site name and tagline before, 2026-11-11).
- **Every page is editable** (2026-11-11; before then only the home page came from EmDash, on every site):
  - Each page that reads content (the home page, every `src/content/<slug>.json` page, and privacy, contact and 404)
    asks `pageContent(slug)`. With editing on, that is EmDash's published page of the same slug (a preview link shows its
    draft): its title and sections, and the description and noindex an editor sets in its SEO panel. Otherwise it is
    the file, so a page EmDash doesn't have yet is still live, and the file keeps its description and noindex.
  - `src/pages/[page].astro` renders any slug on request: a page an editor creates in the admin is served at
    `/<slug>` at once (it isn't in the navigation or the sitemap until it is a file). A slug with no page, or one of the
    reserved ones (home, privacy, not-found, contact, anything starting with `_`), is a 404.
  - The seed carries every page, so the setup wizard's sample content brings them all in. Pages added to the files
    later reach EmDash with the Worker's hourly job: after EmDash's own scheduled work, the scheduled handler calls
    `/fb-sync-pages` inside the Worker (the public path answers 404), which applies the bundled seed with EmDash's own
    `applySeed` and `onConflict: "skip"`. EmDash matches pages by slug and skips any it has, in its trash too (read in
    EmDash 1.3.1's `seed/apply`, 2026-11-11), so an editor's work always wins. A new section type in the seed is
    added the same way; a changed one still needs EmDash's guide to evolving a deployed site.
  - To remove a page, take its file out of `src/content` (and the navigation), then put the page in EmDash's trash:
    trashing it alone brings back the file's version.
  - Every page that renders on request has a route rule (`/`, `/[page]`, `/privacy`, `/contact`, `/404`), listed one by
    one because a rest route would also match `/_emdash` ([route caching](https://docs.emdashcms.com/deployment/route-caching),
    checked 2026-11-11). The sitemap lists the content pages from `src/content`, since the integration can't list a
    dynamic route rendered on request.
  - The QA gate lists those pages itself (they aren't in the build output): on a copy of the starter with the
    full-site fixture, an editing build went from 116 checks to 219 once they were (the static build: 223). It also
    runs the per-page HTML checks (no TODO; at launch, no example names and a canonical on the site's host) on each
    one's served HTML: launch QA on the first adopted site went from 509 checks to 541 with them.
  - Live on the first adopted site on 2026-11-11 (site update, preview check 491 checks, launch QA 541). Its first
    hourly run after the deploy brought all 12 pages into EmDash in about 23 seconds of wall time (read back from the
    content database); pages and the 404 answered as before, and `/fb-sync-pages` answered 404 from outside.
  - Proven in CI (the full-site fixture's `/about` page through EmDash, the hourly job run with
    `wrangler dev --test-scheduled`, an editor-made page, a 404, and the round trip below). An editor's first edit of
    an inner page on a live site is untested until the first adopted site's editor makes one.
- **Switching it off:**
  - `node scripts/editing.mjs off --remote` (or `--local`, or `--database <file.sqlite>`) in a site:
    - Reads the content database. `--remote` runs `wrangler d1 export` on `CMS_DB` and loads the SQL into a temporary SQLite file ([D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), checked 2026-10-27: a running export blocks other requests to that database, and a database with virtual tables can't be exported; the section model creates none).
    - Runs EmDash's own `emdash export-seed --with-content pages` on it and writes each published page to `src/content/<slug>.json`, dropping EmDash's `_version`. A page keeps its file's description and noindex; a page an editor created becomes a new file, listed with a note to add it to the navigation. A page EmDash doesn't publish keeps its file. Unpublished drafts are listed. With no published home page, `home.json` stays as it was, since that is what the site was showing.
    - Copies each media-library image the pages use from the `MEDIA` bucket (`wrangler r2 object get`) or `--media-dir` into `src/assets/images/`, and credits it in `design/credits.json` as the owner's, with a note to confirm the source. Images from other providers keep their URL.
    - Puts back `editing/static/`, removes `src/live.config.ts`, the added prerender lines, the EmDash packages and the `emdash` key, the `CMS_DB`/`MEDIA`/`SESSION` bindings (previews too), the cron, `nodejs_compat` and `seed/`, restores the assets 404 page, removes `editing` from `site.config.json`, then runs the content check.
    - Deletes nothing in Cloudflare. It lists the content database, media bucket, session namespace, the editor Access application and the two editing secrets for the owner to remove.
  - CI switches the starter on (with the full-site fixture's `/about` page), edits the content database the way an editor would (new headlines on the home page and `/about`, a media-library image, a new page), switches off, checks every file `on` changed is back byte for byte, then runs the build, e2e and QA gate on the static site (`starter/scripts/test/editing-round-trip.mjs`). Since 2026-11-11 it also seeds one of the site's own pictures and checks it comes back as the same file with its focal point. It was also run against a copy of a live editing site's deployed content on 2026-10-27; `--remote` with media-library images is untested.
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
  - To add an editor, run **site editing** with `mode: on` and their email in `editors`. On a site where editing is
    already on, that only adds them to the `<id> editor` application, keeps everyone already there, and opens no pull
    request. To remove one, take their email off that application's policy in Cloudflare Zero Trust.
  - On preview URLs, the previews Access application signs people in, and its audience is set as the previews' `CF_ACCESS_AUDIENCE`.
- **Performance on the Free plan (10 ms CPU a request):**
  - Only pages that read EmDash content render on request: the home page, the content pages, privacy, contact and 404.
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
  - The sections are hero (with an optional image), steps, features, pricing, area, faq, cta, form, text, split (text beside an image), gallery, list (up to three lists side by side, each with check, cross, number or dot markers), people (the owner's own photos, names and roles; added 2026-10-28 for adopting an existing site), and the poster route's image panel and image doors (section 12, "The poster route").
  - Text fields take inline `**bold**`, `*italic*` and `[label](link)` (links starting with `/`, `#`, `https://`, `mailto:` or `tel:`). Everything else is escaped (`src/sections/text.js`), so content can't inject markup.
  - Pages: `home.json` is `/`; every other `src/content/<slug>.json` is `/<slug>`, rendered by `src/pages/[page].astro` and checked like the home page (title required, hero first, no clash with a page in `src/pages/`). With client editing on, only the home page comes from EmDash; the others stay static.
  - Each is defined once in `schema.js`, in EmDash's block-type format. That one definition:
    - checks static content (`scripts/check-content.mjs`);
    - renders the Astro component (`Sections.astro`, which takes `{ value }` props, the same shape EmDash blocks use);
    - becomes the EmDash block types when editing is on (`editing.mjs` writes them into the seed).
  - Pages are JSON files in `src/content/`.
  - There are deliberately no testimonial, logo or statistics sections.
- **Icons:** 48 Lucide line icons vendored inline (`lucide-static` 1.61.0, ISC).
- **Header:** a nav item with `cta: true` becomes the header button. On phones only the name and that button show.
- **QA additions:**
  - tokens.css must match DESIGN.md;
  - content must match the schema;
  - truth gate: no reviews, ratings, customer counts or percentages unless listed under "Approved claims" in `PRODUCT.md`;
  - copy lint for generic AI words;
  - Lighthouse "is-crawlable" only on the canonical host of an indexed site, for pages that don't opt out.
- **Style tiles (`scripts/design-tiles.mjs`, P2.6):** each DESIGN.md draft is built as this site, into a scratch folder, after the same lint, token-contract and contrast checks as the real `design-tokens.mjs`. It builds in place because a copy can't share `node_modules` (Astro mis-resolves EmDash's own pages through a symlink, seen in CI on 2026-10-26). The site's DESIGN.md, tokens.css and adapter redirect file are restored afterwards, on Ctrl-C, and, after a hard kill, on the next run (tested). A draft that fails gets no tile, and the report says why. The tile page (`scripts/design-tile/tile.astro`, never part of the site) shows the real hero, the colour tokens, the type scale, the site's real form and its first section after the hero. Each is screenshotted at 1280 and 390 px into `design/tiles/`, with a side-by-side `index.html`. The fonts a draft names must already be installed in the site. Tested 2026-10-26 on the first real site (editing on): two drafts rendered, and a low-contrast draft was rejected for WCAG AA. CI renders tiles on every starter change, static and editing.
- **Autopilot judge (`scripts/design-judge.mjs`):** run exactly as calibrated (docs/research/trials.md). `prepare` makes first-screen ballots for every pair, both ways round, in shuffled order. The agent's own vision model answers each with LEFT or RIGHT; no outside API or key is used. `tally` counts a win only when a tile wins both ways round and treats a split as a tie. When the top tiles tie, the agent takes the one closer to the intake answers and records why in DESIGN.md. Another judge model must pass the calibration set first.
- **Images:** image fields use EmDash's media shape (`{ src, alt, ... }`). On a static site `src` is a file in `src/assets/images/`, served through Astro's `<Image>` as WebP at 480–1600 px with `sizes` (sharp 0.35.5). Alt text is required. `editing.mjs` seeds a static site's own images as external media values (section 9); an editor can keep them or replace them from EmDash's media library. Images on a live editing site: untested until the first adopted site's run.
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
  it above the phone budget, and fails a first screen without the `<h1>` or a missing action bar. Since 2026-11-03 it
  also fails a link or button the bar cuts in half on the first screen, and any text still under the bar at the very
  end of the page. On phones, a hero action the bar already shows is left out of the hero (`HeroActions.astro`): on
  the first adopted site the hero's second link sat half under the bar, which carried the same two links.
- **Tap-to-open cue.** A phone accordion row (`collapse`) shows a plus in an accent-outlined square that becomes a
  minus when open (`PhoneAccordion.astro`, styles in `sections.css`), as easy to spot as the swipe cue; the old cue was
  a small `+` glyph.
- **Motion, CSS only.** Hover lift and press states, a scroll-driven reveal (`animation-timeline: view()`, inside
  `@supports`), a timeline line that draws, parallax on a full-bleed hero (expressive only), and cross-document view
  transitions (`@view-transition`). All of it sits under `prefers-reduced-motion: no-preference`; the QA gate checks
  that nothing animates with reduced motion. No animation library ships; one may be added per site when a design
  needs JavaScript-driven motion.
  - **Fixed 2026-11-11: the reveal had never run on a static build.** Vite 8's CSS minifier (Lightning CSS 1.33,
    with no browser targets) folded `animation-timeline: view()` into the `animation` shorthand. The spec allows
    that, but Chromium 141 rejects the whole declaration (checked in Chromium 141 on 2026-11-11), and
    [MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation) (checked 2026-11-11)
    warns about the same thing. The editing build kept the two apart, so the first adopted site's reveal ran for the
    first time when editing was switched on. Lighthouse then failed three pages on contrast: text at the bottom edge
    of the screen was caught mid-fade (opacity blended into its colour, 1.4:1 to 4:1). With a `view()` timeline,
    that frame holds for as long as the visitor doesn't scroll, so this is a real reading problem, not a test
    artefact. The rules are now written in longhands, which neither Lightning CSS nor esbuild folds, and the reveal
    rises without fading.
  - The QA gate checks both on the home page when motion is on: the scroll reveal runs, and no scroll-driven
    animation fades text. The first check would have failed the first adopted site's production pages, where 29
    reveal targets had no animation running.
- **Logo (`scripts/logo.mjs`).** First built as six fixed layouts of the name in the display font (the brand kit);
  since 2026-11-04 a method with a brief, drawn concepts, a test sheet and a full kit. See "Logo (2026-11-04)" below.
  The six layouts remain as template concepts (`node scripts/logo.mjs templates`; `scripts/brand-kit.mjs` still runs
  them). Words are set in the design's fonts and converted to outlines with opentype.js 2.0.0 (MIT); fonts are
  fetched into `node_modules/.cache`, never into `package.json`. CI runs it on every starter change.
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
  photorealistic one shows no faces; every one is listed on `/credits`, and none carries a label on the page
  (owner's decision 2026-10-28; the EU AI Act's disclosure duty, Article 50(4), covers deep fakes, content that
  resembles real people, objects, places or events and would falsely appear authentic, and for evidently artistic
  work only asks for a disclosure that "does not hamper the display or enjoyment of the work":
  [AI Act Service Desk](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50), checked 2026-10-28).
  Proven against the live API on 2026-10-28 (site images workflow, three runs).

### Design routes (2026-11-03)

Why: until then, a site's three drafts changed fonts, colours and corner radius on one page skeleton, the autopilot
judge picked one, and the owner never saw them (design review, 2026-10-28). Measured against 50 current sites from curated galleries (Siteinspire, Land-book, Awwwards, Framer, Minimal
Gallery and others, captured 2026-10-28), the first adopted site had 1 image on its home page against a median of
16 and 0 on most inner pages. The design review that day ("Framework B design review", 2026-10-28) offered the owner
four routes, each a different skeleton modelled on named sites, mocked on the site's real copy with public-domain
Library of Congress photographs. The owner chose one (a poster stack) on 2026-11-02, on condition that the text over
the photos is readable. The method is in `docs/BUILD.md` step 3; the framework keeps the method, not the route.

What building the route on the site found that the mock didn't (2026-11-03):
- On phones, the hero title sat over white paper in the photo (2.2:1) and the photo posters' titles over bright
  parts of their pictures (1.2:1). Every other check passed, which is why the QA gate now measures text over pictures.
- A 124 px full-sentence headline tripped Impeccable's `oversized-h1` rule and its second line fell below the first
  screen; 112 px fits.
- The archive scans carried white and black mat borders that showed on the cards; they are cropped off.
- Stacked, the poster wall made the home page 11.2 phone screens. Moving it into a sideways strip met the budget but
  put content where research says people miss it ("Crucial information does not belong in a carousel or in any other
  horizontally scrolling container": Nielsen Norman Group, [The Illusion of
  Completeness](https://www.nngroup.com/articles/illusion-of-completeness/), checked 2026-11-03). Phone length is a
  trade-off for the owner. The owner kept the strip for the services and asked for a cue that makes it obvious
  ("Swipe cue", below).

Owner's decision the same day: sideways strips stay an option, also for content such as a wall of services, and
`PHONE_AUTO` stays as it is; each strip gets a cue that makes it obvious (next section).

### Swipe cue (2026-11-03)

Why: a sideways strip is easy to miss, and research asks for something that shows how much more there is ("use a
scrollbar or pagination to show how much more content there is": Nielsen Norman Group, [Beware Horizontal
Scrolling](https://www.nngroup.com/articles/horizontal-scrolling/), checked 2026-11-03). The browser's own scrollbar
can't do it on phones: overlay scrollbars are "not shown by default but only while you are actively scrolling", and
`scrollbar-color` gives them no track ([Chrome for Developers, Scrollbar
styling](https://developer.chrome.com/docs/css-ui/scrollbar-styling), checked 2026-11-03); iOS lays its scrollbar
over the content the same way ([Master.dev](https://blog.master.dev/how-to-fix-the-invisible-scrollbar-issue-in-ios),
checked 2026-11-03). The design is the owner's: a bar in the accent colour, as long as the share of the
strip on screen, with an arrow head pointing the way there is more.

- `starter/src/sections/SwipeCue.astro` sits right after every list whose `phone` is `swipe` (features, steps except the timeline, pricing,
  gallery, lists) and after the gallery's `strip` layout, and shows only under 640 px. The strip's own scrollbar is
  hidden there; the strip stays focusable and labelled, and scrolls by touch, trackpad and keyboard. The cue is
  `aria-hidden` decoration.
- `starter/src/scripts/swipe-cue.js` sizes the bar to the visible share (at least 32 px), moves it with `transform` only
  and flips the arrow at the end. It has no transition, so nothing animates and reduced motion needs nothing extra;
  measured on the starter at 390 px: no animations, layout shift 0. Without JavaScript the bar sits at the start,
  pointing right. Its colour is `accent`, which the token contract already holds at 4.5:1 against `bg` and
  `surface`.
- The QA gate fails a sideways strip on the phone home page without its cue, and prints a note for each one.
- Tested in Chromium's phone emulation; untested on a real iPhone or Android phone.

### Archive photos and the library (2026-11-03)

Why: the first adopted site moved to Library of Congress photographs (the owner's choice: old, public-domain film
photographs, no generated images on that site). Finding, checking, downloading and cropping them was done by hand, and
photos taken off the pages were deleted although the owner wanted to keep them for other pages.

- `images.mjs search "<subject>" --source loc` searches loc.gov photos and keeps only records whose rights
  statement says "No known restrictions" (the Library's own wording for photographs it knows of no restrictions on;
  every record is checked again at `add`). `add loc:<id>` downloads the master scan (the JPEG copies stop at about
  1024 px), converts 16-bit scans to 8-bit, crops the mat, frame and edge markings (`scripts/lib/scan-borders.mjs`,
  with a 2.5% margin; a check image shows the box, and `--crop` sets it by hand when the scan has a caption or a
  negative number inside the frame), resizes to 2000 px, applies the design's treatment and writes the credit with
  the photographer, the record's link and its rights statement.
- loc.gov allows 20 API requests a minute and 150 image requests a minute, and blocks an address for an hour above
  that ([Working within limits](https://www.loc.gov/apis/json-and-yaml/working-within-limits/), checked 2026-11-03),
  so the script waits 3.1 s between API calls and 0.5 s between downloads. Master scans can be large (300 MB for a
  14,119 × 10,567 px 16-bit negative); the download allows 15 minutes.
- `--for "<slot: why>"` on `add` puts where a photo goes and why it fits in its credit, so the choice can be reviewed.
- The library: `shelve <file>` moves a photo and its credit from the site into the site's design/library folder (refused while a
  page still uses it); `unshelve <file>` brings it back; `library` lists the shelf and draws a contact sheet there (sheet.png).
  Nothing there is published.
- Unit tests: `starter/scripts/test/archive-library.test.mjs` (rights, file choice, border crop on a synthetic scan,
  the library round trip). The live LoC calls are not run in CI (rate limit); proven by hand on the first adopted site.

### Focal points (2026-11-03)

Why: layouts crop pictures to their own shape (a 21:9 hero band, 4:3 on phones, square cards), always about the
centre. On the first adopted site an archive photo of a painted price sign ("Seats five cents") had its sign at the
top of a portrait scan; every crop that fit the wide band lost the sign on phones, and every crop that fit phones lost
it on the band.

- An image field can carry `focalX` and `focalY`, shares of the width and height from 0 to 1. `Picture.astro` sets
  `object-position` from them on the image, so every layout's crop moves toward that point; without them nothing
  changes. They are the same two fields EmDash's media library stores ("Focal point as 0..1 fractions of width and
  height", the image field schema in
  [zod-generator.ts](https://github.com/emdash-cms/emdash/blob/main/packages/core/src/schema/zod-generator.ts), checked 2026-11-03), so a point an editor sets in the admin is honoured the same way.
- `check-content.mjs` fails a focal value that isn't a number from 0 to 1. The variants test builds a page with one
  and checks the rendered `object-position`.
- Proven on the first adopted site: a sign, a lit marquee and faces stay in frame in the hero band at 1280 px and
  on a 360 px phone. EmDash's own focal point picker has not been tried on a Framework B site: untested.

### One design language (2026-11-04)

Why: the first adopted site's home page carried its route (a poster stack) and its inner pages didn't. The owner:
the inner pages "kinda feel separate from the home"; "a large plain image taking up full width space on the screen is
not a modern design"; and the consistency "needs to be a part of framework b overall". Measured on that site's live
pages at 1280 px: the home title was 112 px, uppercase, left-aligned and set on the photo; every inner title was 84 px,
as written, centred, over a bare 1216 × 521 px photo band with no text on it or beside it. The route had been mocked
and chosen as a home page only, and nothing held the inner pages to it. Each page passed every check on its own.

Evidence:
- Nielsen Norman Group, [Maintain Consistency and Adhere to Standards (Usability Heuristic
  #4)](https://www.nngroup.com/articles/consistency-and-standards/) (checked 2026-11-04): images should all be "given
  a similar visual treatment", and elements such as headings stay the same across a site's different types of page.
- Design systems separate the home page's hero from a smaller "secondary" hero that starts every other page, built
  from the same parts: Morningstar's [Secondary Hero](https://design.morningstar.com/systems/marketing/business-website/components/hero?tab=Secondary+Hero)
  (the image at 4:3 beside the text, or a slot beside it; checked 2026-11-04) and HugoBlox's
  [Hero block](https://hugoblox.com/blocks/hero) ("compact" for "utility/secondary heroes"; text with media full
  width below is for "wide product screenshots"; checked 2026-11-04).
- Sites in the test site's own field, captured 2026-11-04 (home page and About page, 1280 and 390 px): NEON
  (neonrated.com) sets its home title in a 160 px uppercase condensed face on a full-bleed photo, and its About title
  in the same face at 190 px, type only; Film Independent (filmindependent.org) keeps its uppercase condensed titles
  on the About page and sets its mission statement in them; Sundance Institute (sundance.org) sets its About title
  beside a black and white photo cut on a diagonal. None of the three puts a bare photo band under a title.

What's built:
- `composition.titleCase` (as-written or upper) and `composition.heroes` (`home` and `page`, each one of the site's
  hero layouts) in DESIGN.md, checked by `design-tokens.mjs`. The hero's eyebrow takes the title's case too, so every
  page opens with the same label (on the first adopted site the fade hero's label was in lower case beside upper case
  ones on the other pages, 2026-11-06). A hero without a `variant` takes the route's layout;
  `check-content.mjs` fails a hero that sets another one (a hero with no picture may be a statement).
- The statement hero takes no picture (`check-content.mjs` says which layout to use instead), and its title follows
  `composition.align` instead of always centring.
- Pages the framework generates (contact, privacy, thanks, 404, website assets) set their title with
  `PageTitle.astro`, in the same treatment.
- QA gate (`scripts/lib/cohesion.mjs`): every page title in the home page's face, weight, case and alignment (size
  may differ); no bare photo banner at 1280 px (a photo at least 60% of the window wide and 30% of its height, with no
  text over it and none beside it); `site-sheet-1280.png` and `site-sheet-360.png`, the first screen of every page side
  by side. `--mixed-pages` turns the title check into notes for the layout test, whose pages mix heroes on purpose.
- The route method (`docs/BUILD.md` step 3): routes are mocked as a page family (the home page and an inner page) and
  recorded in DESIGN.md; the owner gets the site sheets with every preview.
- Unit tests: `starter/scripts/test/cohesion.test.mjs` (the title comparison, the banner check in a real browser,
  the sheet). The thresholds (60% and 30%) are a first setting, chosen so a split layout's photo and a gallery pass and
  the first adopted site's band fails; they have not been tried on other sites yet: untested.

### Variety within the family, and page flow (2026-11-04)

Why: one fixed layout for every inner page was too rigid. The owner, choosing between three inner-page heroes built
from the route: "a mix is good ... not every inner page needs to be the exact same layout either. a variety WITH
consistent look, feel, and flow"; and consistency must hold for "the entire page length and flow", not only the
hero. Measured on the first adopted site at 1280 px: the home page ran at most 3.6 screens without a picture, an inner
page 4.4; the home page ended on its closing photo panels, the inner pages on a list or a paragraph.

What's built:
- `composition.heroes.page` takes one layout or a list: the family the inner pages choose from (the first is the
  default). The content check fails a hero outside the family.
- `composition.closing`: the section type every content page ends on, as the home page does. A page with a form ends
  on the form; thanks, privacy and 404 pages are left alone.
- QA gate: the home page sets the rhythm of pictures; a page with pictures fails when it runs more than half a
  screen longer without one than the home page does (`pictureRhythm`, `rhythmBreaks` in `scripts/lib/cohesion.mjs`).
  A home page without pictures sets no rhythm. `--mixed-pages` turns it into notes.
- Unit test in `starter/scripts/test/cohesion.test.mjs`. The half-screen margin is a first setting: untested on
  sites other than the first adopted one.

### Style guide (2026-11-04)

Why: the owner of the first adopted site asked for "an in depth ... Style Guide to work from once the 'general'
homepage layout for the website/idea is determined", to "help decide all other pages, print, social, etc design
basics". Until then the decisions lived in DESIGN.md (tokens a machine reads), DECISIONS.md and the pages
themselves; nothing a designer, a printer or the next agent could open and follow.

Evidence:
- Nielsen Norman Group, [Design Systems 101](https://www.nngroup.com/articles/design-systems-101/) and [Design
  Systems vs. Style Guides](https://www.nngroup.com/articles/design-systems-vs-style-guides/) (checked 2026-11-04):
  style guides cover branding (colours, typography, logos, print media), content (tone of voice) and visual and
  interaction standards; front-end style guides are "rarely static" but living collections tied to the code.
- Vistaprint, [How to Create a Brand Style Guide](https://www.vistaprint.com/hub/how-to-create-a-brand-style-guide)
  (checked 2026-11-04): a guide needs print and digital specifications ("color values, file types, minimum logo
  sizes, spacing requirements, recommended image resolutions and bleed settings for print"), and "a clear two to
  five-page brand style guide can be incredibly effective".
- Brand guideline templates agree on the sections: brand story, logo, colour, typography, imagery, voice and tone
  shown "with real sentences rather than adjectives" ([Redokun](https://redokun.com/blog/brand-guidelines-template),
  checked 2026-11-04).

What's built:
- `STYLE-GUIDE.md` in every site (site-owned; the starter's template is seeded into an existing site once by
  **site update** and never touched again). Ten sections: Brand, Logo, Colour, Type, Photography, Layout and page
  flow, Components, Voice, Beyond the website, Do and don't. `check-content.mjs` fails a guide missing one.
- `node scripts/style-guide.mjs` builds the site with a temporary guide page (`scripts/style-guide/guide.astro`, the
  same way the style tiles are built) and prints `design/style-guide/style-guide.pdf` (US Letter, a section a page)
  and `style-guide.png`. Besides the written sections it shows the site's real colours with HEX, RGB and the contrast
  of every text pair, each type level set in the site's own words, every version of the logo with its clear space and
  smallest sizes (from `design/brand/logo.json`), the icons and share image, a sample of the
  site's photographs and their sources, the composition, the hero family and how every page ends, the sections in
  use, the first screen of every page at 1280 and 390 px, live buttons, a card and a form field, and the owner's
  wording. Print colours are left to the printer's own profile, as the printers ask.
- Beyond the website: share image, Instagram posts, Stories, the Facebook, LinkedIn, X and YouTube profile and cover
  images, a US business card and a flyer, each with its source and check date (`SPECS` in
  `scripts/lib/style-guide.mjs`). Ready-made social and print templates are not built yet.
- `design/style-guide/stamp.json` records a hash of DESIGN.md, STYLE-GUIDE.md and `design/brand/logo.json`. Once a
  guide has been rendered, the QA gate fails when any of them has changed since, so the guide stays the description of
  the site as it is. A guide rendered before the logo was an input stays fresh until the site has a logo kit.
- The guide's prose takes `code` spans (file names, commands) as written, and list items with one level of indented
  sub-items; the first adopted site's guide showed the backticks, and then its sub-items run into one paragraph.
- Tests: `starter/scripts/test/style-guide.test.mjs`, the update test for the seeded template, and a starter CI step
  that renders the template. With client editing on, the guide is untested.
- Found while building it: the QA gate's full-page screenshots (for people reviewing and for the critique rounds)
  showed photo panels below the fold as empty boxes, because waiting for an image's load event doesn't mean it is
  ready to paint. Screenshots now wait for every picture's `decode()`; the same panel measured a mean brightness of 8
  before and 121 after (first adopted site, 2026-11-04). The text-over-pictures measurement was not affected: it
  scrolls the page first.
- Proven on the first adopted site: its guide renders to 20 pages with its real colours, type, components, photographs
  and 16 page screens.

### Four lenses (2026-11-04)

Why: the first round of logo concepts for the first adopted site was drawn mostly from its field. The owner asked
that every piece of design research in Framework B look past the industry: "remember the actual business idea and
the business goals and the targets", consider "modern trends and up-to-date current modern trends the same way as
when we're doing the web design", and fit the site's own theme and images, so that the "entire design mantra" is
consistent through the framework.

Evidence (each checked 2026-11-04):
- Trend reports read trends as movement over years, not fads: "This is a trend report, not a trendy report"
  ([LogoLounge, 2025 Logo Trend Report](https://www.logolounge.com/trend/2025-logo-trend-report)); "This is a report,
  not a recommendation ... Your job isn't to mimic them" ([LogoLounge, 2026](https://www.logolounge.com/trend/2026-logo-trend-report)).
  So the current-design lens names which currents fit and why, and which to avoid.
- "Pick one trend that fits your story", then check it in black and white and "at 16×16 px and 16 feet away"
  ([99designs by Vista, logo trends for 2026](https://www.vistaprint.com/hub/logo-design-trends)).
- Nostalgia has to be specific: "nostalgic for who, and nostalgic for what?"
  ([KOTA, brand design trends for 2026](https://kota.co.uk/blog/branding-inspiration-brand-design-trends-for-2026));
  "If you can look at a design and not pinpoint the era, you're onto a winner"
  ([Envato, logo and branding trends 2026](https://elements.envato.com/learn/logo-and-branding-trends)).
- The field alone pulls a design towards its neighbours: on the first adopted site, three of four similar sites used
  condensed uppercase wordmarks, as did its own logo, and the closest of them had already split and spliced its name
  (by its designers' own account).

What's built:
- `design/research.md` in every site (seeded into existing sites once by **site update**, then site-owned), with four
  lenses: The business, The field, Current design, The site's own look. `check-content.mjs` fails a file missing a
  lens and notes one unwritten or without a dated source (the business's source is PRODUCT.md); the QA gate notes an
  unwritten one.
- BUILD step 3 starts with it, and every design step after it draws on it: drafts and routes (references from
  galleries of current design as well as the field), the logo brief (sections for the business, the site's own look
  and current design), each logo concept (`data-from`, `data-trend`, `data-look`, which `check` requires and the
  sheet prints), and the style guide's Brand section.
- Tested by `starter/scripts/test/logo.test.mjs` (the four lenses on a concept, and the research file's rules).
  Proven on the first adopted site: its research file and a second round of seven concepts, each naming the fact,
  the current design move and the part of the site's own look it comes from.

### Logo (2026-11-04)

Why: the owner of the first adopted site said its logo, made by the brand kit, was "super-generic and doesn't really
fit the brand", and asked for "a logo design method/research/design/dev" in Framework B. The brand kit set the name in
the display font in six fixed layouts: no brief, no idea from the business, nothing that sets it apart. A look at
four similar sites the same day found condensed uppercase wordmarks on three of them, two with red, and the site's logo
was the same recipe.

Evidence (each checked 2026-11-04):
- The process professionals describe starts with the brand and the field, lists where the logo will be used, sketches
  many concepts, refines a few as vectors and delivers full colour, black, white and one-colour versions
  ([99designs, Logo design process](https://99designs.com/blog/tips/logo-design-process-how-professionals-do-it)). A
  brief names three adjectives wanted and three rejected, the competitors, and every touchpoint with the smallest
  size ([Malbar Design, Logo design brief](https://malbardesign.com/logo-design-brief)); a word bank comes with an
  "avoid list" of clichés, and the strongest ideas are distilled to two or three
  ([Ramotion, Logo design principles](https://www.ramotion.com/blog/logo-design-principles)).
- A logo should be designed in black and white first and still work in one colour, reversed, at the size of a postage
  stamp and as large as a billboard ([Smashing Magazine, Vital tips for effective logo
  design](https://www.smashingmagazine.com/2009/08/vital-tips-for-effective-logo-design)); the most common mistake is
  not testing it small or in black and white ([Vistaprint, Principles of logo
  design](https://www.vistaprint.com/hub/principles-of-logo-design)).
- The types: wordmarks, lettermarks, pictorial marks, abstract marks, mascots, combination marks and emblems
  ([Vistaprint, Types of logos](https://www.vistaprint.com/hub/types-of-logos)).
- Favicons: square, at least 8 px, larger than 48 px recommended; Google Search supports BMP, GIF, ICO, PNG, JPEG,
  PPM and TIFF (SVG is not listed) ([Google Search Central, Favicon in search
  results](https://developers.google.com/search/docs/appearance/favicon-in-search)).
- Maskable icons: the important part sits inside a centred circle with a radius of 40% of the icon
  ([web.dev, Maskable icons](https://web.dev/articles/maskable-icon)).
- Contrast: logos are exempt from WCAG's contrast requirements, but where a logo is a control (the header logo links
  home) W3C advises a version with enough contrast ([Understanding SC 1.4.11 Non-text
  Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)); Framework B holds every version to
  3:1.
- Fonts: OFL fonts may be used in logos and their outlines in artwork ([OFL FAQ
  1.1](https://openfontlicense.org/ofl-faq)). Trademarks: search the USPTO database for confusingly similar marks
  on related goods and services before filing ([USPTO, Trademark registration
  toolkit](https://www.uspto.gov/sites/default/files/documents/TM-Registration-Toolkit.pdf)).

What's built (`starter/scripts/logo.mjs`, `starter/scripts/lib/logo.mjs`):
- `brief`: `design/brand/brief.md` with ten sections (the business, who it must reach, feel, the site's own look,
  current design, sea of sameness, clichés to avoid, ideas from the brand's own world, where it must work, keep),
  written from `design/research.md`. `check` fails an unwritten one, and `pick` refuses a designed concept until the
  brief is written.
- Concepts are SVG files the agent draws: a mark (square, for icons) and a lockup (the header logo), optional
  stacked. Two colour roles only, ink and accent; cut-outs are holes (masks or even-odd fills), never the background
  colour, so the one-colour and reversed versions are exact. Words are `<fb-text>`, set in the design's fonts and
  converted to outlines, in a straight line or round a seal (`arc`); `viewBox="auto"` measures the drawing. Every
  designed concept names the fact it comes from, the current design move it uses and how it belongs to the site's
  own look (`data-from`, `data-trend`, `data-look`). `check` refuses fonts in `<text>`, pictures, styles, filters,
  gradients, outside links, raw colours and a concept missing any of those.
- `sheet` tests every concept as it will be used: the header at 36 px, a 390 px phone header, dark and light paper
  from the design (the page colour and its inverse band), one colour black and white, on the home page's photo, the
  mark at 16, 32 and 48 px with the 16 px rendering enlarged, light and dark browser tabs, a circle avatar, the
  maskable icon with its safe zone, and a business card at full size. `sheet <id>` redraws only those concepts and
  leaves the others' sheets, the overview, `design/brand/concepts.pdf` and `design/brand/concepts.json` as they were (a one-concept run once
  wiped the others' sheets on the first adopted site). It notes a version whose accent falls under
  3:1 (that version draws the accent in ink) and a header logo wider than 240 px. `design/brand/concepts.pdf` holds
  them all for the owner.
- `pick` writes the kit: `public/logo.svg` (the version for the page colour), `logo-on-dark.svg`,
  `logo-on-light.svg`, `logo-black.svg`, `logo-white.svg`, `mark.svg`, `favicon.svg`, `favicon-96.png` (linked by
  the layout when the kit exists), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
  `og.png` and the manifest; vector PDFs (PDFKit and SVG-to-PDFKit, both MIT: Chromium's print to PDF turned masks
  into pictures) and 2000 px PNGs of every version and a 1000 px avatar in `design/brand/kit/`; and
  `design/brand/logo.json` with the versions, colours, clear space (a quarter of the logo's height unless the concept
  sets `data-clear`) and smallest sizes (the smallest the sheet checks: the logo 24 px tall and the mark 16 px on
  screens, 6.4 mm tall in print). The style guide shows all of it, and the QA gate fails a kit with a file missing.
- Tests: `starter/scripts/test/logo.test.mjs` (the format, versions, expansion and brief) and the starter CI step
  `scripts/test/logo.mjs` (templates, a designed concept checked, sheeted and picked into the full kit with
  picture-free PDFs, and a bad concept refused).
- Tried on the first adopted site: a brief from its records and a look at its field, and eight concepts (seven ideas
  and its current logo) sent to the owner on 2026-11-04. On a test copy of the site, `pick` installed one of them
  and the QA gate passed with it (434 checks, including the complete kit and the style guide rendered with it). Live
  on that site since 2026-11-05, picked by the owner from the second round.

### Balance, crops and the logo's size (2026-11-05)

Why: looking through the first adopted site's inner pages on a desktop, its owner found "a lot of sections ... that
seem like they're floating off to the left with a ton of open space to the right" and asked for "different styles of
website sections here to fill this out", with "modern layouts" and "the modern flow" through "the entire pages"; hero
photos "not framed or cropped the best way" ("we've got the heads cut off"); and a header logo "not even as tall as
the ... buttons". All of it "needs to be considered into framework B as a whole". Measured on that site at 1280 px
(2026-11-05): 14 sections set their text in a reading column on the left of the page, with nothing on the right half
of the window (a headline over prose, a single list, a stacked form, a people section's text over its photos); the
header logo was 36 px tall beside buttons of 44 and 48 px; and no hero photo named its focal point but one, so each
was cropped about its centre.

Evidence (each checked 2026-11-05):
- Nielsen Norman Group, [5 Principles of Visual Design in UX](https://www.nngroup.com/articles/principles-visual-design):
  "Balance occurs when there is an equally distributed (but not necessarily symmetrical) amount of visual signal on
  both sides of an imaginary axis going through the middle of the screen."
- Lines keep to the prose width: 50 to 75 characters a line ([Baymard Institute, Line
  Length](https://baymard.com/research-articles/line-length-readability)), and at most 80 for WCAG 1.4.8. So the fix
  is a layout, never wider text.
- Current layouts outside any one field use the empty side: asymmetrical layouts ([GoDaddy, web design
  trends](https://www.godaddy.com/resources/skills/web-design-trends)); "Organic, Anti-Grid Layouts", alternating
  "wide and narrow blocks down the page" ([Barnimages, web design trends](https://barnimages.com/blog/tips/web-design-trends));
  asymmetric grids becoming the default ([Pravin Kumar, asymmetric grid layouts
  2026](https://www.pravinkumar.co/blog/webflow-asymmetric-grid-layouts-2026)).

What's built:
- Split layouts (`src/sections/sections.css`, `.split-row`: 5 to 7 columns from 1024 px, stacked below). The headline
  and its eyebrow stay in view beside the text as it scrolls (`SectionIntro` with `side`), and lines keep the prose
  width. Text: `split` (the new default with a headline), `prose`, `lead` and `center` (a centred reading column, and
  the default without a headline). Lists: `columns` (a single list goes beside its headline), `split`, and `stack`
  (now centred). People: `aside` (the text on the left, the photos beside it on the right: stacked beside a long text,
  two to a row beside a short one), and `grid` puts its text beside the headline. Forms: `split` (the default; the
  introduction beside the form, or the form centred if there isn't one) and `stacked` (centred). Steps: the `timeline`
  runs beside its headline. A statement hero set left puts its text and buttons beside the title. FAQ: `stack` is centred. Call to action: set left, the words take the left of a wide screen
  and the button the right.
- QA gate (`scripts/lib/cohesion.mjs`, `balance`): at 1280 px, every section's visual weight (the area of its text
  lines, pictures, form fields and filled boxes) is measured either side of the middle of the window, in windows of
  800 px down the section. A window fails when one side carries less than 10% of the weight and its content runs less
  than a quarter of the way across that half (a short text beside a large photo is light but fills its side; the
  starter's full-site fixture found that case in CI); a sticky column counts wherever its row runs. What a page sets in `<main>` outside its sections (the pages the framework generates) is one more block;
  the Website assets page sets its credits in two columns on wide screens for it, the generated privacy page sets
  each topic's heading beside its text, and the generated thanks and 404 pages set their text beside the title (the
  thanks page with a link back to the home page). Run on the first adopted site, it found the same 14 sections as the measurement above and no others; the
  thresholds are a first setting, untested on other sites.
- Crops (`crops`, `cropSheet`): at 360 and 1280 px, every picture a layout crops (`object-fit: cover`) with how much
  of its width and height shows and where. A crop that cuts a third or more off one of them fails unless the picture
  names its focal point on that axis (`focalX`, `focalY`; `Picture.astro` marks the ones set with `data-focal-x` and
  `data-focal-y`). The centre is a fine answer when it is chosen; the gate can't see heads, so it makes the agent
  look. `qa-output/crop-sheet-1280.png` and `crop-sheet-360.png` draw each crop over its whole picture, the part that
  shows outlined, and `crops-<width>.json` lists them. Look at both sheets before showing the owner anything.
- The logo's size: `composition.logo` in DESIGN.md. `standard` is 48 px tall, as tall as the buttons; `large` is 56 px
  on phones and 72 px from 768 px; `masthead` puts the logo on a row of its own, as wide as the content column, with
  the links and buttons under it (on phones the logo is as wide as the screen less its margins). The width and height
  attributes come from the kit's aspect (`design/brand/logo.json`), and the layout sets `--header-height` for the size
  chosen, so a hero that fills the first screen less the header (`calc(100svh - var(--header-height))`) still ends on
  it. The QA gate fails a header logo shorter than the tallest link or button in the header or the phone bar, at 360
  and 1280 px (`logoFit`).
- Screen-reader-only text (Tailwind's `sr-only`, a 1 px box) carries no weight and is not measured over pictures: a
  skip link's text boxes fell on a header logo tall enough to count as a picture and failed the contrast check on
  every page (first adopted site, 2026-11-05).
- Tests: `starter/scripts/test/cohesion.test.mjs` (a left column fails, a split row, a centred column and a row of
  pictures pass; a hard crop without a focal point is listed, one with it isn't, and the sheet draws them; the logo is
  measured against the buttons) and the layout test (`starter/scripts/test/variants.mjs`), whose pages now carry
  every new layout through the whole QA gate.

### Accent words, wide statements, fade heroes, the footer and the mark (2026-11-06)

Why: on the first adopted site, the owner found the long text blocks under a big heading too narrow ("this is not
wide enough, so maybe it should span approximately 80% of the distance instead of ... 50% centered"), asked for chosen
words of those headings in the accent colour ("pick words that draw attention"), for the side-by-side heroes to stop
looking "just there instead of a part of that section" ("make the photo the entire section height ... fade as it
reaches the giant heading ... and turn into the background color"), for the phone footer to be fixed, the logo to
appear in the footer, and the favicon's shape to be "worked in ... in various places that makes sense".

Evidence (each checked 2026-11-05):
- A spot of colour on a key word guides attention; use the brand's colour, on a word or short phrase, never a whole
  sentence, one accent per section ([SSW Rules, "Do you add a spot of color for text emphasis?"](https://www.ssw.com.au/rules/add-a-spot-of-color-for-emphasis)).
- A statement band gives "one concise statement an entire field" at display scale ([Pixelgrade Pattern Language,
  Statement / Quote Band](https://pixelgrade.com/pattern-language/)). Reading lines stay at 50 to 75 characters
  ([Baymard Institute](https://baymard.com/research-articles/line-length-readability)): a block four fifths wide sets
  its text in two columns to keep that measure.
- A gradient mask fades an image into whatever is behind it, without a second image ([Ahmad Shadeed, CSS
  Masking](https://ishadeed.com/article/css-masking/)).
- Footers on phones: one column for the brand, link groups stacked or collapsed, tap targets of at least 44 by 44 px
  ([UXPin, footer design](https://www.uxpin.com/studio/blog/footer-design-basics/); [Red Hat Design System,
  footer](https://ux.redhat.com/elements/footer/guidelines/)). The "big footer" or wordmark footer ends the page on
  the brand ([Wix Studio](https://www.wix.com/studio/blog/big-website-footers); [Pixelgrade, Wordmark
  Footer](https://pixelgrade.com/pattern-language/wordmark-footer/)).

What's built:
- `==word==` in any headline or text field sets it in the accent colour (`src/sections/text.js`: `accent()` for
  headlines, `inline()` for text; the Markdown "mark" convention). On a band that is the accent colour, the word takes
  the band's text colour, underlined. Headlines of the hero, section introductions, split and call-to-action sections
  take it.
- Text `wide`: the headline across four fifths of the page, the text beneath in two columns (one on phones), the
  paragraphs flowing on from one column to the next (at least three lines either side of a break), so a short
  paragraph beside a long one doesn't leave a column nearly empty. A single paragraph sits beside the headline instead,
  so neither half of the band is empty (the first adopted site's balance check, 2026-11-06). The people section's
  closing note is set the same way.
- Hero `fade`'s masks ease in (a colour hint past the middle of the ramp): a straight ramp left a visible line where
  the photo started (2026-11-06).
- Hero `fade`: the photo fills the band's height on the right and fades into the background towards the headline
  (`mask-image`); on phones it sits above the headline and fades out before it. The text never sits on the photo.
  A headline longer than 40 characters is set a step down, at the headline size: at display size a whole sentence
  ran to four lines in the text column (under half the window) and failed Impeccable's oversized-h1 ("set long
  headlines smaller") on the first adopted site (2026-11-11). Face, weight and case stay the same, so every page's
  title still reads as one treatment.
- Footer: link groups two to a row on phones with 44 px tap targets (24 px from tablet width, the WCAG 2.2 target-size
  minimum: axe flagged 20 px links on the first adopted site, 2026-11-06); Privacy is left out of the bottom row when a
  column links it; with a logo, the footer ends on the logo across the content width (`composition.footer`:
  `wordmark`, the default, or `plain`).
- `composition.ornament: mark` puts the logo kit's mark (the favicon's shape) before every eyebrow label
  (`src/sections/Eyebrow.astro`).
- Tests: `starter/scripts/test/spot.test.mjs` (accent words) and the layout test's fourth page (a fade hero whose
  headline is a whole sentence, a wide statement with accent words, accent words on an accent band) through the whole
  QA gate. The footer's wordmark and
  the eyebrow mark need a logo kit: proven on the first adopted site, untested in CI.

### Spot colour (2026-11-06)

Why: the first adopted site's photographs are black and white archive and owner photos. Its owner asked for "our pop
of color in just one spot in each of these photos", one item "like an article of clothing, or camera, or film strip -
something on a person or used in filmmaking or relevant to the theme ... not something super random", made with AI,
listed on the Website assets page with "the gist of the prompt ... what model ... and the date", and for visitors to
be able to "download the script and/or give them a prompt ... to do the same".

Evidence (each checked 2026-11-05 or 2026-11-06):
- Hand-colouring photographs dates from 1839 and ran through prints, lantern slides and transparencies
  ([Wikipedia, Hand-colouring of photographs](https://en.wikipedia.org/wiki/Hand-colouring_of_photographs)): a spot of
  colour on an old photograph belongs to the period.
- The W3C "color" blend "preserves the gray levels of the backdrop and is useful for coloring monochrome images"
  ([Compositing and Blending Level 1, 10.2.3](https://www.w3.org/TR/compositing-1/#blendingcolor)). It keeps Rec. 601
  luma, of which a saturated red carries little, so on the first adopted site a dark cloth came out as a flat bright red
  with its folds lost (2026-11-06). OKLab is built so that lightness is perceptual
  ([Björn Ottosson](https://bottosson.github.io/posts/oklab/); coefficients as in the
  [oklab crate](https://docs.rs/crate/oklab/latest/source/src/lib.rs)): holding its L and setting the accent's hue and
  chroma keeps the photograph's light and shade. Where that chroma doesn't fit sRGB, CSS Color 4 reduces chroma by
  binary search while holding lightness and hue ([gamut mapping](https://drafts.csswg.org/css-color-4/#gamut-mapping),
  as implemented in [Servo](https://doc.servo.org/src/style/color/gamut.rs.html)).
- SlimSAM (Xenova/slimsam-77-uniform on Hugging Face), a compressed Segment Anything model, Apache-2.0, runs locally through
  Transformers.js (`@huggingface/transformers` 4.3.1, Apache-2.0, released 2026-10-06) from a point prompt
  ([model card](https://huggingface.co/Xenova/slimsam-77-uniform)). Its ONNX decoder takes points and labels only:
  a box prompt is dropped with a warning, so the script applies a box afterwards as a limit.

What's built (`starter/scripts/spot-colour.mjs`, `scripts/lib/spot.mjs`, `scripts/lib/spot-tool.mjs`):
- `mask` outlines one object from points on it (and `--not` points off it), limited to a box; for lettering on a sign,
  `--tone dark|light` takes the dark or light pixels inside a box or a four-cornered shape, with no model. It writes
  a preview (the photo, the outline, the tint) to look at before anything changes.
- `apply` keeps the untinted photo in `design/spot/<name>/original.*`, tints the object with the accent (in OKLab:
  each pixel keeps its lightness and takes the accent's hue and chroma, reduced only where sRGB can't show it, after a
  tone curve that moves the object's middle tone halfway to the accent's lightness, so a pale object reads red rather
  than pink and a dark one red rather than near black), and records what, colour, the model that chose it, the outline method and the date in
  `design/credits.json`. `undo` restores the photo; `sheet` draws every photo before and after.
- The Website assets page says, in each picture's one entry, what was coloured and how its outline was made, then,
  under "How the colour was added", the site's note (`spotNote` in `design/credits.json`, the owner's brief in plain
  words), how it was done, a download of the script (`public/tools/spot-colour.mjs`, standalone: `sharp` and
  Transformers.js only, MIT) and of a prompt for any AI model or agent (`public/tools/spot-colour-prompt.md`), shown on
  the page as well. It doesn't list the photographs again.
- Never a face or skin, never something random, one object per photo; generated detail is never added.
- Tests: `starter/scripts/test/spot.test.mjs` (the dye keeps lightness and hue and stays in sRGB, a fold in a dark
  cloth stays visible, the tone curve, the tone mask in a
  four-cornered shape, the visitor's script parses and carries the same arithmetic, the prompt's content). The model
  run itself is proven on the first adopted site (19 photographs, 2026-11-06), not in CI (the runtime is about 750 MB).

Second round (2026-11-10). The first adopted site's owner reviewed every photo later on 2026-11-06: "the entire camera and
tripod", the film "in the top reel and the film in the bottom reel, plus as it flows through the projector", a shirt
"missed some parts", a jacket that "missed the collar", "the roundish looking light bulbs that are all throughout
this photo", a headset, a short-sleeved T-shirt over a long-sleeved one ("start with a color image"), a stray red line
along the top of a sign, and a portrait cropped so a second person's face is mostly out of frame. One click outline
can't do these, so an outline is now built from pieces:
- `--add` and `--cut` add a piece to the outline so far or cut one out of it; `design/spot/<name>/spot.json` keeps every piece in order
  (`parts`, each with its method), and the credit names every method used. Outlines and previews always come from the
  untinted photo (`design/spot/<name>/original.*`), so an earlier tint can't steer the segmenter.
- A bare `--box` or `--quad` with `--add`/`--cut` takes that shape whole, and `--ellipse cx,cy,rx,ry` draws a round
  piece (a reel face on, a mouthpiece): for parts the segmenter misses or over-reaches. On the first adopted site it
  took a background rectangle for a tripod's leg and a chair for another, so those legs were drawn by hand.
- `--from <file>` outlines on a colour original of an owner's photo (same framing), where two garments are one grey in
  black and white; the tint still goes on the photo itself.
- `--fill` fills holes inside an outline smaller than 1% of it (a printed logo, a crease).
- `--spots radius[,contrast]` finds round bulbs as peaks of a difference of Gaussians tuned to their size, a faster
  stand-in for the Laplacian of Gaussian with a blob's radius √2 times its scale
  ([scikit-image, Blob Detection](https://scikit-image.org/docs/0.23.x/auto_examples/features_detection/plot_blob.html),
  checked 2026-11-10). A first version kept small round patches of light pixels; on the first adopted site the bulbs
  touch a lit sign as bright as they are and merged into it, so it found almost none (2026-11-10). Each spot keeps the
  pixels within its radius at least halfway from its surroundings to its peak; lettering in the area makes spots too,
  so the sign's face is cut afterwards.
- `--open radius` drops anything thinner than `2 * radius + 1` pixels from a tone piece and keeps the rest whole, a
  morphological opening ([Wikipedia, Opening (morphology)](https://en.wikipedia.org/wiki/Opening_(morphology)),
  checked 2026-11-10): the sliver of shadow under a sign's edge between the tops of its letters (the stray red line).
  With `--cut`, the thick bright things (the lamps in a ceiling) come out and a thin neon tube stays.
- `--local radius` measures each pixel against the average within that radius instead of a fixed lightness, for a
  neon tube across a ceiling lit unevenly from end to end (a fixed threshold took the bright end's ceiling and missed
  the dim end's tube).
- `node scripts/images.mjs crop <file> --cut l,t,r,b [--also <file>]` crops a photo, keeping the uncropped copy as
  `design/image-candidates/<name>-uncropped.<ext>`; a second crop is cut from that copy with both cuts made into one, and the credit records
  the whole cut (`cropped`) and "Cropped." once. `--also` crops a colour original for `--from` the same way. A tinted
  photo is cropped only after `undo`; its outline is then made again.
- Tests: the same file covers holes, spots beside an even sign, the opening, the local tone mask and the repeat crop.
  The pieces, `--from` and the segmenter runs are proven on the first adopted site's 19 photographs (2026-11-10), not
  in CI.

Third round (2026-11-10). The owner's notes on the second round: the film running "through the front side around by
her hands and then through the mechanics and then onto the lower reel" (the strips coloured last time were the
projector's rods), a sleeve missed and a hand taken, a neck taken, "the entire camera tripod and rolling rig" with its
handle, a coat "further down in the depth" mixed into the right man's suit, a T-shirt sleeve whose hem "is fairly
straight across", a cuff, a tripod's third leg and the part of a leg seen through the others, and for a marquee "all of
the squiggly lighting ... not the bulb lighting": the neon above it, under it and over the box office. Building that
neon showed two faults and two gaps in the tools:
- Every piece wore the outline down. The outline so far was read back from the soft-edged `mask.png` at half: a blur
  then a threshold, once per piece, pulled the end of a thin tube back a little each time and dropped a line two
  pixels thick at once (on the first adopted site, tube ends had receded from their electrodes after about 70 pieces).
  Pieces now combine on `design/spot/<name>/outline.png`, a hard-edged copy written with every piece; `mask.png` keeps
  the soft edge the tint goes through. An outline saved before `outline.png` existed is read from `mask.png` once.
- `--local` compared single pixels with their surroundings, so the grain of a scanned print passed for tube, and
  `--open`, used to clear the grain, broke thin stretches of tube into dashes. Each pixel is now averaged with its
  neighbours (a Gaussian of one pixel) before the comparison.
- `--specks pixels` drops any separate part of a tone piece smaller than that many pixels (grain, the halo round a dark
  screw head in a ceiling), counting parts that touch at a corner as one; unlike `--open` it never breaks a thin line.
- `--grow radius` widens a tone piece by that many pixels all round, after `--open`, so a neon tube takes in its glow
  and reads as lit in the accent rather than as a hairline.
- A tube along a sign whose own lightness defeats every automatic method (the top of the marquee, against a sky and
  lettering as bright as it) is traced instead: its centre line read from columns of the photo at regular steps, then
  one narrow `--quad` a step with `--local`, so the tube's own pixels inside each band are taken.
- Tests: the outline keeps a thin tube's whole length through six more pieces, grain doesn't pass `--local`, specks go
  while a thin tube stays (where opening would break it), and growing widens a piece evenly. The rest is proven on the
  first adopted site (2026-11-10).

### Website assets: how AI was used (2026-11-10)

Why: the first adopted site's owner asked that the Website assets page "mention each area ... and how AI is used on
these photos", including that AI chose them from the Library of Congress, cropped them and chose and added the film
look: "everything that we've used AI for to create these images". The page listed colour added with AI and generated
images, but not the choosing, cropping, framing, look and descriptions that the agent also did.

What's built (`starter/src/lib/ai-use.js`, `src/pages/credits.astro`):
- The tools record what AI did with each image as `ai` in `design/credits.json`: `images.mjs add` writes `chose`,
  `alt`, `treated` when the design's treatment was applied, and `cropped` for an archive scan trimmed inside its
  borders; `images.mjs crop` adds `cropped`, `images.mjs treat` adds `treated`, `logo.mjs pick` writes `drew` on the
  logo and everything made from it, and `generate-image.mjs use` writes `generated`. `aiBy` names the model once:
  `--by "<model>"` on any of these tools (and `spot-colour.mjs apply --by`) sets it when it is missing, and the content
  check fails an `ai` record or a spot with no `aiBy`, and any step it doesn't know (CI's logo test picks with `--by`). A record is only ever what a tool did or what the agent says it did: nothing is
  claimed for an image without one, so an owner's photo edited by hand says nothing about AI.
- The page opens with a line beside its title, then "The pictures": a summary of what the model did across them (chose
  the archive photographs from which archives, cropped them and framed them for each layout, gave them one look, wrote
  their descriptions for screen readers, added the spot of colour, drew the logo), that the owner provided their own
  pictures and the model didn't choose those, that no photograph was made up when none was generated, and, where a
  photo tops a page, that the page lays a dark gradient over it or fades it so its words can be read while the file is
  unchanged. Then every picture once, in the order the site shows them: its description, where it appears (from the
  pages' content: the top of a page, or the card, person or door it sits in, each spot once with its pages), where it
  comes from (title, creator and licence or rights statement with links; the owner's own, in the owner's words
  (`credit`); or the generator), what the model did with it in the order the work was done (framing comes from the
  focal points the pages give it), and, for a spot of colour, how its outline was made from its record (SlimSAM, its
  tone, round spots of light, shapes the model drew itself; the tool's "drawn by hand" means shapes whose corners the
  agent gave, so the page doesn't call them hand-drawn). The logo and its icons are one entry. A picture with no AI
  record shows its `changes` instead.
- Round 4 (2026-11-10): the first adopted site's owner saw the sources, the AI use and the colour listed in three
  places and asked to "put all of these together so we're not mentioning each photo multiple times", and pointed out
  that a still from their own film was provided, not chosen; the summary had said the model "chose the photographs",
  which read as every one.
- With client editing on, "where it appears" comes from the content files, not later edits in the editor (untested).
- Tests: `starter/scripts/test/ai-use.test.mjs` (where each picture is, only recorded steps are claimed, the brief
  wording for an entry, the summary, the owner's pictures set apart, how an outline was made, and the gradient only
  when a picture tops a page). The page's layout passes the QA gate on the first adopted site; more than four entries
  sit under a heading across the page, because a long list beside a short heading failed Impeccable's "one column
  stretches the first viewport" there (2026-11-10).

### The poster route (2026-11-11)

The first adopted site's route, built there first as site-only sections and moved into the starter at the owner's
request (2026-11-11), so any site can choose it. It suits a site whose pictures carry the page: archive or owner
photographs, a strong display face, and few words.

- **Sections and layouts:**
  - `fb_panel` (image panel): a photograph across the full width, the title set very large and bleeding off its bottom
    edge, a short text and a link on a scrim block (`text_side` left or right).
  - `fb_doors` (image doors): two or three panels side by side, each a title, a line and a link, so a visitor picks
    their path; stacked on phones. A route can make it the closing section (`composition.closing: fb_doors`).
  - Hero `poster` (the home page's): the photo across the first screen, the title along the bottom edge, the sentence
    and actions on a scrim block; on phones the title comes first, so the fixed action bar never covers it.
    `poster-page` (an inner page's): the same, shorter, the title a step smaller. `poster-card`: the title beside a photo
    in a 4:5 frame, for form pages, so the form comes up quickly. `poster-edge`: the title beside a photo that runs to
    the edge of the window.
  - Features `posters`: tall cards, the title over the item's photo (`image` on each item), or type only on the poster
    colour or outlined. Phones stack them one to a row by default, the photo above the title.
  - Text `statement`: the headline very large, the text in two columns beneath it.
  - A section's `tone: "inverse"`: one band in DESIGN.md's inverse colours (a light band in a dark design, a dark one
    in a light design); it doesn't count as one of the alternating bands.
- **Any design, light or dark.** Text on a picture is set in `on-scrim` over `scrim`. `design-tokens.mjs` derives them
  when DESIGN.md doesn't name them: the scrim is the darker of ink and bg, the text the lighter (and `on-scrim-muted`
  is ink-muted in a dark design, bg in a light one), and checks each pair at 4.5:1. `poster` and `poster-ink` default to
  accent and accent-ink. The inverse colours (`inverse-bg`, `-surface`, `-ink`, `-ink-muted`, `-line`, `-field`,
  `-accent`, `-accent-ink`) come all eight or none, with their own contrast pairs; the content check fails an inverse
  band without them. Optional type levels `display-xl`, `display-l` and `lede` are used when DESIGN.md has them;
  otherwise display and body stand in. The title case follows `composition.titleCase`.
- **Panel titles never break inside a word.** Their size is capped so the longest word fits across the panel, from the
  display face's average capital width (`composition.titleFit`, em). Measured with `node scripts/logo.mjs measure
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ"` (2026-11-11): a condensed face at 800 is 0.45 (the first adopted site sets 0.5), Oswald
  700 0.53, DM Serif Display 0.61, Space Grotesk 700 0.63, Roboto 700 0.64, Hanken Grotesk 800 0.65, Playfair Display
  700 0.68, Inter 700 0.70, Fraunces 800 0.75, Archivo Black 0.77. The default, 0.75, keeps all but the widest whole;
  a route sets its face's width plus about a tenth.
- **Text over pictures, clipped:** a title that bleeds off a panel is clipped by it, so the QA gate's text-over-picture
  check now measures a line only where it shows (`scripts/lib/image-text.mjs`). Before, the hidden part was measured
  against the next section's background: 1:1 on a light page. `image-text.test.mjs` checks a clipped title passes and
  the same title running loose onto the page below fails.
- **Tested:** the layout test's four poster pages (`scripts/test/variants.mjs`: every layout above, an inverse band and
  doors, in the second composition, a light design) pass the whole QA gate (505 checks, locally, 2026-11-11). The first
  adopted site ran the route live, in a dark design, from 2026-11-03.

Rules:

- **No invented proof.** No testimonials, logos, counts, statistics or faces without an owner source. The agent never generates the business's own people, premises, products or work, and never a recognisable face.
- **Routes, not skins.** With an owner, the options are whole page skeletons on the site's real content, not font and colour swaps of one page (BUILD step 3).
- **Build on the site, promote on the second use.** Section layouts a route needs live in that site's `src/sections/` until a second site needs them.
- **Text over pictures is measured, not judged by eye** (QA gate, section 8).
- **Sideways strips on phones are a choice** for a set of like items to browse, not just a way to shorten the page; each one carries the swipe cue and is listed by the QA gate.
- **Credits on the Website assets page only,** never beside the image. Archive scans are cropped inside their borders. The page's lists keep to the prose width, so long credit lines stay readable (they failed Impeccable's line length at 1280 px on the first adopted site, 2026-11-03).
- **A photo taken off a page goes to the library,** never the bin.
- **A design runs through every page.** A route, image style or phone rule isn't done until the inner pages have it too.
- **Four lenses for every design decision.** Routes, logos, style guides, images, print and social pieces are each looked at through the business and its goals, its field, current design (dated, from outside the field too) and the site's own look, recorded in `design/research.md`; never the industry alone (owner's request, 2026-11-04).
- **A logo is an idea, not a font.** A designed logo starts from a written brief, comes from something only this business has, is tested at its real sizes and in one colour, and is picked by the owner from several concepts (owner's request, 2026-11-04).
- **A style guide before the other pages.** Once the home page carries the route, its style guide is written and rendered, and every other page, post and print piece is made from it (owner's decision, 2026-11-04).
- **One design language.** A route is a page family: the home page may be louder, but every page shares the title treatment, the image treatment and the way type meets a picture. Pages vary within the route's family of layouts, and the flow (the rhythm of pictures, the ending) runs the whole length of every page. A photo goes with the title or with text beside it, never in a bare band (owner's decisions, 2026-11-04).
- **Accent words sparingly.** A word or a short phrase of a big headline in the accent colour (`==word==`), not every headline and never a whole sentence.
- **Spot colour: one object, chosen for the story, all of it.** Clothing, a camera and its tripod, film, a ticket, a sign, the bulbs round a marquee; never a face or skin; the whole object, built from pieces where it has several, and nothing beside it; the untinted photo kept; listed on the Website assets page with how it was made.
- **Say what AI did with every picture, once per picture.** The tools record each step (chosen, cropped, given the look, described, coloured, drawn, generated) and the Website assets page gives each picture one entry: where it comes from, where it appears and what the model did; the owner's own pictures are provided, never "chosen"; nothing is claimed without a record.
- **Balanced sections, chosen crops, a logo at least as tall as the buttons.** No section leaves one side of a wide screen empty: the headline goes beside the text, the text is centred, or pictures go beside it, and lines keep the prose width. A picture cropped by a third or more names its focal point, and the crop sheets are looked at before the owner sees anything (owner's request, 2026-11-05).
- **Photos in a card set: most cards, not some.** A type-only card is a deliberate accent; each photo is picked for what its card says (owner's decision, 2026-11-03).
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
