# Framework B

Framework B lets an AI agent build a small business or idea website from one prompt and hand it to you for review.
Later it can put the site on its own domain. Everything runs on the free tiers of Cloudflare, GitHub, Resend and
UptimeRobot, and nothing runs on your computer.

You describe the business in a few sentences. The agent then:

- researches it;
- writes the copy and designs the site;
- creates the hosting, database, spam protection and logins;
- tests everything;
- sends you a private preview link.

You check the preview and merge one pull request, and the site is live. Every form on the site stores its leads in a
database you own, emails you about each one, and adds the visitor to a subscriber list you can email later.

**Status: v1.0.0 (2026-10-27).** Every feature below has run live on a real Cloudflare account unless it is marked
*untested*. The evidence for each one is in `docs/SPEC.md` and `docs/ROADMAP.md`.

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [What it costs: free-tier limits](#what-it-costs-free-tier-limits)
- [One-time setup](#one-time-setup)
- [Build a site with any AI agent](#build-a-site-with-any-ai-agent)
- [After the build](#after-the-build)
- [Options and settings](#options-and-settings)
- [Built-in rules](#built-in-rules)
- [Troubleshooting](#troubleshooting)
- [Repo layout and docs](#repo-layout-and-docs)

## How it works

```
 you ──prompt──▶ AI agent ──brief──▶ your private ops repo (GitHub Actions, holds the secrets)
                    │                         │
                    │ design, copy, tests     │ creates the site, deploys, checks, promotes, sends
                    ▼                         ▼
             site repo "site-<id>"  ──push──▶ Cloudflare (Workers, D1, R2, Turnstile, Access)
             (pull request = review)          ├─ preview URL per branch (behind a login)
                                              └─ main = the live site
```

Three repos:

- **`framework-b`** (this one, public) holds the template, the runtime and the scripts. It never contains a real
  site's name, data or secrets.
- **Your ops repo** (private, from `ops/ops-repo/`) holds your tokens and runs every workflow that changes your
  Cloudflare account. Agents trigger those workflows; they never hold your Cloudflare token.
- **One repo per site** (`site-<id>`, private) holds that site's content, design and records. Any agent can pick a
  site up from its repo.

A site has two modes:

| | Idea mode (every site starts here) | Launch mode (after **site promote**) |
|---|---|---|
| Address | `<site>.<your-subdomain>.workers.dev` | Your domain, or a one-level subdomain of it |
| Database | Shared with other idea sites (one `site` column) | Its own production database (previews share one with the other sites) |
| Owner emails | Through your Gmail (Apps Script mailer) | Cloudflare Email Routing when the site owns the whole domain, otherwise your Gmail |
| Lead auto-reply | Optional, through your Gmail (*untested*) | Optional, through Resend from `hello@mail.<domain>` |
| Newsletter and drips | Subscribers are collected; nothing is sent | Optional, through Resend from `mail.<domain>` |
| Search engines | Your choice; `noindex` by default | Indexed |

## Features

**Building**
- One-prompt build: the agent writes a kickoff brief, creates the site, designs it, writes the content, runs the
  gates and sends you a preview (`docs/BUILD.md`).
- Landing page, full site or hybrid. Every page is a JSON file of sections: hero, steps, features, pricing, service
  area, FAQ, call to action, form, text, text-and-image, gallery, lists (checks, crosses or numbers side by side) and
  people (with your own photos). Any text can carry **bold**, *italic* and [links](/about). Each section has several layouts (the hero
  alone has five: split, full-bleed, statement, editorial and bento) and its own phone behaviour (stack, swipe
  sideways, fold into an accordion, or hide).
- Design phase:
  - the design is written as one `DESIGN.md` file (Google's format) and turned into the site's colour, type and
    spacing tokens, with automatic contrast checks (WCAG AA). It also sets the layout feel (alignment, density, card
    style, image shape, motion) and the imagery style, so two sites differ in shape, not just colour;
  - on autopilot, the agent writes three different designs, renders each on the real content, and picks one by
    comparing them in pairs both ways round;
  - with you involved, it shows you this-or-that image pairs first, then the three designs to pick from;
  - after the gates pass, up to three critique rounds, each change kept only if it wins a side-by-side comparison
    both ways.
- A logo: six layouts drawn from the design's own font (with your initials or an icon); the one you pick becomes the
  logo, favicon, app icons and share image.
- Images: yours first; otherwise open-licensed photos from Openverse or generated images in the style you chose
  (photo, line art, watercolour, flat illustration and more) through Cloudflare Workers AI, all given one colour
  treatment so they match. Credits are written for you and listed on `/credits`; generated images carry no label
  on the page and never show your people, premises or products.
- Phones: a fixed action bar with your main button (and Call when you have a phone number), and long sections that
  swipe or fold, so the home page stays within a set number of screens.
- Motion that respects visitors who turn it off: reveal on scroll, smooth page transitions and button feedback, in
  CSS only.

**Forms and leads**
- Any number of forms, defined in `site.config.json`: text, email, phone, URL, long text, dropdown, radio buttons,
  groups of checkboxes (optionally under small headings), a single checkbox and hidden
  fields; multi-step forms; an optional file upload (10 MB by default).
- Spam protection: Cloudflare Turnstile, a hidden honeypot field, an origin check and size limits. A per-IP rate
  limit is also deployed (whether it limits on the Free plan is *untested*).
- Every lead is stored in Cloudflare D1, with where the visitor came from (UTM tags, referrer, landing page).
- `/admin` behind a Cloudflare Access email login: a lead list, lead details, file downloads, and CSV exports of
  leads and subscribers.
- Every form subscribes the visitor (one line under the button says so), or, in checkbox mode, only a visitor who ticks the consent box.
- `/go` for printed QR codes and campaign links: it redirects and keeps the `src` and `utm_*` tags as attribution. Every email carries an unsubscribe link,
  and newsletters and drips also support one-click unsubscribe in the mail app.

**Email**
- You get an email about every lead.
- Optional auto-reply to the visitor.
- Launch sites send from their own domain on a `mail.` subdomain, so the main domain's reputation stays separate.
- Newsletter: write an issue as a Markdown file, test-send the draft to yourself, merge it, then send it to every
  subscriber.
- Drips: a short email series after a form (up to 10 emails, waits of minutes to a year), which stops when the
  person unsubscribes.

**Optional extras**
- CRM copy of every lead: to a Google Sheet in your Drive (one tab per site) and/or a signed webhook (Zapier, Make,
  n8n or a CRM's own). Older leads can be resent at any time.
- Client editing (EmDash): you or a co-worker edit the home page's words and images in a web admin, behind the same
  login as `/admin`. It can be switched off again, which brings the content back into files.
- Search indexing on or off per site.

**Quality gate.** It runs on every preview and on production, and it fails the change on any of these:
- accessibility (axe, WCAG 2.2 AA);
- Lighthouse scores: accessibility, best practices and SEO must be 100; on a launched site, performance must be at
  least 90 (a borderline score is rechecked as the median of 5 runs);
- layout at four screen widths, and console errors;
- the home page's length on a phone, the action bar, and no motion for visitors who ask for less;
- fonts, colours or sizes outside `DESIGN.md`;
- generic AI wording;
- reviews, ratings or statistics without a source.

**Operations.** All of these run from your ops repo:
- **Update:** brings a site up to a newer framework as a tested pull request, keeping the site's own changes.
- **Preview check:** QA on a branch's preview, posted on its pull request.
- **Backups:** every database in the account, every Monday, kept 90 days.
- **Uptime monitors:** two per site.
- **Weekly self-test:** builds a throwaway site, tests it live and removes it.
- **Snapshot and park:** takes any site off its domain and puts it back exactly.
- **Adopt:** moves a site that wasn't built with Framework B onto it, keeping its Worker and copying its leads.
- **Teardown:** exports a site's data, then removes it.

## What it costs: free-tier limits

Framework B never buys anything or upgrades a plan without your approval. On the free plans, these are the limits
that matter (checked 2026-10-21 to 2026-10-27; sources in `docs/SPEC.md`):

| Limit | Free plan | What it means here |
|---|---|---|
| D1 databases per Cloudflare account | 10 | Idea sites and every site's previews share 2. Each launch site uses 1 more; client editing uses 2 more |
| Cron Triggers per account | 5 | The backup Worker uses 1; each site with client editing uses 1; your other Workers count too |
| Worker requests | 100,000 a day | Static pages are free and unlimited; form posts, `/admin` and `/api` count. With client editing on, every request counts, because Workers Cache bills cached and static requests too ([pricing](https://developers.cloudflare.com/workers/platform/pricing/), checked 2026-10-27) |
| Workers per account | 100 | One per site, plus the backup Worker |
| Apps Script mailer (personal Gmail) | 100 recipients a day | Shared by every site that sends through your Gmail |
| Resend | 3,000 emails a month, 100 a day, 3 domains, 1,000 marketing contacts | One domain per launch site, so up to 3 launch sites with auto-replies, newsletter or drips |
| UptimeRobot | 50 monitors | 2 per site, plus 1 for backups |
| Workflows (drips) | 100 running at once | Waiting instances don't count |
| GitHub Actions | 2,000 minutes a month on private repos | The ops repo's workflows; this public repo's CI is free |

What does cost money: a domain, if you buy one; the agent asks before any purchase. Zero Trust and R2 need a card on
file but stay free at this scale.

## One-time setup

About an hour, once per Cloudflare account. Full steps with links: `docs/ONE-TIME-SETUP.md`.

1. **Accounts:**
   - Cloudflare, with its `workers.dev` subdomain, Zero Trust (Free) and R2 switched on.
   - GitHub, with the Cloudflare Workers and Pages app given access to all repositories.
   - Optional: UptimeRobot and Resend.
2. **Tokens:** create the Cloudflare deploy token, the Workers Builds token, the D1 backup token and a GitHub site
   repo token. The exact permissions are in `docs/TOKENS.md`.
3. **Ops repo:**
   - copy `ops/ops-repo/` into a new private repo;
   - replace `OWNER` in its workflows with the account that owns `framework-b` (this repo, or your fork);
   - add the secrets (`ops/ops-repo/README.md`);
   - run **verify secrets**, then **deploy backup worker**.
4. **Email from idea sites (recommended):** deploy the Apps Script mailer in a Gmail account
   (`ops/apps-script-mailer/README.md`, about 10 minutes). Without it, leads are still stored but nobody is emailed.
5. **Agent access:** give your AI agent GitHub access to `framework-b`, the ops repo and your site repos.

To stay on a tested version, run the ops workflows with `framework_ref` set to a release tag (for example
`v1.0.0`) instead of `main`.

## Build a site with any AI agent

### What the agent needs

Any coding agent that can do the following:

- run a shell with **Node 24**, `git` and `npx`, plus a headless Chromium for the tests and the QA gate
  (`npx playwright install --with-deps chromium`);
- clone, push branches and open pull requests on your GitHub repos, and **run workflows in your ops repo** (the `gh`
  CLI signed in, or a GitHub token with Actions write access on the ops repo);
- **look at images** (the design judge, the style tiles and the critique rounds are screenshots it has to judge);
- search the web (research for the brief);
- nothing extra for generated images: the ops repo's **site images** workflow holds the Workers AI token
  (`docs/TOKENS.md` section 5).

It has been proven with Claude (Claude Code, and Claude in a cloud session with the Claude GitHub app). The agent
reads `AGENTS.md` and follows `docs/BUILD.md`, so Codex, Gemini CLI, Cursor, Hermes or another agent with the
abilities above should work the same way; that is *untested*. A chat-only assistant that can't run commands can
draft the brief and the copy, but can't build the site.

### Steps for you

1. Finish the one-time setup above.
2. Open your agent in a working folder, with this repo cloned (`git clone https://github.com/<owner>/framework-b`).
3. Paste the prompt below, filled in.
4. Answer what it asks. It only asks for something it can't decide itself: your inbox, a choice that can't be
   undone, or a credential.
5. When it sends you the pull request and the preview link:
   - open the preview (sign in with your email at the Cloudflare Access prompt);
   - read the list of things it inferred about your business, and correct anything wrong;
   - merge the pull request.
6. Send one real enquiry through the live site's form from your phone. The agent can't, because the spam check is
   real on production. It then confirms that your lead was stored and emailed.

### The prompt

```text
Build a website with Framework B (https://github.com/<owner>/framework-b). Read AGENTS.md and follow
docs/BUILD.md step by step (Claude: use the build-site skill). My ops repo is <owner>/<ops-repo>.

Business: <name>, <what you sell, in one line>, for <who>, in <city or area>.
My inbox for leads: <you@example.com>
Website or social links to research: <links, or "none">
What I want visitors to do: <book a call / ask for a quote / join a waitlist / ...>
Pages: <landing page | full site | you decide>
Look and feel: <three words, sites you like or dislike, or "autopilot">
Options (leave out to use the defaults):
- auto-reply to people who fill in the form: <yes/no>
- let search engines index it now: <yes/no>
- let me edit the words and pictures myself: <yes/no>
- copy each lead to: <my Google Sheet / a webhook URL / nothing>
Proof I can share (reviews, counts, awards, with where they come from): <list, or "none">

Decide everything else yourself, list what you inferred, and send me the preview link and pull request to approve.
```

Only the business name and your inbox are required. "Autopilot" lets the agent choose the design. Its choice is
marked as inferred, and you can ask it to redo the design later.

## After the build

Ask the agent for any of these. Each one is a single ops workflow, and every change to the site comes to you as a
pull request first. The inputs for each workflow are in `ops/ops-repo/README.md`.

| You want to | Ask for | Notes |
|---|---|---|
| Put the site on your domain | "promote it to `<domain>`" (**site promote**: prepare, you merge, finish) | The domain must already be in your Cloudflare account. It needs your postal address (US anti-spam law) and your inbox verified for Email Routing |
| Bring an older site onto Framework B | "adopt `<site>`" (**site adopt**: prepare, preview, you merge, cutover) | Keeps the site's Worker, domains and logins; copies its leads into new databases and never changes the old one. `rollback` switches back |
| Send a newsletter | "write a newsletter about …" (**site newsletter**: test, you merge, send) | Launch sites only; you get the test copy first |
| Follow up automatically | "add a drip: day 1 …, day 7 …" | Launch sites with Resend; written only from what you supply |
| Copy leads to a Sheet or CRM | "turn on the CRM copy" (**site crm sync** for older leads) | The webhook URL is set as a secret, never in the repo |
| Edit the site yourself | "switch client editing on" or "off" (**site editing** for off) | Uses 2 databases and 1 Cron Trigger while on |
| Get framework fixes | "update the site" (**site update**) | A tested pull request; your changes are kept |
| Take it offline without losing it | "snapshot and park it" (**site snapshot**, **site park**) | `undo` puts it back exactly |
| Delete it | "tear it down" (**site teardown**) | You type `delete <id>`; data is exported to backups first |

## Options and settings

### Kickoff brief (`brief.json`)

The agent turns your prompt into this file (format and defaults: `scripts/site/lib/brief.mjs`). Every answer is
recorded as stated by you, inferred by the agent, or a framework default.

| Field | Values | Default |
|---|---|---|
| `business.name` | text | required |
| `owner.email` | your inbox | required |
| `business.offer`, `audience`, `location`, `serviceArea`, `phone`, `postalAddress` | text | empty (the agent infers the offer) |
| `business.id` | site id, 3–42 lowercase letters, digits or dashes | made from the name |
| `mode` | `idea` | `idea` (launch comes later through **site promote**) |
| `audienceRegion` | `us`, `eu`, `uk`, `ca`, … | `us` |
| `consent` | `auto` (every form subscribes) or `checkbox` (a consent box) | `checkbox` for EU, UK and Canada; otherwise `auto` |
| `shape` | `landing`, `full`, `hybrid` | `landing` |
| `forms` | list of `{ id, purpose }` | one `contact` form |
| `autoReply` | `true` / `false` | `false` |
| `indexing` | `true` / `false` | `false` |
| `editing` | `true` / `false` | `false` |
| `newsletter` | `true` / `false` | `false` (on an idea site: collect subscribers only) |
| `crm` | `none`, `sheet`, `webhook`, `sheet+webhook` | `none` |
| `design` | `autopilot`, `words`, `references`, `avoid` | autopilot |
| `design.imagery` | `style` (`owner-photo`, `documentary-stock`, `photoreal-generated`, `line-art`, `flat-illustration`, `watercolor`, `3d`, `isometric`, `collage`, `cartoon`, `abstract`, `icon-led`), `secondary`, `treatment` (`none`, `duotone`, `tint`, `warm`, `cool`, `mono`) | `owner-photo`, no treatment |
| `facts`, `claims` | research facts; owner-supplied proof with its source | empty |
| `inferred` | the fields the agent decided | |

### Site settings (`site.config.json` in each site)

Checked when the Worker starts (`packages/core/src/config.js`); a bad combination fails the build.

| Key | What it sets |
|---|---|
| `site.id`, `site.name`, `site.tagline`, `site.locale` | Identity |
| `site.mode` | `idea` or `launch` |
| `site.canonicalHost` | The address search engines should use |
| `site.ownerEmail` | Where lead notifications go |
| `site.postalAddress` | Required in launch mode, because it goes in marketing email |
| `site.indexing` | `true` lets search engines in; previews are always `noindex` |
| `turnstile.siteKey` | The spam-check widget |
| `email.notify` | `apps-script`, `cloudflare` (needs `notifyFrom`) or `none` |
| `email.confirm` | `apps-script`, `resend` (needs `confirmFrom`) or `none`: the auto-reply |
| `email.confirmName`, `email.replyTo` | The auto-reply's sender name (default the site name) and reply-to address (default the owner) |
| `site.logo` | The logo file (`/logo.svg`), set by the brand kit |
| `site.phone` | Adds a Call button to the phone action bar |
| `nav` | Menu items `{ label, href }`; one or two items with `"cta": true` become the header buttons and the phone action bar |
| `forms.<id>` | `title`, `submitLabel`, `fields`, `confirm` (`{ subject, text }` for the auto-reply; `{first_name}` and `{name}` are filled in), `steps` (a `{ title, intro }` heading per step), `file`, `thanks`, `consent` (`required` or `optional` in checkbox mode; `none` for a plain message form that never subscribes anyone) (see below) |
| `optIn.mode` | `auto` or `checkbox` |
| `optIn.text` | The line under every submit button (auto mode) |
| `optIn.label` | The consent box's label (checkbox mode) |
| `go.to` | Where `/go` sends visitors (default `/`) |
| `footer` | `{ note, columns: [{ title, links: [{ label, href }] }], legal }`: a line about the business, link columns and a legal line |
| `legacyUnsubSecret` | For an adopted site: the Worker secret that signed its older unsubscribe links (default `LEGACY_UNSUB_SECRET`) |
| `crm` | `{ "sheet": true/false, "webhook": true/false }` |
| `drips` | `{ "forms": [...], "from": "news", "emails": [{ "after": "1 day", "subject": "...", "text": "..." }] }`. Launch mode with Resend only; up to 10 emails |
| `editing` | `{ "enabled": true, ... }`, written by `node scripts/editing.mjs on` |

A form field is `{ "name", "type", "label", "required", "autocomplete", "hint", "placeholder", "inputmode", "options", "step", "maxLength" }`
(a form may also have a `note`, one line under the submit button; hints, the note and the consent label take inline
formatting and links):

- `type` is one of `text`, `email`, `tel`, `url`, `textarea`, `select`, `radio`, `checkboxes` (these three need
  `options`: strings, or `{ value, label, group }`; `group` puts checkboxes under small headings), `checkbox` or
  `hidden`. A `checkboxes` answer is stored as a list.
- Every form needs a required `email` field.
- Give fields a `step` number to split the form into steps.
- `file` is `{ "label", "hint", "maxBytes", "types" }`. The default is 10 MB, and PDF, images, text, Word and Excel
  files are allowed. `types` lists MIME types and may also list extensions (`".fdx"`) for files browsers report
  without a type.

### Page content (`src/content/<page>.json`)

Each page is a list of sections. The section fields are defined once in `starter/src/sections/schema.js`, and
`node scripts/check-content.mjs` checks every page against them. `home.json` is the home page; any other file is
`/<file name>` and needs a `title`; `"noindex": true` keeps it out of search results and the sitemap (thanks
pages). `privacy.json`, `not-found.json` and `contact.json` replace the generated privacy page, the 404 page and the plain
contact page with your own. A `title` in `home.json` is the home page's whole title.
Every page starts with a hero. Any section can set `variant` (its layout) and
`phone` (`auto`, `stack`, `swipe`, `collapse`, `hide`).

## Built-in rules

These are enforced by the scripts and the QA gate, not left to the agent's judgment:

- **No invented proof.** Reviews, ratings, counts, logos and faces appear only if you supplied them, with a source.
- **Nothing reaches the live site without your merge.** `main` is the live site, and agents work on branches.
- **No purchases or plan upgrades** without your explicit approval.
- **Leads are never deleted or rewritten** without your approval. Teardown exports them first.
- **No secret values in any repo.** The repos list secret names only.
- **Opt-in that fits the audience.** By default every form subscribes the visitor, which US anti-spam law (CAN-SPAM)
  allows. Sites aimed at the EU, UK or Canada, where consent rules are stricter, get a consent box instead.

## Troubleshooting

- **The form on `localhost` says the spam check failed (error 110200).** The real Turnstile widget only allows your
  `workers.dev` address. Local tests use Turnstile's test keys (`node scripts/fill-test-placeholders.mjs
  --turnstile-test`).
- **"No room for more databases".** The Free plan allows 10 D1 databases. Tear down an idea you no longer need,
  or switch client editing off on a site.
- **A test email to yourself never arrives.** Gmail silently drops a message forwarded back to the account that
  sent it. Test from another account.
- **Email from a brand-new domain lands in spam.** New domains have no reputation. Test after 24–48 hours, and send
  no newsletter for about 30 days.
- **The preview check fails on an older site.** Run **site update** first; the check uses the site's own QA script.
- **Production still shows the old version.** Workers Builds takes about a minute after the merge.

## Repo layout and docs

| Path | What's there |
|---|---|
| `starter/` | The template copied into each new site repo. Its `AGENTS.md` is the site agent's guide |
| `packages/core/` | The runtime every site's Worker is built from: forms, uploads, admin, mailers, unsubscribe, CRM mirror, drips |
| `scripts/site/` | The scripts behind the ops workflows |
| `.github/workflows/` | The reusable workflows your ops repo calls, and this repo's CI |
| `ops/` | Shared services (backup Worker, Apps Script mailer, webhook check) and `ops/ops-repo/`, your ops repo's template |
| `.claude/skills/build-site/` | The build checklist as a Claude skill |

| Doc | Read it for |
|---|---|
| `docs/ONE-TIME-SETUP.md` | Setting up an account |
| `docs/TOKENS.md` | Every token and permission, and why |
| `docs/BUILD.md` | The agent's step-by-step runbook |
| `docs/SPEC.md` | How every part works, with evidence and vendor sources |
| `docs/DECISIONS.md` | Why it's built this way |
| `docs/ROADMAP.md` | How v1.0.0 was proven |
| `AGENTS.md` | Rules for agents changing this repo |

CI checks every pull request:
- the core tests;
- the starter build, end-to-end test and QA gate, static and with editing;
- the site scripts tests and the ops tests;
- a docs check (`node scripts/docs-check.mjs`), which fails if a doc names a file, script or workflow that doesn't
  exist.
