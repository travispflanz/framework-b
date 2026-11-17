# Building a site from one prompt (runbook)

How an agent turns one owner prompt into a reviewed idea-mode site. Each step names the script or workflow that
does it and the gate that ends it. The agent decides everything it can and asks only for what it can't: a required
answer that is missing, a choice that can't be undone and could go either way, or a credential.

Status (2026-10-27): every scripted step below has run live. The design and content steps are agent work with
gates and scripts: style tiles, the autopilot judge, this-or-that pairs and the critique rounds (SPEC section 12).

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
- Four lenses first, never the industry alone (SPEC section 12, "Four lenses"). Write `design/research.md` before any
  draft or route, with dated sources, and draw on it for every design decision after it (routes, logo, style guide,
  images, print and social):
  1. The business: what it does and is trying to achieve, who it is for, what it promises and refuses (PRODUCT.md).
  2. The field: two or three of the best sites in its industry and region, what visitors there expect (photos or
     illustration, how much text before the first action, booking or calling or quoting), the sea of sameness and
     its clichés.
  3. Current design: what design is doing now outside the field too (dated trend reports and galleries from the
     last 12 months: logo, web, type, colour, image, motion), which currents fit this business and why, which to
     avoid, and how to stay current without dating fast.
  4. The site's own look: the owner's photos or the archive's (era, subjects, texture), the type and colour, the
     owner's words; if it is nostalgic, nostalgic for whom and for what.
  Each draft takes a position on all four; the drafts differ from each other, not from the field. The content check
  fails a research file missing a lens and notes one unwritten or without a dated source.
- Every draft sets the skin and the skeleton. Besides colours, type, radii and spacing it has the Framework B blocks
  `composition` (alignment, density, separation, card style, image shape, motion, phone budget, title case, the
  hero layouts for the home page and the family for every other page, and the closing section) and `imagery` (style,
  secondary, treatment, grain, a one-line art direction). The brief's `design.imagery` answers decide the imagery
  block. Allowed values: the header of `scripts/design-tokens.mjs`.
- With an owner, routes come before drafts (SPEC section 12, "Design routes"). A route is a whole page skeleton
  with its own image demand and type behaviour; two routes that differ only in fonts and colours are one route.
  1. References: capture current sites from curated galleries (current design) and from the business's own field,
     with the site's own material beside them (design/research.md), and measure them
     the same way (images per page, how much of the page is image, the first screen, the phone layout). Name every
     site you use.
  2. Routes: three or four, each modelled on named reference sites and mocked as a page family with the site's real
     copy and images it may legally use, at desktop and phone width: the home page and one inner page (a content
     page, and the form page too if the site has one). Look at how each reference carries its home page onto its
     inner pages, and do the same. Measure each like the references, and list what each needs from the owner
     (photos, new short phrases, which are written for the owner to approve).
  3. The owner picks one or a mix, and may add conditions ("only if the text over the photos is readable"). Research
     each condition before changing anything, and turn it into a measurement. Record the pick in `DESIGN.md`: the
     route's title case, its hero layouts (the home page's, and the family the other pages choose from) and the
     section content pages end on (`composition.titleCase`, `composition.heroes`, `composition.closing`), and in the
     Overview its moves (how titles sit, how type meets a picture, the card style, the rhythm of pictures down a
     page), so a page added later, by anyone, gets them. Variety comes from the family; the language stays the same.
  4. Build the pick on the home page of the site itself. Section layouts the route needs go in the site's own `src/sections/` (site
     changes survive framework updates); they move into the starter only when a second site needs the same thing.
  5. Logo, unless the owner has one they are keeping (SPEC section 12, "Logo"): the brief, concepts drawn from the
     brand's own world, the test sheet, the owner's pick and the kit. Details under "Logo" below.
  6. Style guide, before the other pages: write `STYLE-GUIDE.md` from DESIGN.md, PRODUCT.md, the owner's decisions
     and the built home page (every heading in the starter's template; plain words and the owner's own sentences),
     then `node scripts/style-guide.mjs`. It renders the guide with the site's real colours and contrast, type scale,
     components, hero layouts and page flow, the first screen of every page, and the social and print sizes with
     their sources, into `design/style-guide/style-guide.pdf`. Send it to the owner. Every inner page, post, email and
     print piece is made from it, and it is rendered again whenever DESIGN.md or STYLE-GUIDE.md changes (the QA gate
     fails a guide older than either).
  7. Carry the route through every page, not just the home page: the same title treatment, sections, image style
     and phone settings, and pictures on the inner pages too (the QA report lists content pages with none). The home
     page may be louder; it may not speak a different language (SPEC section 12, "One design language"). Flow is the whole
     page, not the hero: the content check holds every hero to the family and every content page's ending to
     `composition.closing`; the QA gate fails a page title unlike the home page's, a bare photo banner and a page that
     runs longer without a picture than the home page does, and draws `qa-output/site-sheet-1280.png` and `site-sheet-360.png`. Look at the sheets before the
     owner does. No section leaves one side of a wide screen empty: put the headline beside the text (`split`), centre
     the column (`center`, `stack`) or put pictures beside it (`aside`), never widen the lines; the QA gate fails a
     lopsided section. Choose every crop: a picture cropped by a third or more needs `focalX` or `focalY` on that axis,
     and `qa-output/crop-sheet-1280.png` and `crop-sheet-360.png` show each crop over its whole picture: check every
     subject (heads, signs, faces) is inside its frame. Size the logo with `composition.logo` (`standard`, `large`,
     `masthead`); it is never shorter than the buttons (SPEC section 12, "Balance, crops and the logo's size"). Long text
     under a big heading goes in a `wide` statement band with a key word as `==accent==`; a side-by-side hero can
     `fade` its photo into the page. For black and white photos, offer the owner spot colour (SPEC section 12, "Spot
     colour"): one object per photo, chosen for its story, with `node scripts/spot-colour.mjs`.
  8. Measure the built pages, not the mock: the QA gate (which measures text over pictures), the phone length and
     each of the owner's conditions. Tell the owner about anything the build changed, with the trade-off.
  9. Write the owner a shot list: each image slot, what the frame has to do and where it leaves room for text.
- Autopilot: write three deliberately different drafts in `design/drafts/` (different style, palette, type pair and composition; install their fonts), then:
  - `node scripts/design-tiles.mjs design/drafts/*.md` renders each on the site's real content (drafts that fail the design checks are rejected);
  - `node scripts/design-judge.mjs prepare`, look at each `design/judge/ballot-NN.png` and answer LEFT or RIGHT in `ballot.json` without looking up which draft is which, then `node scripts/design-judge.mjs tally`;
  - copy the pick (or, on a tie, the draft closer to the brief) to `DESIGN.md` and record the result in its Overview.
  With an owner intake, the owner picks from `design/tiles/index.html` instead.
- With or without an owner, the logo and then the style guide (steps 5 and 6 of the route method above) come once
  the home page is built and before the other pages.
- With an owner intake, before the drafts: this-or-that (P2.5). Write 4–6 pairs in `design/pairs.json` (each changes
  one thing: display type, palette, imagery, density or shape; format at the top of `scripts/design-pairs.mjs`), run
  `node scripts/design-pairs.mjs render`, send the owner `design/pairs/*.png`, and record each answer with
  `node scripts/design-pairs.mjs pick <id> a|b`. If the owner doesn't answer, `defaults` records the recommended sides
  as inferred. The drafts then follow the picks in `design/intake.json`.
- `node scripts/design-tokens.mjs`. It fails on lint errors, a missing token, an unknown composition or imagery value,
  or a contrast pair below WCAG AA, and writes `tokens.css` and `design.json`.
- Logo (unless the owner supplied one they are keeping; then put it in `public/logo.svg` and set `site.logo`). The
  name set in a font alone is often what everyone in the field already does (it was for the first adopted site), so
  a logo needs a shape or an idea that only this business has (SPEC section 12, "Logo").
  1. `node scripts/logo.mjs brief`, then write `design/brand/brief.md` from `design/research.md` (the four lenses):
     the business and its goals, who it must reach, three words it should feel like and three it must not, the
     site's own look (its photographs' era and texture, its type and colour, and exactly what any nostalgia is for),
     current design (the currents that fit and the ones to avoid, from dated trend reports), the sea of sameness
     (what similar businesses' logos do, with where you looked and the date), the clichés to avoid (including any
     symbol that promises something the business doesn't offer), ideas from the brand's own world (each with the fact
     it comes from), where it must work (smallest first) and what to keep.
  2. Draw five to eight concepts in `design/brand/concepts/<id>.svg` (format at the top of `scripts/lib/logo.mjs`):
     several types (pictorial, abstract, emblem, combination, wordmark), each from a different idea in the brief,
     each naming the fact it comes from (`data-from`), the current design move it uses (`data-trend`) and how it
     belongs to the site's own look (`data-look`); `check` refuses a designed concept without them. Period faces
     that belong to the site's world are fine for the logo (it is outlined, so no web font loads); words can run
     round a seal (`<fb-text arc="top|bottom" r cx cy>`).
     Draw in two roles, ink and accent, with holes for cut-outs, so every version is exact in one colour. Words are
     `<fb-text>`, set in the design's fonts; `node scripts/logo.mjs measure "<words>"` gives their width. With the
     current logo as one concept (marked `data-template="true"`), the owner can compare.
  3. `node scripts/logo.mjs check`, then `node scripts/logo.mjs sheet`: every concept in the header at 36 px, the
     phone header, on dark and light paper, in one colour black and white, on the home page's photo, the mark at 16,
     32 and 48 px, browser tabs, a circle avatar, the maskable app icon and a business card at full size. Look at
     every sheet, fix what fails, and send `design/brand/concepts.pdf` to the owner with a recommendation and each
     concept's honest weakness. On autopilot, pick against the brief and record why in DECISIONS.md.
  4. `node scripts/logo.mjs pick <id>`: the logo for the page colour, on-dark, on-light, black and white versions,
     the mark, favicons (SVG and a 96 px PNG), Apple touch and app icons, a maskable icon, the share image, the
     manifest, print PDFs and 2000 px PNGs in `design/brand/kit/`, a social avatar, and `design/brand/logo.json`
     (clear space and smallest sizes, which the style guide shows). Then render the style guide again.
  5. Before launch the owner searches the name and the mark in the USPTO trademark database and records it in
     HANDOFF.md.
  The six quick layouts of the first brand kit are still there for a site that needs no designed logo:
  `node scripts/logo.mjs templates [--initials AB] [--icon <Phosphor name>]` (or `node scripts/brand-kit.mjs
  options`), then `sheet` and `pick t<n>`.
- In a set of cards where some carry photos, most do. A type-only card is a deliberate accent (one, or a few in a long
  set), not where the photos ran out. Each photo is chosen for what its card says, as closely as the source allows.
- Text over a picture sits on a scrim or on a part of the picture darkened for it. The QA gate measures it against
  the lightest part of the picture behind it (the darkest, for dark text), at phone and desktop width.
- Images: owner photos first; then public-domain archives, open-licensed photos or generated images, whichever the
  imagery style (and the owner) calls for. Library of Congress photographs: `node scripts/images.mjs search
  "<subject>" --source loc`, look at the contact sheet, then `node scripts/images.mjs add loc:<id> --as <name> --alt
  "..." --for "<slot: why it fits>"`. It takes only records that say "No known restrictions on publication", downloads
  the master scan, crops the mat and edge markings (look at `design/image-candidates/<name>-crop.png`; `--crop` sets
  the cut by hand) and writes the credit. Open-licensed photos: `search` and `add` without `--source`. Both apply the
  design's treatment so the set matches. `--for` records where each photo goes and why, so the choice can be reviewed.
  A photo taken off the pages goes to the library, never the bin: `node scripts/images.mjs shelve <file>` (and
  `unshelve`, `library` for a contact sheet). Credits go on the Website assets page (`/credits`), never beside the image. Generated images never show the business's own people, premises, products or work; photorealistic
  ones show no faces, none carries a label on the page, and all of them are listed on `/credits`. Every image gets an entry in
  `design/credits.json`, with what AI did as `ai` (the tools write it) and your model named once as `aiBy` (`--by` on
  the tools sets it); the Website
  assets page lists them (SPEC section 12, "Website assets: how AI was used").

## 4. Content (P3)

- `site.config.json`: forms (fields from the brief's purpose), navigation (one `cta` item), indexing as briefed.
- `src/content/home.json` (and one file per page for `full` or `hybrid`, each with a `title` and `description`, added to
  `nav`): sections from the library, following the page's argument. Copy uses the owner's facts; nothing invented.
- Sections: pick each section's `variant` (layout) for what it has to say, and its `phone` behaviour where the default
  doesn't fit (`stack`, `swipe`, `collapse` or `hide`; defaults in `PHONE_AUTO` in `src/sections/schema.js`). `swipe`
  suits a set of like items people browse (a wall of services, a gallery); things read in order, or the one thing a
  visitor must see, go in `stack` or `collapse` ("Crucial information does not belong in a carousel or in any other
  horizontally scrolling container", SPEC section 12). Every swipe strip gets the swipe cue, an accent bar with an
  arrow head under it (`starter/src/sections/SwipeCue.astro`), and the QA gate lists each one, so it is a choice, not an accident. The QA
  gate fails a home page longer than the design's phone budget: fold or hide a section, or take the trade-off to the
  owner.
- Images: the owner's photos first. Otherwise `node scripts/images.mjs search "<query>"`, look at the contact sheet,
  `add` the ones that fit with real alt text. A stock photo is never presented as the business's own work, customers or
  staff; prefer photos without identifiable people. For a generated style, `node scripts/generate-image.mjs draft
  "<subject>" --as <name> [--aspect 3:2]`, look at `design/generated/<name>/sheet.png`, then `use <name> <n> --alt
  "..."`. Without the Workers AI token in reach, run the ops repo's **site images** workflow instead (`draft`, look at
  `sheet.png` in its artifact, then `use`); without the token at all, use open-licensed photos and tell the owner
  (docs/TOKENS.md section 5).
- `node scripts/check-content.mjs`.
- With client editing on: `node scripts/editing.mjs seed` after the content changes.

## 5. Local gates

Run them in a scratch copy of the site (without `dist/`, `.wrangler/` and `qa-output/`): first
`node scripts/fill-test-placeholders.mjs --turnstile-test`, then `npm run build && npm run test:e2e && npm run qa`.
The site's real Turnstile widget only allows the account's workers.dev hostname, so on localhost it fails with
error 110200 and every form page logs a console error (seen 2026-10-27); the copy uses Turnstile's test keys instead.
With editing on, the same command also fills the missing resource IDs. Never commit test keys.

When the gates pass, run the critique rounds in the same copy (at most three; SPEC section 8 and the header of
`scripts/design-critique.mjs`): `node scripts/design-critique.mjs start`, fill in `design/critique/round-N.md`
(five 1–5 scores, the tells, at most three located fixes), `score`, apply the fixes without committing, `compare`
(rebuild, QA gate, ballots), answer each ballot LEFT or RIGHT without looking up which side is which, then `decide`.
A fix is kept only if it wins both ways round on every changed page; otherwise it is reverted. Copy the kept files
(listed in `design/critique/state.json`) and `design/critique/` back to the site's branch.

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
prompt), the two site sheets from the QA gate (every page's first screen at desktop and phone width), what was
inferred and needs a yes, and any brief warnings. Merging the pull request is the approval;
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
(SPEC section 2, "Updating a site to a newer framework"). Run **site preview check** on that branch before merging.

## After the build: launch and the modules

Each of these is one ops workflow, run when the owner asks. Inputs: `ops/ops-repo/README.md`.

- **Launch on a domain** (SPEC section 2): the domain must be an active zone in the account, or a one-level subdomain
  of one, and the owner's inbox a verified Email Routing destination. Ask the owner for the postal address. Run
  **site promote** with `phase: prepare` (try `dry_run: yes` first), send the owner its pull request, and after the
  merge and deploy run `phase: finish`. Then the owner sends one real lead from their phone, and ticks the checklist
  promote wrote into `HANDOFF.md`.
- **Newsletter** (launch sites; SPEC section 10): write `newsletter/<date>-<slug>.md` (front matter `subject`, optional
  `preview`) on a branch, run **site newsletter** with `mode: test` and `site_ref: <branch>`, let the owner read it and
  merge, then `mode: send`.
- **Drips** (launch sites with Resend): add the `drips` block to `site.config.json` and the Workflow binding to
  `wrangler.jsonc` (site `AGENTS.md`, "Rules"), by pull request. Write the emails only from what the owner supplied.
- **CRM mirror:** `"crm": { "sheet": true }` and/or `"webhook": true` in `site.config.json` by pull request (the
  webhook also needs the Worker secret `CRM_WEBHOOK_URL`, and optionally `CRM_WEBHOOK_SECRET`); then **site crm sync**
  copies the older leads.
- **Client editing on, for a site that exists:** **site editing** with `mode: on` (and `editors`, besides the owner) makes the resources, the editor Access application and the secrets, and opens a pull request. After the merge, the owner opens `/_emdash/admin` and chooses the sample content in the setup wizard (or waits for the Worker's next hourly run, which brings every page in too); until then every page shows what it showed before.
- **Add an editor:** **site editing** with `mode: on` and their email in `editors`. With editing already on, it only adds
  them to the editor login (everyone already there stays) and opens no pull request.
- **Client editing off:** **site editing** with `mode: off` opens a pull request with the content back in files.
- **Take a site off its domain without deleting it:** **site snapshot**, then **site park** (`action: undo` puts it
  back exactly).
- **Adopt an existing site** (SPEC section 2, "Adopting an existing site"): build the new site from the starter in
  a new repo `site-<id>` on `build/initial`, in launch mode with the old site's domain, keeping its content and URLs.
  Write `adopt.json` and the mapping queries, run **site adopt** `prepare` with `dry_run: yes` until every row maps,
  then for real, then `preview`. Send the owner the pull request and the preview URL; after the merge, `cutover`.
- **Remove a site:** **site teardown**, with the owner typing `confirm: delete <id>`. Leads are exported to backups
  first. A Resend domain `mail.<host>` left by a subdomain site already removed: **site teardown** with
  `site_id: <its id>`, `mail_domain: mail.<host>` and the owner typing `confirm: delete mail.<host>`.
