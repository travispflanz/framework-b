// Unit tests for the logo concept format (scripts/lib/logo.mjs): what a concept may contain (including the four
// lenses), how each version gets its colours, how words and placed symbols are expanded, the brief's sections, and the
// site's design research (scripts/lib/design-research.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF, BRIEF_PLACEHOLDER, LOGO_CONTRAST, briefProblems, briefTemplate, expandSymbol, lintConcept, paint, parseConcept,
  ratio, squareBox, svgFile, usage, variantPalettes,
} from "../lib/logo.mjs";
import { LENSES, PLACEHOLDER, missingLenses, undatedLenses, unwrittenLenses } from "../lib/design-research.mjs";
import { readFileSync } from "node:fs";

const GOOD = `<svg xmlns="http://www.w3.org/2000/svg" data-type="combination" data-idea="A doorway that is also the letter E" data-from="PRODUCT.md: the shop's red door" data-trend="Simple Twist: one negative-space cut (trend report, 2026-01-01)" data-look="Flat shapes in the site's ink and its one accent, like its square-cornered cards">
  <symbol id="mark" viewBox="auto">
    <mask id="cut"><rect width="100" height="100" fill="white"/><rect x="30" y="20" width="40" height="80" fill="black"/></mask>
    <rect width="100" height="100" fill="ink" mask="url(#cut)"/>
    <path fill="accent" fill-rule="evenodd" d="M0 0h10v10H0z"/>
  </symbol>
  <symbol id="lockup" viewBox="auto">
    <use href="#mark" x="0" y="0" width="100" height="100"/>
    <fb-text font="display" size="80" x="130" center-y="50" fill="ink">Example Co</fb-text>
  </symbol>
</svg>`;

test("a concept with a mark, a lockup, roles and holes passes", () => {
  const c = parseConcept(GOOD);
  assert.deepEqual(lintConcept(c), []);
  assert.equal(c.meta.type, "combination");
  assert.deepEqual(Object.keys(c.symbols), ["mark", "lockup"]);
});

test("the rules: no idea, raw colours, fonts, pictures, styles and outside links fail", () => {
  const bad = (from, to) => lintConcept(parseConcept(GOOD.replace(from, to)));
  assert.match(bad(/data-idea="[^"]*"/, 'data-idea=""').join(), /data-idea/);
  assert.match(bad(/data-from="[^"]*"/, 'data-from=""').join(), /data-from/);
  assert.match(bad('data-type="combination"', 'data-type="swoosh"').join(), /data-type/);
  assert.match(bad(/data-trend="[^"]*"/, "").join(), /data-trend is missing/);
  assert.match(bad(/data-look="[^"]*"/, "").join(), /data-look is missing/);
  assert.doesNotMatch(bad(/data-trend="[^"]*" data-look="[^"]*"/, 'data-template="true"').join(), /data-trend|data-look/, "a template needs neither");
  assert.match(bad('fill="accent"', 'fill="#ff0000"').join(), /use "ink" or "accent"/);
  assert.match(bad('fill="black"/></mask>', 'fill="ink"/></mask>').join(), /inside a <mask>/);
  assert.match(bad('<path fill="accent"', '<text>Hi</text><path fill="accent"').join(), /<text> isn't allowed/);
  assert.match(bad('<path fill="accent"', '<image href="x.png"/><path fill="accent"').join(), /<image>|link/);
  assert.match(bad('<path fill="accent"', '<path style="fill:red" fill="accent"').join(), /style=""/);
  assert.match(bad('<path fill="accent"', '<linearGradient id="g"/><path fill="url(#g)"').join(), /gradient/i);
  assert.match(bad('<use href="#mark"', '<use href="#nothing"').join(), /isn't in the file/);
  assert.match(bad(/<symbol id="mark"[\s\S]*?<\/symbol>/, "").join(), /no <symbol id="mark">/);
  assert.match(bad('<symbol id="mark" viewBox="auto">', '<symbol id="mark" viewBox="0 0 100 60">').join(), /isn't square/);
});

test("versions: the page's paper and its inverse, one colour black and white; a weak accent falls back to ink", () => {
  const dark = variantPalettes({ bg: "#0c0c0c", ink: "#f6f4f0", accent: "#f0343c", "inverse-bg": "#f6f4f0", "inverse-ink": "#0c0c0c", "inverse-accent": "#b8121f" });
  assert.equal(dark.pageVariant, "on-dark");
  assert.deepEqual([dark["on-dark"].paper, dark["on-dark"].ink, dark["on-dark"].accent], ["#0c0c0c", "#f6f4f0", "#f0343c"]);
  assert.deepEqual([dark["on-light"].paper, dark["on-light"].ink, dark["on-light"].accent], ["#f6f4f0", "#0c0c0c", "#b8121f"]);
  assert.equal(dark.black.ink, "#000000");
  assert.equal(dark.white.accent, "#ffffff");
  // A light site without inverse colours: the dark version falls back to black paper; a pale accent becomes ink.
  const light = variantPalettes({ bg: "#ffffff", ink: "#111111", accent: "#ffd84a" });
  assert.equal(light.pageVariant, "on-light");
  assert.equal(light["on-light"].accent, "#111111");
  assert.match(light["on-light"].notes.join(), /draws the accent in ink/);
  assert.equal(light["on-dark"].paper, "#000000");
  for (const v of ["on-dark", "on-light", "black", "white"]) assert.ok(ratio(light[v].ink, light[v].paper) >= LOGO_CONTRAST);
});

test("expanding: words become paths, placed symbols are inlined with their ids scoped, roles are painted", () => {
  const c = parseConcept(GOOD);
  const text = (attrs, words) => ({ d: `M${attrs.x} 0 ${words.length}` });
  const boxes = { mark: [0, 0, 100, 100] };
  const out = expandSymbol(c, "lockup", { text, boxes });
  assert.ok(!out.includes("<fb-text"));
  assert.ok(!out.includes("<use"));
  assert.match(out, /<path fill="ink" d="M130 0 10"\/>/);
  assert.match(out, /<svg x="0" y="0" width="100" height="100" viewBox="0 0 100 100"/);
  assert.match(out, /id="mark0-cut"/);
  assert.match(out, /mask="url\(#mark0-cut\)"/);
  const painted = paint(out, { ink: "#111111", accent: "#cc0000" });
  assert.ok(!/fill="(ink|accent)"/.test(painted));
  assert.match(painted, /fill="#cc0000"/);
  assert.match(painted, /fill="white"/); // mask colours stay
  const file = svgFile(painted, [0, 0, 400, 100], { label: "Example Co", height: 36 });
  assert.match(file, /width="144" height="36"/);
  assert.match(file, /aria-label="Example Co"/);
});

test("the mark's box is square, and usage gives the header width, clear space and smallest sizes", () => {
  assert.deepEqual(squareBox([10, 0, 40, 100]), [-20, 0, 100, 100]);
  const u = usage([0, 0, 600, 100]);
  assert.equal(u.headerWidthPx, 216);
  assert.equal(u.clearSpace.share, 0.25);
  assert.equal(u.minimum.markPx, 16);
  assert.equal(u.minimum.lockupHeightMm, 6.4);
});

test("the brief: every section has to be written", () => {
  const template = briefTemplate("Example Co");
  assert.equal(briefProblems(template).length, BRIEF.length);
  const done = template.replaceAll(BRIEF_PLACEHOLDER, "Written.");
  assert.deepEqual(briefProblems(done), []);
  assert.match(briefProblems(done.replace(/## Clichés to avoid[\s\S]*?(?=## )/, "")).join(), /"Clichés to avoid" is missing/);
});

test("design research: the starter's file has all four lenses, unwritten; a written lens names a dated source", () => {
  const md = readFileSync("design/research.md", "utf8");
  assert.deepEqual(missingLenses(md), []);
  assert.deepEqual(unwrittenLenses(md), LENSES);
  const written = md.replaceAll(PLACEHOLDER, "Looked at three sites on 2026-01-01.");
  assert.deepEqual(unwrittenLenses(written), []);
  assert.deepEqual(undatedLenses(written), []);
  assert.deepEqual(undatedLenses(md.replaceAll(PLACEHOLDER, "Written without a source.")), ["The field", "Current design", "The site's own look"]);
  assert.deepEqual(missingLenses(md.replace("## Current design", "## Trends")), ["Current design"]);
});
