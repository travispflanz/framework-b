# Building a site from one prompt (runbook)

How an agent turns one owner prompt into a reviewed idea-mode site. Each step names the script or workflow that
does it and the gate that ends it. The agent decides everything it can and asks only for what it can't: a required
answer that is missing, a choice that can't be undone and could go either way, or a credential.

Status (2026-10-26): every scripted step below has run live. The design and content steps are agent work with
gates, not scripts yet; the style tiles and the autopilot judge (SPEC section 12) are not built.

| Step | Phase | Who | Tool | Ends when |
|---|---|---|---|---|
| 1 | Brief | Agent | `scripts/site/brief.mjs` | `brief.mjs check` passes |
| 2 | Create | Agent | ops repo **site create** with the brief | site live at its `workers.dev` address |
| 3 | Design | Agent (owner if not autopilot) | `PRODUCT.md`, `DESIGN.md`, `scripts/design-tokens.mjs` | tokens generated, contrast passes |
| 4 | Content | Agent | `src/content/*.json`, `site.config.json` | `check-content.mjs` passes |
| 5 | Local gates | Agent | `npm run build`, `test:e2e`, `qa` | all pass |
| 6 | Preview | Agent | branch + pull request, ops repo **site preview check** | QA passes on the deployed preview |
| 7 | Approval | **Owner** | the pull request and its preview | owner merges |
| 8 | Production | Agent | QA on production, owner's test lead | QA passes, lead stored |
| 9 | Handoff | Agent | `HANDOFF.md`, monitors | owner has the links |

## 1. Brief

Write `brief.json` from the prompt. Format and defaults: `scripts/site/lib/brief.mjs`; the answers are SPEC
section 3's kickoff questions.

```json
{
  "version": 1,
  "business": { "name": "Example Co", "offer": "One line on what they sell.", "audience": "Who it's for",
                "location": "City, ST", "serviceArea": ["Neighbourhood"], "phone": "" },
  "owner": { "email": "owner@example.com" },
  "mode": "idea",
  "shape": "landing",
  "forms": [{ "id": "contact", "purpose": "quote request" }],
  "autoReply": false,
  "indexing": false,
  "editing": false,
  "newsletter": false,
  "design": { "autopilot": true, "words": ["friendly", "trustworthy"], "references": [], "avoid": [] },
  "facts": {},
  "claims": [],
  "inferred": ["shape", "business.audience"]
}
```

- Only `business.name` and `owner.email` are required. Ask for those if the prompt lacks them; never guess an inbox.
- Anything the owner didn't say but the agent chose goes in `inferred`; anything left out takes the framework
  default. `DECISIONS.md` records each answer's source.
- Research before inferring: the business's market, local rules that change the copy, competitors' prices.
  Research results are facts for `PRODUCT.md`, never `claims`. `claims` holds only proof the owner supplied
  (reviews, counts, awards), each with its source.
- `node scripts/site/brief.mjs check brief.json`. Fix every error. A warning (EU or Canadian audience, newsletter
  on an idea, CRM) is shown to the owner with the build's first report.

## 2. Create

Run the ops repo's **site create** with the brief's JSON in the `brief` field (the other fields stay empty), or
from a session: `gh api repos/<owner>/framework-b-ops/actions/workflows/site-create.yml/dispatches -f ref=main
-f "inputs[brief]=$(jq -c . brief.json)"`.

It creates every resource, the private repo `site-<id>` with `brief.json` and the kickoff rows in `DECISIONS.md`,
the first deploy, Access on `/admin` and previews (with the agent's Service Auth policy), Workers Builds, and the
uptime monitors (SPEC section 2). The run summary has the URL and the repo.

## 3. Design (P2)

Clone `site-<id>` and work on a branch, `build/initial`.

- `PRODUCT.md`: who it's for, the offer, the facts from research with sources, the inferred business promises
  marked for the owner to confirm, and "Approved claims" (only from `claims`).
- `DESIGN.md` in Google's format: autopilot follows SPEC section 12 by hand (direction from the brief's words and
  research, a deliberate choice off the ban list). If `design.autopilot` is false, run the intake with the owner.
- Autopilot: write three deliberately different drafts in `design/drafts/` (different style, palette and type pair; install their fonts), then:
  - `node scripts/design-tiles.mjs design/drafts/*.md` renders each on the site's real content (drafts that fail the design checks are rejected);
  - `node scripts/design-judge.mjs prepare`, look at each `design/judge/ballot-NN.png` and answer LEFT or RIGHT in `ballot.json` without looking up which draft is which, then `node scripts/design-judge.mjs tally`;
  - copy the pick (or, on a tie, the draft closer to the brief) to `DESIGN.md` and record the result in its Overview.
  With an owner intake, the owner picks from `design/tiles/index.html` instead.
- `node scripts/design-tokens.mjs`. It fails on lint errors, a missing token or a contrast pair below WCAG AA.
- Images: owner photos first, open-licensed second, generated only for abstract texture. Every image gets an entry in `design/credits.json`.

## 4. Content (P3)

- `site.config.json`: forms (fields from the brief's purpose), navigation (one `cta` item), indexing as briefed.
- `src/content/home.json` (and one file per page for `full` or `hybrid`, each with a `title` and `description`, added to
  `nav`): sections from the library, following the page's argument. Copy uses the owner's facts; nothing invented.
- Images: the owner's photos first. Otherwise `node scripts/images.mjs search "<query>"`, look at the contact sheet,
  `add` the ones that fit with real alt text. A stock photo is never presented as the business's own work, customers or
  staff; prefer photos without identifiable people.
- `node scripts/check-content.mjs`.
- With client editing on: `node scripts/editing.mjs seed` after the content changes.

## 5. Local gates

Run them in a scratch copy of the site (without `dist/`, `.wrangler/` and `qa-output/`): first
`node scripts/fill-test-placeholders.mjs --turnstile-test`, then `npm run build && npm run test:e2e && npm run qa`.
The site's real Turnstile widget only allows the account's workers.dev hostname, so on localhost it fails with
error 110200 and every form page logs a console error (seen 2026-10-27); the copy uses Turnstile's test keys instead.
With editing on, the same command also fills the missing resource IDs. Never commit test keys.

## 6. Preview (P6)

Push `build/initial` and open a pull request in `site-<id>`. Workers Builds deploys the branch as a preview behind
Access. Then run the ops repo's **site preview check** with `site_id` and `branch`. It:

1. adds the "framework-b agent" Service Auth policy to the site's previews application if it's missing;
2. waits for the branch's build and reads the preview URL from the build log;
3. mints a 30-minute Access service token, waits until Access accepts it (a few seconds), and runs the site's QA
   gate on the preview, sending the token only to the preview's own host;
4. deletes the token and posts the result on the pull request, with screenshots in the run's artifacts.

Fix and push until it passes. A site older than this check needs **site update** first.

## 7. Owner approval

Send the owner one message: the pull request link, the preview URL (they sign in with their email at the Access
prompt), what was inferred and needs a yes, and any brief warnings. Merging the pull request is the approval;
`main` deploys production.

## 8. Production (P8, idea mode)

- About a minute after the merge: `npm run qa -- --url https://<id>.<subdomain>.workers.dev` from the site
  (`--launch` is for launch mode).
- Ask the owner to send one real lead from their phone. Turnstile is real on production, so the agent can't.
  Confirm the row in `/admin` or D1.

## 9. Handoff

Update `HANDOFF.md`: URLs, monitors (both UP), backups, what's inferred and still open. Report to the owner in a few
lines.

## Keeping a site current

The ops repo's **site update** brings a site up to a newer framework on a branch with a tested pull request
(SPEC section 2, "Updating a site"). Run **site preview check** on that branch before merging.
