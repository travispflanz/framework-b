# Framework B

A brand-agnostic system for AI agents to build, launch and run small business and idea websites on Cloudflare, from one prompt.

- **Hosting and runtime:** Cloudflare Workers with static assets, D1 for leads, R2 for uploads and backups, Turnstile, Access, Workers Builds.
- **Pages:** Astro 7, mostly static, with optional EmDash for client editing.
- **Agents:** any agent that reads `AGENTS.md` (Claude Code, Codex, Hermes Agent, Google Antigravity and others). Nothing runs on the owner's computer.

## Two modes

| | Idea mode | Launch mode |
|---|---|---|
| Address | `<site>.<account>.workers.dev` | The site's own domain |
| Email | Apps Script mailer in the owner's Gmail | Cloudflare (notifications) and Resend on `mail.<domain>` (lead email) |
| Leads | Shared `ideas` D1 with a `site` column | The site's own D1 plus a staging D1 |
| Indexing | Owner's choice; default `noindex` | Indexed |

Every site starts in idea mode and can be promoted to launch mode with one script.

## Layout

| Path | Purpose |
|---|---|
| `docs/` | Spec, one-time setup, token permissions, decisions, roadmap |
| `starter/` | Copied into a new, separate repo for each site |
| `packages/core/` | Versioned runtime every site depends on: Worker, forms, migrations, mailers, QA, scripts |
| `packages/modules/` | Optional modules: CRM mirror, newsletter, drips |
| `ops/` | Shared across sites: site registry, backup Worker, Apps Script mailer |

## Status

Under construction. See `docs/ROADMAP.md`.
