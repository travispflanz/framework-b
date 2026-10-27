# Framework B: agent instructions (this repo)

This repo is the framework itself, not a website. Websites are built from `starter/` into their own new repos.

## Rules
- Brand-agnostic only. No business names, domains, addresses, copy or assets from any real site belong in this repo. Examples use `example.com` and "Example Co".
- Work on a branch and open a pull request. Never push to `main`. After cloning, run `git config core.hooksPath .githooks` so the pre-push hook enforces this.
- Never commit secret values. Use placeholders in `.dev.vars.example`; real values live in Worker secrets or the agent's environment.
- Nothing may depend on the owner's computer. CI runs on Workers Builds or GitHub Actions; schedules run on Cloudflare Cron Triggers.
- Never buy anything, upgrade a plan, or create paid resources without the owner's explicit approval.
- Every claim about a vendor's limits, prices or APIs in `docs/` cites the vendor's page and the date it was checked.
- Mark anything not yet proven by a test as "untested".

## Layout
- `docs/`: `SPEC.md` (how a site is built), `BUILD.md` (runbook: one prompt to a reviewed site), `ONE-TIME-SETUP.md`, `TOKENS.md`, `DECISIONS.md`, `ROADMAP.md`
- `.claude/skills/build-site/`: the agent skill that follows `docs/BUILD.md`
- `starter/`: the template copied for each new site
- `packages/core/`: the versioned runtime sites depend on
- `packages/modules/`: optional modules (CRM mirror, newsletter, drips)
- `ops/`: shared services (site registry, backup Worker, Apps Script mailer)

## Definition of done for a change
- The template self-test passes (when it exists): dummy-config build, QA gate, lead test, upload test, EmDash-on build.
- `docs/` is updated in the same pull request.
