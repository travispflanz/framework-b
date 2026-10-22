# Roadmap to v1.0.0

The v1.0.0 milestone: a new idea is built from one prompt, using this repo. The owner's only touches are the kickoff answers, the design intake and the preview approval. That idea is then promoted to launch mode.

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Create the empty private repo `framework-b` and give the Claude GitHub app access | Owner | Waiting |
| 2 | Design layer research → design phase and full design intake | Agent, then owner review | Report done (`docs/research/design-layer.md`); awaiting owner review |
| 3 | Foundation docs: `SPEC.md` v2, `ONE-TIME-SETUP.md`, `TOKENS.md`, `DECISIONS.md`, branch protection | Agent | Drafts done; branch protection once the repo exists |
| 4 | `packages/core`: Worker, forms engine (auto opt-in, file uploads with safeguards), migrations, mailers (Cloudflare, Resend, Apps Script), QA, and the `bootstrap`, `promote`, `teardown` and `editing` scripts | Agent | Not started |
| 5 | `ops/`: site registry, account-wide backup Worker, Apps Script mailer | Agent; owner deploys the mailer | Mailer drafted |
| 6 | `starter/`: Astro 7, wired to `packages/core`, ready for EmDash | Agent, after step 2 is agreed | Not started |
| 7 | Self-test on every push: dummy-config build, QA gate, lead test, upload test, EmDash-on build, no real email | Agent | Not started |
| 8 | Second test build: a new idea on `workers.dev`, from one prompt | Owner picks the idea; agent builds | Not started |
| 9 | Promote it to launch mode on a spare domain | Owner picks the domain; agent runs `promote` | Not started |
| 10 | Modules: CRM mirror, newsletter, drips | Agent | Designed, not built |
| 11 | Tag v1.0.0 | Agent | |

## Upload safeguards (required before uploads ship)

1. Verify the Turnstile token server-side before issuing a presigned URL.
2. Enforce a size cap and a content-type allow-list when signing.
3. Rate-limit per IP, and set an R2 lifecycle rule that expires abandoned objects.
4. Give previews their own bucket (`previews.r2_buckets`), so a preview never writes to production uploads.
