# Framework B: agent instructions (this repo)

This repo is the framework itself, not a website. Websites are built from `starter/` into their own new repos.

To build a site from an owner's prompt, follow `docs/BUILD.md` step by step (Claude: the `build-site` skill). The owner's private ops repo runs every step that changes their Cloudflare account; never ask for their Cloudflare token.

## Rules
- Brand-agnostic only. No business names, domains, addresses, copy or assets from any real site belong in this repo. Examples use `example.com` and "Example Co".
- Work on a branch and open a pull request. Never push to `main`. After cloning, run `git config core.hooksPath .githooks` so the pre-push hook enforces this.
- Never commit secret values. Use placeholders in `.dev.vars.example`; real values live in Worker secrets or the agent's environment.
- Nothing may depend on the owner's computer. CI runs on Workers Builds or GitHub Actions; schedules run on Cloudflare Cron Triggers or GitHub Actions schedules. Cloudflare numbers weekdays from 1 = Sunday: write cron days as `MON`, `TUE`, ...
- Never buy anything, upgrade a plan, or create paid resources without the owner's explicit approval.
- Every claim about a vendor's limits, prices or APIs in `docs/` cites the vendor's page and the date it was checked.
- Mark anything not yet proven by a test as "untested".

## Layout
- `README.md`: the human guide (features, setup, building a site with any AI agent, settings). Keep it in step with what ships.
- `docs/`: `SPEC.md` (how a site is built and why, with evidence), `BUILD.md` (runbook: one prompt to a reviewed site), `ONE-TIME-SETUP.md`, `TOKENS.md`, `DECISIONS.md`, `ROADMAP.md`; `docs/research/` is a dated record, not kept current
- `.claude/skills/build-site/`: the agent skill that follows `docs/BUILD.md`
- `starter/`: the template copied for each new site (its `AGENTS.md` is the site agent's guide)
- `packages/core/`: the versioned runtime every site's Worker is built from, including the CRM mirror and drips
- `scripts/site/`: the scripts behind the ops workflows (create, update, preview check, promote, newsletter, CRM sync, snapshot, park, teardown)
- `.github/workflows/`: reusable workflows the ops repo calls (`site-*.yml`, `deploy-backup-worker.yml`) and this repo's CI
- `ops/`: shared services (backup Worker, Apps Script mailer, webhook check) and `ops/ops-repo/`, the template for the owner's private ops repo

## Definition of done for a change
- CI passes: core tests, starter tests (static and editing builds, e2e, QA gate, editing round trip), site scripts tests, ops tests and the docs check (`node scripts/docs-check.mjs`).
- A change to anything that runs against the real account is proven live (an ops workflow run or the weekly `site selftest`), or marked "untested".
- `README.md` and `docs/` are updated in the same pull request; a new reusable workflow gets a caller in `ops/ops-repo/` and a row in the README.
