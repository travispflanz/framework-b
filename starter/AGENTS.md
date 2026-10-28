# Site agent instructions

This site was built with Framework B. `site.config.json` holds every brand value; nothing brand-specific is hard-coded anywhere else.

## Layout
- `site.config.json`: name, mode, host, owner inbox, forms (JSON schema), email mailers, navigation, Turnstile site key.
- `src/pages/`, `src/layouts/`, `src/components/`: the Astro 7 site. `Form.astro` renders any form from its schema.
- `DESIGN.md`: the design contract in Google's DESIGN.md format. `src/styles/tokens.css` is generated from it by `node scripts/design-tokens.mjs`; never edit tokens.css by hand. Use token utilities only (`bg-surface`, `text-ink`, `text-headline`, `rounded-card`, `px-gutter`), never raw colours or sizes: Tailwind's default palette is switched off.
- `src/sections/`: the section library (hero, steps, features, pricing, area, faq, cta, form, text, split (text and image), gallery, list (up to three lists of checks, crosses or numbers), people (the owner's own photos)). Text fields take `**bold**`, `*italic*` and `[label](/path)` links; nothing else is rendered as markup. `schema.js` defines every section once; the same definition checks static content, renders the Astro component and becomes an EmDash block type when editing is on.
- `src/content/<page>.json`: a page's sections, in order. `src/pages/index.astro` renders `home.json`; every other `<slug>.json` is the page `/<slug>` (`src/pages/[page].astro`) and needs a `title` (and ideally a `description`). Every page starts with a hero. Add the page to `nav` in `site.config.json`. `"noindex": true` keeps a page (a thanks page) out of search results and the sitemap; `privacy.json`, `not-found.json` and `contact.json` replace the generated privacy, 404 and contact pages with the owner's own; a `title` in `home.json` is the home page's whole `<title>`. Check content with `node scripts/check-content.mjs`.
- Images: files in `src/assets/images/`, used in image fields as `{ "src": "<file>", "alt": "<what it shows>" }` (hero, split, gallery). Astro serves them as resized WebP. Owner photos first; otherwise `node scripts/images.mjs search "<query>"`, look at the contact sheet it makes, then `node scripts/images.mjs add <id> --as <name> --alt "..."` (credit written for you). `/credits` lists credited images and the footer links to it.
- `src/worker.js`: three lines that start the core runtime. Don't add routes here.
- `core/`: a vendored copy of Framework B core (version in `core/VERSION`). Never edit it here; it is replaced by framework updates.
- `framework.lock.json`: the Framework B commit this site was last built or updated from. Don't edit it by hand.

## Framework updates
- Framework-owned files (everything from the starter except brand, content, design contract, records and `wrangler.jsonc`) are updated by the ops repo's "Site update" workflow. It runs Framework B's `scripts/site/update.mjs` on a branch, tests a copy (build, e2e, QA with Turnstile test keys) and opens a pull request here with a report.
- The update does a three-way merge: files the site never changed are replaced, site changes are kept and merged with the framework's, and overlapping changes are left as conflicts with the framework's version in `<file>.framework-new`. Resolve each one, delete the copy, then merge.
- If the report says the EmDash content model changed, the deployed content database keeps its old model until it is migrated; follow EmDash's "Evolving a deployed site" guide before merging.
- `PRODUCT.md`, `DESIGN.md`: the design contract. `DECISIONS.md`: kickoff answers. `HANDOFF.md`: URLs, monitors, renewals, owner-attested settings. `SECRETS.md`: secret names only.

## Commands
- Build: `npm run build`.
- Local run: `npm run db:migrate:local`, then `npm run dev`. Put test values in `.dev.vars` (copy `.dev.vars.example`).
- End-to-end test: `npm run build && npm run test:e2e`. It uses a local Worker, a real browser and Turnstile test keys, and sends no email.
- QA gate: `npm run build && npm run qa` (local), `npm run qa -- --url <preview-url>` (P6), `npm run qa -- --url https://<domain> --launch` (P8). It fails on any check; screenshots and the report land in `qa-output/`.
- Migrations: `npm run db:migrate:remote` (never `d1 execute` with schema SQL).
- Client editing (EmDash): `node scripts/editing.mjs on` switches it on; `node scripts/editing.mjs off --remote` switches it off and brings the published home page and its images back into files (see "Client editing" below). Local tests of an editing build first need `node scripts/fill-test-placeholders.mjs` if the site has no real resources yet.

## Client editing (EmDash)
- When `site.config.json` has `"editing": { "enabled": true }`, pages that read EmDash content render on request (cached in Workers Cache); every other page is prerendered (`export const prerender = true`).
- Editors use `/_emdash/admin`, behind Cloudflare Access (the `<id> editor` application). To add an editor, add their email to that application's policy. The first person to open the admin runs the setup wizard; choosing the sample content brings in the site's current copy from `seed/seed.json`.
- Content lives in its own D1 database (`CMS_DB`) and media bucket (`MEDIA`), separate from leads (`DB`, `UPLOADS`). Previews use their own copies of both.
- The content model is in `seed/seed.json`. To change a deployed site's model, follow EmDash's "Evolving a deployed site" guide; don't edit the seed and expect it to re-apply.
- The hourly Cron Trigger runs EmDash's scheduled publishing and maintenance. The Free plan allows 5 Cron Triggers per account.
- Switching off: `node scripts/editing.mjs off --remote` (needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) on a branch, then a pull request. Only the published home page is exported; unpublished drafts are not. It deletes nothing in Cloudflare and lists what the owner can remove. Confirm the source of every image it credits.

## Design
- Compare looks before choosing one: `node scripts/design-tiles.mjs <draft.md> <draft.md> [<draft.md>]` renders each draft on this site's real content into `design/tiles/`. It swaps DESIGN.md and tokens.css while it builds and puts them back at the end; if a run was killed, the next run restores them first. On autopilot, `node scripts/design-judge.mjs prepare`, answer each ballot LEFT or RIGHT, then `tally`.
- Before drafts, with an owner: this-or-that pairs. Write `design/pairs.json`, `node scripts/design-pairs.mjs render`, send the PNGs, record answers with `pick <id> a|b` (`defaults` if the owner is silent).
- After the gates pass: at most three critique rounds with `node scripts/design-critique.mjs start | score | compare | decide` (rules in its header). A fix stays only if it wins the pairwise judge both ways round.
- Every image in `public/` or `src/` needs an entry in `design/credits.json` (source, alt text; creator, licence and link for stock). A generated image is never the business's own people, premises, products or work, and never a recognisable face.
- Change the look in `DESIGN.md`, then run `node scripts/design-tokens.mjs`. It lints the file with `@google/design.md` and checks the token contract (required colours, type levels, radii and spacing) and the `composition` and `imagery` blocks (allowed values in its header). It also checks the WCAG AA contrast pairs, then writes tokens.css and `src/styles/design.json`. Fonts must be installed Fontsource packages (`npm i @fontsource-variable/<family>`).
- `composition` sets the skeleton for the whole site: alignment, density, separation (tone bands, hairlines or none), card style, image shape, motion (none, subtle, expressive; always off with reduced motion) and the phone budget. `imagery` sets the picture style, an optional secondary style, a treatment (duotone, tint, warm, cool, mono) and grain.
- Sections follow the page's argument, not a fixed order. The hero comes first and has the only `<h1>`. Each section takes a `variant` (layout) and a `phone` setting (`stack`, `swipe`, `collapse`, `hide`; `auto` uses `PHONE_AUTO` in `src/sections/schema.js`). With `separation: bands`, bands alternate tones automatically.
- A nav item with `"cta": true` in `site.config.json` becomes the header button on wider screens and a fixed action bar on phones (a second one, for a site with two front doors, becomes an outlined button beside it) (with a Call button when `site.phone` is set); phones also get a row of page links.
- Logo: `node scripts/brand-kit.mjs options [--icon <Phosphor name>] [--initials AB]`, look at `design/brand/options.png`, then `pick <n>` (logo, favicon, app icons, share image, manifest, `site.logo`). Skip it when the owner has a logo: put theirs in `public/logo.svg` and set `site.logo`.
- Images in a generated style: `node scripts/generate-image.mjs draft "<subject>" --as <name>`, look at `design/generated/<name>/sheet.png`, then `use <name> <n> --alt "..."`. Needs the Workers AI token (a network secret on the agent's environment, or `WORKERS_AI_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID`; otherwise the ops repo's **site images** workflow runs it with the token kept there. Stock and generated images get the design's treatment automatically; `node scripts/images.mjs treat <file>` applies it to an owner photo. Photorealistic generated images get a visible "Generated image" label; every generated image is listed on `/credits`.
- The QA gate fails on:
  - a stale tokens.css or design.json;
  - a home page longer than the phone budget at 390×844, a first phone screen without the `<h1>`, or a missing phone action bar;
  - anything animating when the visitor asks for reduced motion;
  - content that doesn't match the schema;
  - reviews, ratings, customer counts or percentages without a source in `PRODUCT.md` (truth gate);
  - generic AI words (copy lint; the owner's own phrases listed under "## Owner's wording" in `PRODUCT.md` are skipped);
  - Impeccable findings in the source or on any rendered page, including any font, colour, radius or font size outside `DESIGN.md`. For a deliberate exception, run `npx impeccable ignores add-value <rule> <value> --reason "..."`; it is recorded in `.impeccable/config.json` for review.

## Rules
- Work on a branch and open a pull request. `main` deploys production immediately.
- Never commit secrets. Secrets are Worker secrets; names are listed in `SECRETS.md`.
- Drips (launch sites with Resend only): add a `drips` block to `site.config.json` (forms, then emails with `after`, `subject`, `text`) and the Workflow binding to `wrangler.jsonc`: `"workflows": [{ "name": "<id>-drips", "binding": "DRIPS", "class_name": "DripWorkflow" }]`. The content check fails without the binding. Write each email from what the owner supplied; never invent offers or proof.
- Never delete or rewrite rows in `leads` or `subscribers` without the owner's explicit approval.
- Never buy a domain, upgrade a plan or create a paid resource without the owner's explicit approval.
- Every form is a sign-up form unless its `consent` is "none" (a plain message form that says it won't add anyone to a list; it shows no opt-in and never subscribes). Keep the opt-in line under the submit button (`optIn.mode` "auto"), or the consent box before it ("checkbox": only a ticked box subscribes; a form's `consent` is "required" or "optional").
- `/go` redirects to `go.to` (default `/`) keeping the query string: point printed QR codes and campaign links at `/go?src=<where>`, and never remove it.
- No invented testimonials, logos, statistics or faces. Use only what the owner supplied.
- Keep internal links extensionless (`/contact`, not `/contact.html`).
- Mark anything not yet proven by a test as "untested".
