# Framework decisions

Decisions about the framework itself. Each site keeps its own `DECISIONS.md` for its kickoff answers.

| Date | Decision | Why |
|---|---|---|
| 2026-10-22 | The framework lives in its own repo, `framework-b`. Each site gets a new, separate repo. No site's history or content is shared | Keep every site and the framework independent |
| 2026-10-22 | Page layer: Astro 7, mostly static output, structured so EmDash can be switched on without restructuring | Reusable components for agents; fast static pages |
| 2026-10-22 | Forms: the framework's own multi-step form engine, driven by a JSON schema. SurveyJS stays an option for complex branching | About 5 KB compressed vs about 450 KB for SurveyJS core + UI; already passed axe and Lighthouse |
| 2026-10-22 | Every form is an auto opt-in: one line under the submit button says the visitor will get emails and can unsubscribe at any time | Owner's choice. Allowed under US CAN-SPAM. Sites targeting the EU or Canada are flagged, because GDPR and CASL generally require consent |
| 2026-10-22 | Two modes: idea (`workers.dev`) and launch (own domain), with a `promote` script between them | Most launches are cheap demand tests that may never get a domain |
| 2026-10-22 | Idea-mode email goes through a Google Apps Script mailer in the owner's Gmail: a notification to the owner and an optional auto-reply to the lead | Cloudflare can only send from domains set up for Email Routing, and `workers.dev` isn't one. Apps Script is free (100 recipients a day on a personal Gmail) and needs no domain |
| 2026-10-22 | Launch-mode email: Cloudflare `send_email` for owner notifications; Resend Free on `mail.<domain>` for lead confirmations; newsletters from `updates.<domain>` | Separates the domain's web reputation from its email reputation |
| 2026-10-22 | Lead confirmations are plain transactional mail: text plus minimal HTML, one link, no tracking, no `List-Unsubscribe` headers | Bulk-mail headers and styled HTML sent the test build's confirmations to Gmail Promotions |
| 2026-10-22 | R2 uploads are on by default: a "Do you need to send us something?" file field on the contact form | Keeps the upload path tested on every site |
| 2026-10-22 | Search indexing is a per-site choice in both modes; ideas default to `noindex` | Some ideas should be found from day one |
| 2026-10-22 | Client editing (EmDash) is a per-site switch in both modes. Each EmDash site needs its own D1 and R2 | An assistant or co-worker may need to edit content |
| 2026-10-22 | Ideas share one D1 and one uploads bucket; one account-wide backup Worker covers every site | The Free plan allows 10 D1 databases and 5 Cron Triggers per account |
| 2026-10-22 | Nothing a live site needs runs on the owner's machine. CI is Workers Builds; schedules are Cloudflare Cron; state is in GitHub | Owner's standing rule |
| 2026-10-22 | Design direction is required and asked through a design intake, never inferred | Undirected AI builds converge on the same look |
| 2026-10-22 | Default, pending objection: the runtime is a versioned package (`packages/core`) that sites update by bumping one version | A copied template never receives later fixes |
| 2026-10-22 | Default, pending objection: each agent environment holds its own scoped deploy token, listed by name in `SECRETS.md` and rotated on a schedule | Hermes and cloud sessions both need to deploy without sharing one machine |
| 2026-10-22 | Uploads go through the Worker: the submit response returns a signed single-use URL, and the file is streamed to R2. No presigned R2 URLs | No R2 S3 key pair per site and no bucket CORS. Streaming stays inside the Free plan's 10 ms CPU limit ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), checked 2026-10-22) |
| 2026-10-22 | Indexing headers for static pages come from a generated `_headers` file, not Worker code | Static assets are served without running the Worker; `_headers` supports host patterns such as `https://:worker.:subdomain.workers.dev/*` ([static assets headers](https://developers.cloudflare.com/workers/static-assets/headers/), checked 2026-10-22) |
| 2026-10-22 | One `SIGNING_SECRET` per site signs unsubscribe links and upload URLs, with a distinct prefix for each use | One fewer secret to set and rotate |
| 2026-10-22 | Filling in any form re-subscribes a visitor who unsubscribed earlier | Owner's rule: every form is a sign-up form, so a new submission is a new opt-in. Each lead row records the wording shown |
