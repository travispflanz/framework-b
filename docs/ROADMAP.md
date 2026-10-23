# Roadmap to v1.0.0

The v1.0.0 milestone: a new idea is built from one prompt, using this repo. The owner's only touches are the kickoff answers, the design intake and the preview approval. That idea is then promoted to launch mode.

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Create the empty private repo `framework-b` and give the Claude GitHub app access | Owner | Done 2026-10-22 |
| 2 | Design layer research → design phase and full design intake | Agent, then owner review | Approved by owner 2026-10-22 (`docs/research/design-layer.md`, `docs/research/apify-huggingface-design.md`) |
| 2b | Design trials: calibrate the autopilot judge on the CC-BY landing-page arena votes; run `dembrandt` on 5 reference sites | Agent; owner supplies a Hugging Face token for the arena data | dembrandt: done, adopt with limits (`docs/research/trials.md`). Arena: blocked on a Hugging Face token |
| 3 | Foundation docs: `SPEC.md` v2, `ONE-TIME-SETUP.md`, `TOKENS.md`, `DECISIONS.md`, branch protection | Agent | Drafts done; branch protection once the repo exists |
| 4 | `packages/core`: Worker, forms engine (auto opt-in, file uploads with safeguards), migrations, mailers (Cloudflare, Resend, Apps Script), QA, and the `bootstrap`, `promote`, `teardown` and `editing` scripts | Agent | Worker runtime 0.1.0 in review (forms, uploads, mailers, unsubscribe, admin, migrations, `_headers`; 22 tests in workerd). Not yet: forms engine UI, QA, scripts |
| 5 | `ops/`: site registry, account-wide backup Worker, Apps Script mailer | Agent; owner deploys the mailer | Mailer drafted |
| 6 | `starter/`: Astro 7, wired to `packages/core`, ready for EmDash | Agent, after step 2 is agreed | Skeleton in review: pages, schema-driven form engine (steps, inline errors, file upload, attribution), privacy page generated from the config, `_headers`, site agent docs. End-to-end test passes in a real browser. Not yet: design-phase tooling, QA gate, EmDash switch |
| 7 | Self-test on every push: dummy-config build, QA gate, lead test, upload test, EmDash-on build, no real email | Agent | Not started |
| 8 | Second test build: a new idea on `workers.dev`, from one prompt | Owner picks the idea; agent builds | Not started |
| 9 | Promote it to launch mode on a spare domain | Owner picks the domain; agent runs `promote` | Not started |
| 10 | Modules: CRM mirror, newsletter, drips | Agent | Designed, not built |
| 11 | Tag v1.0.0 | Agent | |

## Upload safeguards (required before uploads ship)

1. Verify the Turnstile token server-side before issuing an upload URL. Done in core 0.1.0 (tested).
2. Enforce a size cap and a content-type allow-list when signing, and again when the file arrives. Done (tested).
3. Rate-limit per IP. Done (tested locally; untested on the Free plan). Objects are only written after a ticket is claimed, so there are no abandoned objects to expire; a lifecycle rule is no longer needed.
4. Give previews their own bucket (`previews.r2_buckets`), so a preview never writes to production uploads. Belongs to `starter/`; not done.
