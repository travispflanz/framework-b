# Framework B site

This site was built with Framework B (see `framework.lock.json` for the version). Agents: read `AGENTS.md` first.

## Where things are

| You want to change | Edit | Then |
|---|---|---|
| Words, sections and pages | `src/content/<page>.json` (`home.json` is the home page; any other file is `/<file name>`) | `node scripts/check-content.mjs` |
| Name, tagline, menu, forms, email settings | `site.config.json` | `node scripts/check-content.mjs` |
| Colours, fonts, sizes, corners | `DESIGN.md` | `node scripts/design-tokens.mjs` |
| Photos | `src/assets/images/` plus a line in `design/credits.json` | `node scripts/check-content.mjs` |
| What the site promises and can prove | `PRODUCT.md` ("Approved claims" is the only place reviews, counts or ratings may come from) | |

With client editing on, the home page's words and images are edited at `/_emdash/admin` instead.

## How a change goes live

1. Make it on a branch and open a pull request. Workers Builds deploys the branch to a private preview URL (you sign
   in with your email).
2. Check the preview. An agent can run the ops workflow **site preview check** to test it.
3. Merge the pull request. `main` goes live within about a minute.

Never push straight to `main`: it deploys immediately. `git config core.hooksPath .githooks` after cloning makes git
refuse it.

## Leads

Every form submission is stored in the site's database and listed at `/admin` (Cloudflare Access login), with CSV
export. Every form also subscribes the visitor (one line under the button says so); `/u` unsubscribes them.

## Records

- `DECISIONS.md`: the kickoff answers and later choices, and who made each one.
- `HANDOFF.md`: URLs, monitors, backups, renewals, and the settings you confirmed yourself.
- `SECRETS.md`: the names of this site's secrets (never the values).
