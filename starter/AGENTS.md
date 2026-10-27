# Site agent instructions

This site was built with Framework B. `site.config.json` holds every brand value; nothing brand-specific is hard-coded anywhere else.

## Layout
- `site.config.json`: name, mode, host, owner inbox, forms (JSON schema), email mailers, navigation, Turnstile site key.
- `src/pages/`, `src/layouts/`, `src/components/`: the Astro 7 site. `Form.astro` renders any form from its schema.
- `DESIGN.md`: the design contract in Google's DESIGN.md format. `src/styles/tokens.css` is generated from it by `node scripts/design-tokens.mjs`; never edit tokens.css by hand. Use token utilities only (`bg-surface`, `text-ink`, `text-headline`, `rounded-card`, `px-gutter`), never raw colours or sizes: Tailwind's default palette is switched off.
- `src/sections/`: the section library (hero, steps, features, pricing, area, faq, cta, form, text). `schema.js` defines every section once; the same definition checks static content, renders the Astro component and becomes an EmDash block type when editing is on.
- `src/content/<page>.json`: a page's sections, in order. `src/pages/index.astro` renders `home.json`. Check content with `node scripts/check-content.mjs`.
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
- Client editing (EmDash): `node scripts/editing.mjs on` switches it on (see "Client editing" below). Local tests of an editing build first need `node scripts/fill-test-placeholders.mjs` if the site has no real resources yet.

## Client editing (EmDash)
- When `site.config.json` has `"editing": { "enabled": true }`, pages that read EmDash content render on request (cached in Workers Cache); every other page is prerendered (`export const prerender = true`).
- Editors use `/_emdash/admin`, behind Cloudflare Access (the `<id> editor` application). To add an editor, add their email to that application's policy. The first person to open the admin runs the setup wizard; choosing the sample content brings in the site's current copy from `seed/seed.json`.
- Content lives in its own D1 database (`CMS_DB`) and media bucket (`MEDIA`), separate from leads (`DB`, `UPLOADS`). Previews use their own copies of both.
- The content model is in `seed/seed.json`. To change a deployed site's model, follow EmDash's "Evolving a deployed site" guide; don't edit the seed and expect it to re-apply.
- The hourly Cron Trigger runs EmDash's scheduled publishing and maintenance. The Free plan allows 5 Cron Triggers per account.

## Design
- Change the look in `DESIGN.md`, then run `node scripts/design-tokens.mjs`. It lints the file with `@google/design.md` and checks the token contract (required colours, type levels, radii and spacing). It also checks the WCAG AA contrast pairs, then writes tokens.css. Fonts must be installed Fontsource packages (`npm i @fontsource-variable/<family>`).
- Sections follow the page's argument, not a fixed order. The hero comes first and has the only `<h1>`. Bands alternate tones automatically.
- A nav item with `"cta": true` in `site.config.json` becomes the header button; on phones only the site name and that button show.
- The QA gate fails on:
  - a stale tokens.css;
  - content that doesn't match the schema;
  - reviews, ratings, customer counts or percentages without a source in `PRODUCT.md` (truth gate);
  - generic AI words (copy lint);
  - Impeccable findings in the source or on any rendered page, including any font, colour, radius or font size outside `DESIGN.md`. For a deliberate exception, run `npx impeccable ignores add-value <rule> <value> --reason "..."`; it is recorded in `.impeccable/config.json` for review.

## Rules
- Work on a branch and open a pull request. `main` deploys production immediately.
- Never commit secrets. Secrets are Worker secrets; names are listed in `SECRETS.md`.
- Never delete or rewrite rows in `leads` or `subscribers` without the owner's explicit approval.
- Never buy a domain, upgrade a plan or create a paid resource without the owner's explicit approval.
- Every form is a sign-up form. Keep the opt-in line under the submit button.
- No invented testimonials, logos, statistics or faces. Use only what the owner supplied.
- Keep internal links extensionless (`/contact`, not `/contact.html`).
- Mark anything not yet proven by a test as "untested".
