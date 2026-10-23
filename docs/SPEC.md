# Framework B specification (v2, draft)

How an AI agent builds, launches and hands off a website with this framework. Written 2026-10-22. Vendor facts carry the date they were checked. The design phase (P2) follows `docs/research/design-layer.md`, pending owner review.

## 1. What a Framework B site is

- **Pages:** Astro 7, mostly static, served as Workers static assets.
- **Runtime:** one Cloudflare Worker per site, built from `packages/core`. It handles:
  - form submissions and file uploads
  - `/api/health`
  - `/u` unsubscribe
  - `/admin` behind Cloudflare Access
- **Data:** D1 is the system of record for leads and subscribers. R2 holds uploads and backups.
- **Protection:** Turnstile on every form, a honeypot field, an origin check, size limits, a per-IP rate limit (Workers rate limiting binding; untested on the Free plan), and Access on `/admin` and previews. The Worker also verifies the Access JWT itself.
- **Deploys:** Workers Builds. A push to `main` deploys production; any other branch deploys a preview URL.
- **State:** each site has its own repo holding `site.config.json`, `DESIGN.md`, `DECISIONS.md`, `HANDOFF.md` and `SECRETS.md` (names only). Any agent can resume a site from its repo.
- **Owner's machine:** nothing a site needs runs there.

## 2. Modes

| | Idea | Launch |
|---|---|---|
| Address | `<site>.<account>.workers.dev` | Own domain; `www` → apex via a Single Redirect rule |
| D1 | Shared `ideas` database, `site` column | Own `prod` + `staging` databases |
| R2 uploads | Shared `ideas-uploads`, prefix `<site>/` | Own bucket |
| Owner notification | Apps Script mailer (owner's Gmail) | Cloudflare `send_email` from `notify@<domain>` |
| Lead auto-reply | Optional, Apps Script mailer | Resend on `mail.<domain>` |
| Newsletter / drips | Not available | Optional modules; Resend on `updates.<domain>` |
| Indexing | Owner's choice, default `noindex` | Indexed; Search Console + Bing; the `workers.dev` twin is `noindex` |
| EmDash | Optional; its own D1, R2 bucket, KV namespace and Cron Trigger | Optional |
| Access | `/admin` and previews | `/admin` and previews |
| Backups | Account-wide backup Worker | Same |

Why ideas share resources: the Workers Free plan allows 10 D1 databases and 5 Cron Triggers per account ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/), checked 2026-10-21).

`promote` moves an idea to launch mode:

1. Attach the domain.
2. Create the site's own D1 and copy its leads over.
3. Create its own bucket and copy its uploads.
4. Set up Resend on `mail.<domain>` and switch the mailer.
5. Apply the indexing choice and post the owner checklist.

`teardown` first exports an idea's leads and uploads to the backup bucket. Then it deletes the idea's Worker, rows, objects and Access app.

### Creating and removing an idea site

Both run as workflows in the owner's private ops repo, because this repo's Actions logs are public. The ops workflows call the reusable `site-create.yml` and `site-teardown.yml` here, which run `scripts/site/create.mjs` and `scripts/site/teardown.mjs`.

`create` (inputs: id, name, tagline, owner inbox, Turnstile mode):

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

Self-test on 2026-10-22 (`selftest-1022`):
- create, live QA (103 checks), a live lead with a file upload, a production build from the repo, and teardown all passed.
- Preview-branch builds are untested.

`site selftest` runs the whole path weekly, and on demand, from the ops repo. It runs as one job:
1. Creates `selftest-<run id>` with Turnstile test keys.
2. Runs the QA gate on the live URL, from the site's own folder.
3. Sends one lead with a file through the live form (`starter/scripts/live-lead.mjs`). That script fills any form schema.
4. Checks the row, the subscription, the attribution and the file through the Cloudflare API (`scripts/site/verify-lead.mjs`). It also checks that both uptime monitors exist and report UP (`scripts/site/verify-monitors.mjs`).
5. Always tears the site down at the end, including when an earlier step failed.

R2 objects are written and deleted with Wrangler. The Builds calls follow the [Builds API reference](https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/) (checked 2026-10-22). They need a user-scoped token (`CF_BUILDS_TOKEN`).

## 3. Kickoff questions

Asked once, in one message. Every question has a default, so an unanswered one never blocks the run. Answers are written to `site.config.json` and `DECISIONS.md`.

| # | Question | Default |
|---|---|---|
| 1 | Business basics: name, one-line offer, audience, owner inbox; postal address for launch mode | Required: name, inbox |
| 2 | Mode: idea, or launch on an existing domain or a new one | Idea |
| 3 | Site shape: landing page, full site, or hybrid | From the design intake |
| 4 | Forms: kinds and fields (all auto opt-in) | One contact form with a file field |
| 5 | Lead auto-reply on or off; launch sender | Idea: off. Launch: Resend |
| 6 | Index now? | Idea: no. Launch: yes |
| 7 | Client editing (EmDash) | Off |
| 8 | CRM mirror | None |
| 9 | Newsletter or drips (launch only) | None |
| 10 | Design intake | Required |

## 4. Phases and gates

| Phase | What happens | Gate |
|---|---|---|
| P0 Preflight | Read the account's ceilings (D1, Workers, Turnstile, Cron, Web Analytics); check tokens and GitHub access; ask kickoff questions | Stop if a ceiling is hit; offer `teardown` of an old idea |
| P1 Repo | Create the site's new repo from `starter/`; write `DECISIONS.md`; work on a branch | |
| P2 Design | Infer → confirm → personality sliders → references → suggested styles → this-or-that pairs → three style tiles → five-word check → lock `PRODUCT.md` and `DESIGN.md` (section 12) | **Owner picks a tile** (best-scoring tile is used after 24 h, marked `inferred`) |
| P3 Build | Pages, copy, JSON-LD, sitemap, `robots.txt`, forms from the schema, privacy page matching what is collected | |
| P4 Data | `bootstrap`: D1, R2, Turnstile hostname, secrets, Access apps, Builds triggers; register the site in `ops/registry` | |
| P5 Integrations | Mailers, unsubscribe, optional modules | |
| P6 Staging | Preview behind Access; end-to-end lead and upload test with Turnstile test keys; QA gate | **Owner approves the preview** |
| P7 Domain | Idea: none. Launch: existing zone, or check → price → approval → register | **Owner approves any purchase** |
| P8 Go-live | Merge to `main`; QA gate on production; custom domain and redirect (launch); DMARC; Web Analytics | **QA gate passes** (automatic) |
| P9 Handoff | `HANDOFF.md`: URLs, renewal dates, monitors, backups, secrets inventory, owner-attested checklist; release tag | |

## 5. Forms

- **Schema:** forms are defined as JSON in `site.config.json` and rendered by the core form engine (multi-step, inline validation, progress shown).
- **Auto opt-in:** every form is a sign-up form, and submitting it subscribes the visitor. Someone who unsubscribed and later fills in a form again is subscribed again; each lead row keeps the opt-in wording shown that time.
- **Opt-in line:** every form subscribes the visitor. There is no checkbox, just one line under the submit button: "You'll get occasional emails from us. Unsubscribe anytime." This is allowed under US CAN-SPAM, which requires a working unsubscribe honored within 10 business days and a postal address in marketing email ([FTC guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)). If `site.config.json` says the site targets the EU or Canada, P0 warns the owner, because GDPR and CASL generally require prior consent.
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
  - Notifications use Cloudflare `send_email` to the verified owner inbox.
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
- **Design checks:** `design.md lint`, Stylelint token enforcement, `impeccable detect` on source and the preview URL, a copy lint, and the truth gate (no testimonial, logo, statistic or face without an owner source). Then at most three rounds of vision-model critique, keeping a revision only if it wins a side-by-side comparison both ways round.

## 9. Client editing (EmDash)

EmDash 1.3.1 is an Astro-based CMS ([docs](https://docs.emdashcms.com/deployment/cloudflare/), checked 2026-10-23). It is a per-site switch, off by default.

- **Switching it on:**
  - `node scripts/editing.mjs on` in a site (`create` runs it when `EDITING=on`) does the following:
    - Copies `starter/editing/` over the site: the Astro config, the Worker, the live collection and the home page.
    - Marks every other page prerendered.
    - Writes `seed/seed.json`: the content model, plus the current copy.
    - Adds the EmDash packages, pinned to exact versions.
    - Adds the bindings EmDash needs.
  - `editing off`, which would export the content back to files, is not built.
- **How the Worker is wired:**
  - Core runs first: `createWorker(config, { fallback })`, core 0.2.0. `/api/*`, `/admin` and `/u` behave exactly as on a static site.
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
  - Live self-test with editing on (pending: the deploy token needs Workers KV Edit). It checks that the editor sits behind Access, the content model is applied to its own database, the Cron Trigger is set, and leads and uploads still work. A partial run on 2026-10-23 stopped at the KV step; teardown exported and removed the content databases it had created.
- **Not tested yet:**
  - An editor signing in through Access and publishing in the live admin.
  - Previews of an editing site.
  - Sandboxed plugins (Workers Paid only) and Cloudflare email sign-in (sending to arbitrary recipients needs Workers Paid).
- **Agents editing content:** EmDash has a CLI (`emdash login --url … -H …`), a REST API and an MCP server at `/_emdash/api/mcp`. Behind Access, an agent would need an Access service token. Untested.

## 10. Modules (designed, not built)

- **CRM mirror:**
  - Each new lead goes on a Cloudflare Queue, and a consumer upserts it into HubSpot, Attio, Zoho or Google Sheets.
  - The lead id is the idempotency key, so a lead never appears twice.
  - Failures retry, and a dead-letter queue keeps leads that keep failing. D1 is never blocked by a mirror.
- **Newsletter:** syncs `subscribers` to Resend Contacts and sends broadcasts from `updates.<domain>`, with one-click unsubscribe. Launch mode only.
- **Drips:** a Cloudflare Workflow per lead that sends, waits, then sends again, checking the unsubscribe flag before every send. Launch mode only.

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

Rules:

- **No invented proof.** No testimonials, logos, counts, statistics or faces without an owner source. The agent never generates people or premises.
- **Ban list in `AGENTS.md`:** purple or indigo gradients; cyan on dark; cream + serif + terracotta; near-black + acid accent; broadsheet hairlines; reflex Inter, Geist, Space Grotesk or Instrument Serif. A style may still use one of these if `DESIGN.md` records it as a deliberate choice.
- **Sections follow the page's argument,** not one fixed order. Sections come from the framework's own token-driven section library; Starwind UI supplies interactive components (test on Astro 7 first).
- **Performance threshold:** the research proposed 0.95. The framework keeps the 90 tripwire, because a real production build measured 94–98 run to run on identical code.

Owner-approved on 2026-10-22: the nine-step intake, paid reference libraries as an option only, and autopilot.

Supporting tools from the second research round (`docs/research/apify-huggingface-design.md`). They feed the steps above and add no questions. All are free and **untested** until the template self-test runs them.

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

Unverified, to be checked when adopting:

- the `@google/design.md` CLI version (the format is alpha)
- Starwind on Astro 7
- the Tailwind 4 `--color-*: initial` palette reset
- the OKLCH scale library
- an Impeccable per-rule waiver wrapper
