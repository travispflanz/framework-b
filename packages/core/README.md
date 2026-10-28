# @framework-b/core

The runtime every Framework B site's Worker is built from. Version `0.6.0` (`CORE_VERSION` in `src/index.js`). Live on idea and launch sites since 2026-10-27; the additions of 0.5.0 and 0.6.0 are tested in workerd only (*untested* live).

Versions: 0.1.0 forms, uploads, mailers, unsubscribe and admin; 0.2.0 the EmDash fallback (`createWorker(config, { fallback })`); 0.2.1 a fix found on the first real site; 0.3.0 the CRM mirror; 0.4.0 drips; 0.5.0 the checkbox consent mode, `/go` and older unsubscribe links (for adopting an existing site); 0.6.0 radio and checkbox-group fields and step headings in forms.

A site vendors a copy of this folder into `core/` (`scripts/vendor-core.mjs` at `site create`; `site update` replaces it with a newer copy) and wires it up in a few lines:

```js
import config from "../site.config.json";
import { createWorker, dripWorkflow } from "../core/src/index.js";

export const DripWorkflow = dripWorkflow(config); // idle unless site.config.json has "drips"
export default createWorker(config);
```

## Routes

| Route | What it does |
|---|---|
| `POST /api/submit/:form` | Origin check, 64 KB cap, per-IP rate limit, honeypot, Turnstile, schema validation. Saves the lead and auto-subscribes the visitor in one D1 batch, then sends mail in the background. Returns JSON, or a 303 to the thank-you page for a plain HTML form post. |
| `PUT /api/upload/:lead` | Takes the file for a lead, using the signed single-use URL the submit response returned. The body must match the signed size and type. It is streamed to R2 at `<site>/<lead>/<name>`. |
| `GET /api/health` | Checks the Worker and D1. |
| `GET /go` | 302 to `go.to` (default `/`), keeping the query string, so a printed QR code or campaign link records its `src` and `utm_*` on the landing page. Needs `/go` in the site's `run_worker_first`. |
| `GET` / `POST /u` | Unsubscribe. GET shows a button; only POST changes anything, because mail scanners prefetch links. Accepts the one-click POST from `List-Unsubscribe-Post` (RFC 8058). |
| `GET /admin/*` | Lead list, lead detail, file download, `leads.csv`, `subscribers.csv`. Needs a valid Cloudflare Access JWT. Fails closed. |

All other paths are static assets. Static responses never run the Worker, so indexing headers come from the `_headers` file that `buildHeadersFile(config)` writes at build time.

## Files

- `src/config.js`: reads and checks `site.config.json`, and refuses bad combinations (for example, a domain mailer on an idea site).
- `src/forms.js`: submit and upload.
- `src/mailers.js`: `apps-script`, `cloudflare` (`send_email`), `resend`, `none`.
- `src/crm.js`: the CRM mirror (Google Sheet through the Apps Script mailer, signed webhook), keyed by the lead id.
- `src/drips.js` and `src/drips-config.js`: drips, one Cloudflare Workflow instance per lead (launch sites, through Resend). The site's Worker exports `DripWorkflow = dripWorkflow(config)`.
- `src/unsubscribe.js` (one-click POST works, RFC 8058), `src/admin.js`, `src/headers.js`.
- `src/lib/`: helpers for Turnstile, Access JWT, HMAC signing and HTML/CSV.
- `migrations/0001_init.sql`: the `leads` and `subscribers` tables, with a `site` column so idea sites can share one database.

## Bindings and secrets

| Name | Kind | Needed for |
|---|---|---|
| `DB` | D1 | always |
| `ASSETS` | static assets | always |
| `UPLOADS` | R2 | forms with a file field |
| `SUBMIT_LIMITER` | rate limit binding | optional; skipped if absent |
| `EMAIL` | send_email | `cloudflare` mailer |
| `TURNSTILE_SECRET` | secret | always |
| `SIGNING_SECRET` | secret, 32+ characters | unsubscribe links, upload URLs |
| `LEGACY_UNSUB_SECRET` | secret | optional: an adopted site's older unsubscribe links, signed `unsub:<email>`. `legacyUnsubSecret` in `site.config.json` names a different binding, such as the adopted Worker's own secret |
| `MAILER_URL`, `MAILER_SECRET` | secrets | `apps-script` mailer; the CRM Sheet mirror |
| `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET` | secrets | the CRM webhook mirror (the secret is optional) |
| `RESEND_API_KEY` | secret | `resend` mailer; drips |
| `DRIPS` | Workflow (`class_name` `DripWorkflow`, name `<site id>-drips`) | drips |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | vars | `/admin` |

## Tests

`npm test` runs the suite inside workerd (`@cloudflare/vitest-plugin`) with a local D1, R2 and rate limiter. Outbound calls (Turnstile, Apps Script, Access keys) are mocked. GitHub Actions runs it on every pull request (`.github/workflows/core-test.yml`).

The tests do **not** cover the following; each is covered live instead, as noted:
- a real deploy, real Turnstile keys, the Apps Script redirect and Sheet, Resend, `send_email` and an upload of a real file: the weekly live self-test (ops repo `site selftest`) and the launch tests on 2026-10-27 (docs/SPEC.md sections 2 and 10);
- drips with real sleeps: tested in workerd with the sleeps switched off, and live once with a 20-minute first wait;
- the rate limit binding: it deploys on the Workers Free plan (every site has one), but whether it limits there is **untested**;
- uploads larger than a few megabytes: **untested**.
