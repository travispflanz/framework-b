# Design trials

Trials from roadmap step 2b. Each one has a test fixed in advance (`apify-huggingface-design.md`, "Trial" table). Real sites used as inputs are not named here, per the brand-agnostic rule.

## dembrandt 0.39.2: token extraction and drift gate (run 2026-10-22)

Setup: dembrandt in the cloud container, driving the preinstalled Chromium through `BROWSER_CDP_ENDPOINT`. Without that variable, dembrandt downloads its own Chromium (about 187 MB) on first use.

| Test | Result |
|---|---|
| Font families on 5 public marketing sites, compared with computed styles read directly in the browser | **4 of 5 match** for both headings and body text. The fifth is inconclusive: the two runs saw different pages (no `h1` in the direct read, so probably an interstitial) |
| Brand/button colour in the extracted palette | **3 of 3** checkable sites match; one used `oklch()` and wasn't compared; one had no visible button |
| `--design-md` output passes `@google/design.md lint` 0.4.0 | **Pass**: 0 errors, 0 warnings on 2 sites |
| Quality of the `--design-md` type scale | **Poor**: 57–60 typography entries per site, and some body styles labelled 48 px. Usable for colours and font families, not for the type scale |
| Drift gate (`--tokens` with a DTCG file, `--max-off-token 0`) on the starter build | **Pass**: clean build exits 0; the same build with one off-token colour exits 1 and names the colour, its nearest token and the distance |

Verdict: **adopt, with limits**.
- P2.3 References: use dembrandt for the palette and font families of the owner's liked sites, as inputs to the tiles. Don't take its type scale.
- QA (launch mode, after `DESIGN.md` is locked): export tokens with `design.md export dtcg`, then run `dembrandt --tokens … --max-off-token 0` against each page. Not wired into `qa.mjs` yet.

## Pairwise judge calibration on the landing-page arena votes: not run

`datapointai/vibe-landing-page-arena` (CC-BY-4.0) is gated (`gated: auto`): download needs a Hugging Face account that has accepted the dataset's terms, and a read token. Blocked on the owner.
