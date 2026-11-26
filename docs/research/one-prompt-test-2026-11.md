# The second one-prompt test: findings and what closed them (2026-11)

Roadmap step 2 built a second site from one prompt, strictly by `docs/BUILD.md` on autopilot, to see where the
runbook, the skill and the scripts needed steering. Roadmap step 5 folds the findings back in. This file is the
dated record of both; it is not kept current.

## The test

- The site: a seed-club waitlist idea site (a monthly mail-order club, not selling yet, US only), in a field outside
  the first adopted site's. The owner let the agent pick the idea and every answer (2026-11-12), so the brief was
  written on autopilot with no owner answers.
- The run: framework `main` at `cb41b61`. A first attempt (2026-11-12) was cut off by a usage limit before anything
  was saved; the brief was redone from the start on 2026-11-17. Brief, create (an ops run by the coordinator), four
  lenses, three drafts judged by the autopilot judge (not the poster route), logo, style guide, content, local gates
  and one critique round were done that day; the preview check then passed with 244 checks. Two forms: a waitlist,
  and a plain message form for questions (`consent: "none"`, so asking a question never counts as a sign-up).
- The record: the build agent kept a steering log, 38 entries, each with what happened, what it did, where in the
  docs or scripts, and a suggested fix, graded **block** (none), **bug**, **gap**, **unclear** or **minor**. It
  lives with the site, which is private; the entries are summarised here without its name, copy or domain. One more
  finding (S6-01) came from the site's production QA run after the merge.

## What it showed

- The runbook held: nothing blocked the build, and the gates caught what they are there for (a line-length problem on
  one page, an untrue privacy sentence on the site sheet).
- Most findings were the brief and the order of steps: fields the format takes but the runbook never showed, a
  default (owner photos) that is wrong for an idea, `inferred` paths that could silently credit the owner, and
  step 3's tiles needing step 4's content first.
- Four were bugs in the design tools that could mislead a decision: tiles showing the inner pages' hero, critique
  ballots blind below the first screen, a pill radius turning the message box into an oval, and the privacy page's
  "every form signs you up" beside a form that signs no one up. All four were fixed first (#94, #95).
- The rest were rough edges: noise in the design.md lint, entities on the logo sheet, a placeholder left in the
  style guide, about 26 MB of screenshots on the site's branch, and an e2e test that only sent the first form.

## Findings and their triage

Counts (39 findings): 9 fixed already, 13 fixed now, 16 documented, 1 won't fix. "Fixed already" cites the pull request merged
before this batch (#94 merged as `cebe708`, #95 as `aa74651`, both 2026-11-19). The three pull requests of this
batch: #108 (brief and create), #106 (design tools and critique), #107 (generated pages and checks).

| # | Grade | Finding | Triage | Closed by |
|---|---|---|---|---|
| S1-01 | gap | The step 1 example left out fields the format takes (`business.id`, `postalAddress`, `audienceRegion`, `consent`, `crm`, `design.imagery`), and `design.imagery.style` silently defaulted to `owner-photo` for an idea with no photos | Fixed now: the example has every field; the check warns when the imagery style is left at its default | #108 |
| S1-02 | gap | Brief forms couldn't set a form's consent, and `create` never wrote the brief's forms | Fixed already: per-form `kind` and `consent`; `create` writes the forms | #94 |
| S1-03 | unclear | Whether research goes in the brief's `facts` | Documented: `facts` is what the owner stated; research goes in `PRODUCT.md` (BUILD step 1, the brief's header, README) | #108 |
| S1-04 | gap | A typo in `inferred` left the real field reported as stated, so DECISIONS credited the owner | Fixed now: an `inferred` path that names no field is an error (a parent path names its fields); one absent from the brief is a warning | #108 |
| S1-05 | unclear | What `business.location` is for an online business | Documented: the public city if it has one, else empty; only the DECISIONS "Where" row reads it | #108 |
| S1-06 | minor | SPEC said the site shape comes "from the design intake", which autopilot doesn't have | Documented: SPEC section 3 row 3 and BUILD step 1 give the rule (landing, full, hybrid) and its source | #108 |
| S1-07 | gap | Who chooses `design.words`, `references` and `avoid` on autopilot | Documented: two to four words from research, inferred; references left out; clichés in `avoid` | #108 |
| S1-08 | minor | The offer is also every page's default meta description | Fixed now: the check warns above 160 characters; BUILD step 1 and README say so, with Google's snippet page (checked 2026-11-25) | #108 |
| S1-09 | minor | With a brief, the create workflow's concurrency group falls back to the run id, so two dispatches don't queue | Documented: dispatch once and wait. Computing the group from the brief needs a job before the create job; not worth a change to a live workflow for a once-per-site step | #108 |
| S1-10 | gap | Kickoff DECISIONS rows credited the owner with the agent's choices, and the forms row said every form opts in | Fixed already: `answeredBy`, per-row and per-form sources | #94 |
| S1-11 | minor | An empty list (`"references": []`) counted as stated | Fixed now: an empty list or object is absent unless its path is in `inferred`; an empty `forms` is still an error | #108 |
| S1-12 | gap | No method for a name the owner leaves to the agent, though the id is permanent | Documented: candidates, field and web search, a DNS look without buying, runners-up in DECISIONS, the id is permanent (no rename path), the owner's USPTO search before launch | #108 |
| S1-13 | unclear | The brief fixes the imagery style before the four lenses that should decide it | Documented: the brief's imagery is the starting answer; step 3 may change it in DESIGN.md with a DECISIONS row; `brief.json` isn't edited | #108 |
| S1-14 | gap | Step 1 research has no home before the site repo exists | Documented: a notes file beside the brief, carried into PRODUCT.md and design/research.md at step 3 | #108 |
| S1-15 | minor | No guidance on a waitlist's confirmation email in idea mode | Documented: the thank-you page confirms; an auto-reply goes through the owner's Gmail quota, so it stays off unless the owner wants it | #108 |
| S1-16 | minor | The dispatch runs the framework's `main`, not the commit the brief was checked against | Documented: `framework_ref` pins the scripts and starter; the reusable workflow file still comes from the caller's `@main` | #108 |
| S1-17 | minor | Tools in the agent's session: web fetch prompts timed out, the GitHub proxy refused a repo lookup | Won't fix: the agent's environment, not the framework; `create` already checks that the repo and Worker names are free | |
| S2-01 | confirmed | The new repo's kickoff rows were as S1-10 predicted; correcting them needed correction rows | Fixed already (rows); how to correct a kickoff row documented in BUILD step 2 | #94, #108 |
| S2-02 | gap | `create` kept the starter's `contact` form, and the generated `/contact` failed to build without it | Fixed already: `/contact` and the home page's form section show the first form when there is no `contact` | #94 |
| S2-03 | minor | The starter's PRODUCT.md lacked the headings the QA gate reads | Fixed now: every heading in the template; the gate reads each section to the next heading, without comments | #107 |
| S3-01 | gap | Step 3's tiles build the real site, so step 4's content has to exist first | Documented: BUILD step 3 and the skill say what to build before the drafts | #106 |
| S3-02 | bug | Tiles showed the inner pages' hero, so the judge picked on the wrong first screen | Fixed already: tiles render the home hero and check it | #95 |
| S3-03 | minor | A YAML error in one draft stopped the whole tile run | Fixed now: reported per draft; CI passes a broken fourth draft | #106 |
| S3-04 | unclear | The imagery treatment is applied when a photo is added, before the design is locked | Documented: `images.mjs treat` already works on a photo added untreated; BUILD step 3 and its header say to run it after the lock | #106 |
| S3-05 | gap | No reference-capture tool on autopilot; the field lens was done with a throwaway script | Documented: screenshot by hand with the site's Playwright, dated. A tool stays a proposal (SPEC section 12): two of six field sites refused a headless browser in the test, so CI couldn't prove one | #106 |
| S3-06 | minor | The losing drafts' fonts stay in `package.json` | Documented: uninstall them after the pick | #106 |
| S3-07 | minor | Two design.md lint warnings come on every run of a Framework B DESIGN.md | Fixed now: counted, not printed; `--all-warnings` prints them | #106 |
| S3-08 | minor | `&apos;` printed literally on the logo sheets; tiles and ballots (about 10 MB) committed with nothing saying whether to | Fixed now: every XML entity decoded; ballot and critique screenshots ignored, the records kept | #106 |
| S3-09 | bug | The generated privacy page said every form signs you up, beside a form with consent `none` | Fixed already: privacy and thanks copy follow each form | #94 |
| S3-10 | gap | Fields shared the buttons' radius, so pill buttons made the message box an oval | Fixed already: `rounded.field`, and a QA check for an oval field | #95 |
| S3-11 | minor | The style guide template's placeholder stayed in when text was written after the comment | Fixed now: `style-guide.mjs` stops on a written section still holding it | #106 |
| S4-01 | gap | The waitlist was thanked with "We'll reply soon" | Fixed already: `/thanks` speaks to waitlists; BUILD step 4 says how a form gets its own thanks page | #94, #107 |
| S4-02 | gap | The e2e test sent only the first form, so the plain message form's consent went untested | Fixed now: every form is sent with its own address; a form on no page fails; the CI fixture's waitlist is on a page | #107 |
| S5-01 | gap | The scratch copy must be a git checkout for the critique | Documented: `git clone` the branch, link `node_modules`, `fill-test-placeholders` after every pull | #106 |
| S5-02 | bug | Critique ballots never showed changes below the first screen, so every fix was reverted | Fixed already: each ballot shows what changed | #95 |
| S5-03 | gap | A DESIGN.md fix in a critique round failed the QA gate on stale tokens and an old style guide | Fixed now: `compare` makes them again first; they are kept or reverted with the fix (a real round with such a fix is *untested*) | #106 |
| S5-04 | minor | The line-length rule found a design-wide problem on one page, late | Documented: run the QA gate once right after the lock. An estimate in `design-tokens.mjs` would need the body face's metrics and would still be a guess; the gate measures the real page | #106 |
| S5-05 | minor | About 26 MB of screenshots on the site's branch | Fixed now with S3-08 (the screenshots are working files) | #106 |
| S6-01 | minor | Production QA failed twice on the contact page, then passed unchanged: a page load timed out waiting for "load", then Lighthouse's robots-txt audit failed while robots.txt answered 200 in under a second | Fixed now: one retry for a page load that times out or hits a network error, and for a Lighthouse run whose page didn't load or whose audit failed on a fetch; each retry printed and kept in the report | #107 |

## What a site needs

- Sites pick up the starter changes (#106, #107) with their next **site update**; the brief changes (#108) touch
  only new sites. A site with a form that no page
  shows will fail the e2e test until the form is placed or removed. A site's own PRODUCT.md is unchanged.
- The test site itself still has its kickoff correction rows and the oval message box flagged in its pull request
  (S3-10 is fixed in the framework; the site gets it with an update).
