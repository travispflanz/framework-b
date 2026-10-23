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

## Pairwise judge calibration on human votes (run 2026-10-22)

Data: Vibe Landing Page Arena (datapointai, CC-BY-4.0), 15 human votes per pair, "aesthetic" dimension ("Which design looks better at first glance?"). The calibration set comes from one shard (`scripts/trial-arena-sample.py`, run by `.github/workflows/trial-arena.yml` with the `HF_TOKEN` secret). It has 24 pairs:

- 16 clear-majority pairs (11 or more of 15 votes), to measure agreement;
- 8 near-ties (8–7), to measure order consistency only.

Each pair was shown twice, left/right swapped, at the first-screen crop, in shuffled order. The answer key was kept apart until all 48 judgments were recorded.

Judge: Claude (the cloud session model, `claude-opus-5-5`), answering only "LEFT" or "RIGHT".

| Measure | Result |
|---|---|
| Order consistency (same winner both ways round) | **24 of 24** pairs |
| Agreement with the human majority on clear pairs | **15 of 16** pairs (30 of 32 judgments) |
| Near-ties | 2 of 8 matched the 8–7 human side: no better than chance, as expected when humans split |

Verdict: **adopt the pairwise judge for autopilot, with two rules.**
1. Keep the "wins both ways round" rule. It costs little and catches position bias in weaker models.
2. Treat a judge's pick between two close candidates as a tie, not a signal. When two tiles are close, autopilot uses the one closer to the intake answers, and the owner can "redo the design" later.

Limits: 24 pairs from one shard, one judge model, first screens only. **Any other judge model (for example, the free models Hermes uses) must pass this same set before it judges autopilot designs**: at least 14 of 16 clear pairs and full order consistency. To re-run, dispatch `trial arena sample`, then score with the answer key.
