---
name: build-site
description: Build a new Framework B idea site from one owner prompt - brief, create, design, content, preview check, owner approval, production check and handoff. Use when the owner describes a business or idea and asks for a site.
---

# Build a Framework B site from one prompt

Follow `docs/BUILD.md` step by step; it has the commands, inputs and gates. This skill is the checklist and the rules.

## Checklist

1. **Brief.** Write `brief.json` from the prompt (format in `scripts/site/lib/brief.mjs`). Research the business
   first; list every answer you chose in `inferred`. Run `node scripts/site/brief.mjs check brief.json` until it passes.
2. **Create.** Dispatch the ops repo's `site create` with the brief JSON in `brief`. Read the run summary for the URL
   and repo.
3. **Design.** In the site repo on branch `build/initial`: `PRODUCT.md` (facts with sources, inferred promises
   flagged). On autopilot, write three different drafts, render them with `node scripts/design-tiles.mjs`, judge them
   with `node scripts/design-judge.mjs prepare` → answer each ballot LEFT/RIGHT → `tally`, and lock the pick as
   `DESIGN.md`. Then `node scripts/design-tokens.mjs`. Credit every image in `design/credits.json`.
4. **Content.** `site.config.json` forms and navigation, `src/content/*.json` from the section library, then
   `node scripts/check-content.mjs` (and `node scripts/editing.mjs seed` with editing on).
5. **Local gates.** In a scratch copy with Turnstile test keys (`node scripts/fill-test-placeholders.mjs --turnstile-test`):
   `npm run build && npm run test:e2e && npm run qa`.
6. **Preview.** Push the branch, open a pull request, dispatch the ops repo's `site preview check` with `site_id` and
   `branch`. Fix until it passes.
7. **Approval.** Send the owner the pull request, the preview URL, the inferred items and any brief warnings. Wait
   for the merge. Never merge it yourself.
8. **Production.** QA on the production URL; ask the owner for one real lead from their phone; confirm it stored.
9. **Handoff.** Update `HANDOFF.md`; report in a few lines.

## Rules

- Ask only for: a missing business name or owner inbox, a choice that can't be undone and could go either way,
  or a credential. Decide everything else and record it as inferred.
- Site-specific work (names, URLs, logs) happens in the site repo and the private ops repo, never in framework-b.
- No invented proof: testimonials, ratings, counts and logos come only from the owner, with a source.
- Never commit secrets or test keys; never push to `main`; never buy anything or upgrade a plan without approval.
- Don't delete or rewrite leads or subscribers without the owner's explicit approval.
- If a gate fails, read its output, fix the cause and rerun. If the same gate fails twice for an unclear reason,
  research it before trying again; ask the owner if it still fails.
