# @framework-b/core

The runtime every Framework B site's Worker is built from. Version `0.1.0` (untested on a live deploy).

A site vendors a tagged copy of this folder and wires it up in three lines:

```js
import config from "../site.config.json";
import { createWorker } from "../core/src/index.js";
export default createWorker(config);
```

## Routes

| Route | What it does |
|---|---|
| `POST /api/submit/:form` | Origin check, 64 KB cap, per-IP rate limit, honeypot, Turnstile, schema validation. Saves the lead and auto-subscribes the visitor in one D1 batch, then sends mail in the background. Returns JSON, or a 303 to the thank-you page for a plain HTML form post. |
| `PUT /api/upload/:lead` | Takes the file for a lead, using the signed single-use URL the submit response returned. The body must match the signed size and type. It is streamed to R2 at `<site>/<lead>/<name>`. |
| `GET /api/health` | Checks the Worker and D1. |
| `GET` / `POST /u` | Unsubscribe. GET shows a button; only POST changes anything, because mail scanners prefetch links. |
| `GET /admin/*` | Lead list, lead detail, file download, `leads.csv`, `subscribers.csv`. Needs a valid Cloudflare Access JWT. Fails closed. |

All other paths are static assets. Static responses never run the Worker, so indexing headers come from the `_headers` file that `buildHeadersFile(config)` writes at build time.

## Files

- `src/config.js`: reads and checks `site.config.json`, and refuses bad combinations (for example, a domain mailer on an idea site).
- `src/forms.js`: submit and upload.
- `src/mailers.js`: `apps-script`, `cloudflare` (`send_email`), `resend`, `none`.
- `src/crm.js`: the CRM mirror (Google Sheet through the Apps Script mailer, signed webhook), keyed by the lead id.
- `src/unsubscribe.js`, `src/admin.js`, `src/headers.js`.
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
| `MAILER_URL`, `MAILER_SECRET` | secrets | `apps-script` mailer; the CRM Sheet mirror |
| `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET` | secrets | the CRM webhook mirror (the secret is optional) |
| `RESEND_API_KEY` | secret | `resend` mailer |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | vars | `/admin` |

## Tests

`npm test` runs the suite inside workerd (`@cloudflare/vitest-plugin`) with a local D1, R2 and rate limiter. Outbound calls (Turnstile, Apps Script, Access keys) are mocked. GitHub Actions runs it on every pull request (`.github/workflows/core-test.yml`).

The tests do **not** cover:
- a real deploy;
- real Turnstile keys;
- the real Apps Script redirect, or the Sheet the mirror writes to;
- Resend;
- `send_email`;
- the rate limit binding on the Workers Free plan;
- an upload larger than a few bytes.

All of these are untested until the template self-test (roadmap step 7) and the second test build.
