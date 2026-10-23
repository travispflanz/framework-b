# Roadmap to v1.0.0

The v1.0.0 milestone: a new idea is built from one prompt, using this repo. The owner's only touches are the kickoff answers, the design intake and the preview approval. That idea is then promoted to launch mode.

| # | Step | Who | Status |
|---|---|---|---|
| 1 | Create the empty private repo `framework-b` and give the Claude GitHub app access | Owner | Done 2026-10-22 |
| 2 | Design layer research → design phase and full design intake | Agent, then owner review | Approved by owner 2026-10-22 (`docs/research/design-layer.md`, `docs/research/apify-huggingface-design.md`) |
| 2b | Design trials: calibrate the autopilot judge on the CC-BY landing-page arena votes; run `dembrandt` on 5 reference sites | Agent; owner supplies a Hugging Face token for the arena data | Done (`docs/research/trials.md`). dembrandt: adopt with limits. Pairwise judge: 15 of 16 clear pairs agree with humans, 24 of 24 order-consistent; adopt, near-ties count as ties |
| 3 | Foundation docs: `SPEC.md` v2, `ONE-TIME-SETUP.md`, `TOKENS.md`, `DECISIONS.md`, branch protection | Agent | Drafts done; branch protection once the repo exists |
| 4 | `packages/core`: Worker, forms engine (auto opt-in, file uploads with safeguards), migrations, mailers (Cloudflare, Resend, Apps Script), QA, and the `bootstrap`, `promote`, `teardown` and `editing` scripts | Agent | Core 0.1.0 merged: forms, uploads, mailers, unsubscribe, admin, migrations, `_headers`; 23 tests in workerd. Forms engine UI and QA gate are in `starter/`. `create`, `teardown` and `connect-builds` passed a live self-test on 2026-10-22; preview-branch builds are untested. `editing on` (core 0.2.0 and `starter/scripts/editing.mjs`) passed CI and a live self-test on 2026-10-23. `editing off` and `promote` are not started |
| 5 | `ops/`: account-wide backup Worker, Apps Script mailer, site registry | Agent; owner deploys the mailer | Backup Worker live since 2026-10-23. It runs every Monday from a Cron Trigger. The first run backed up 5 of 5 databases. An uptime keyword monitor watches `/status`. Mailer: drafted, not deployed. Registry: not needed; resources are found through the Cloudflare API |
| 6 | `starter/`: Astro 7, wired to `packages/core`, ready for EmDash | Agent, after step 2 is agreed | Merged: pages, form engine, privacy page, `_headers`, end-to-end test, QA gate, EmDash switch. In review (2026-10-23): the design-phase foundation, which covers DESIGN.md → tokens with lint and contrast gates, the section library shared with EmDash, and the truth gate and copy lint. Not yet: style tiles, the autopilot judge script, Impeccable |
| 7 | Self-test on every push: dummy-config build, QA gate, lead test, upload test, EmDash-on build, no real email | Agent | On every push to `starter/` or core: build, end-to-end lead and upload test, and QA gate on a local Worker. Weekly, from the ops repo: a live self-test that creates a site on the real account, runs QA on its URL, sends a lead with a file, checks it in D1 and R2, and tears the site down. EmDash-on build: in CI on every push, and as the second job of the live self-test |
| 8 | Second test build: a new idea on `workers.dev`, from one prompt | Owner picks the idea; agent builds | Done 2026-10-23: Sunflower Bin Wash, an Olathe trash can cleaning service. It is an indexed idea site with EmDash on. Production QA passed (80 checks). The owner sent a real quote from a phone; it was stored with all fields and the visitor was subscribed. The owner signed in to EmDash and brought the content in. Two framework bugs were found and fixed on the way: the `_headers` noindex rule for indexed idea sites (core 0.2.1), and Turnstile iframe console noise in QA |
| 9 | Promote it to launch mode on a spare domain | Owner picks the domain; agent runs `promote` | Not started |
| 10 | Modules: CRM mirror, newsletter, drips | Agent | Designed, not built |
| 11 | Tag v1.0.0 | Agent | |

## Upload safeguards (required before uploads ship)

1. Verify the Turnstile token server-side before issuing an upload URL. Done in core 0.1.0 (tested).
2. Enforce a size cap and a content-type allow-list when signing, and again when the file arrives. Done (tested).
3. Rate-limit per IP. Done (tested locally; untested on the Free plan). Objects are only written after a ticket is claimed, so there are no abandoned objects to expire; a lifecycle rule is no longer needed.
4. Give previews their own bucket (`previews.r2_buckets`), so a preview never writes to production uploads. Done: `create` points previews at `fb-previews`. Untested until a preview branch is built.
