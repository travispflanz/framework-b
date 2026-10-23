# Site agent instructions

This site was built with Framework B. `site.config.json` holds every brand value; nothing brand-specific is hard-coded anywhere else.

## Layout
- `site.config.json`: name, mode, host, owner inbox, forms (JSON schema), email mailers, navigation, Turnstile site key.
- `src/pages/`, `src/layouts/`, `src/components/`: the Astro 7 site. `Form.astro` renders any form from its schema.
- `src/styles/tokens.css`: design tokens, written by the design phase from `DESIGN.md`. Use tokens only, never raw values.
- `src/worker.js`: three lines that start the core runtime. Don't add routes here.
- `core/`: a vendored copy of Framework B core (version in `core/VERSION`). Never edit it here; update it with a newer tagged version on a branch.
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

## Rules
- Work on a branch and open a pull request. `main` deploys production immediately.
- Never commit secrets. Secrets are Worker secrets; names are listed in `SECRETS.md`.
- Never delete or rewrite rows in `leads` or `subscribers` without the owner's explicit approval.
- Never buy a domain, upgrade a plan or create a paid resource without the owner's explicit approval.
- Every form is a sign-up form. Keep the opt-in line under the submit button.
- No invented testimonials, logos, statistics or faces. Use only what the owner supplied.
- Keep internal links extensionless (`/contact`, not `/contact.html`).
- Mark anything not yet proven by a test as "untested".
