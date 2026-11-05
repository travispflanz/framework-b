#!/usr/bin/env node
// CI check of the logo method (scripts/logo.mjs) with a named display font:
// 1. the old brand kit command still works: six template concepts and their sheets, and redrawing one leaves the
//    others alone;
// 2. a designed concept (a mask, an even-odd hole, a placed mark, words centred on it) with a written brief passes
//    `check`, builds on the sheet and is picked: every file of the kit, vector PDFs with no pictures in them,
//    site.logo, credits and logo.json, and the content check still passes;
// 3. a concept that breaks the rules fails `check`, and a designed concept can't be picked without a brief.
// Everything it changes is put back, also after a failure. Needs the network (npm) for the fonts and PDF packages.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const BACKUP = ["DESIGN.md", "site.config.json", "design/credits.json"];
const OUTPUTS = ["public/logo.svg", "public/logo-on-dark.svg", "public/logo-on-light.svg", "public/logo-black.svg", "public/logo-white.svg", "public/mark.svg",
  "public/favicon-96.png", "public/apple-touch-icon.png", "public/icon-192.png", "public/icon-512.png", "public/icon-maskable-512.png", "public/og.png", "public/manifest.webmanifest"];
const saved = new Map(BACKUP.map((f) => [f, readFileSync(f)]));
const favicon = existsSync("public/favicon.svg") ? readFileSync("public/favicon.svg") : null;
function restore() {
  for (const [f, data] of saved) writeFileSync(f, data);
  for (const f of OUTPUTS) rmSync(f, { force: true });
  if (favicon) writeFileSync("public/favicon.svg", favicon);
  rmSync("design/brand", { recursive: true, force: true });
}
process.on("SIGINT", () => { restore(); process.exit(130); });
const node = (...args) => execFileSync("node", args, { stdio: "inherit" });
const attempt = (...args) => spawnSync("node", args, { encoding: "utf8" });

const CONCEPT = `<svg xmlns="http://www.w3.org/2000/svg" data-type="combination" data-idea="A doorway cut into a square, as the shop's front door" data-from="PRODUCT.md: the shop is known by its door" data-trend="Simple Twist: one negative-space cut (test fixture)" data-look="Flat ink and one accent, square corners, as the site's cards">
  <symbol id="mark" viewBox="auto">
    <mask id="door"><rect width="100" height="100" fill="white"/><path d="M34 100V46a16 16 0 0 1 32 0v54z" fill="black"/></mask>
    <rect width="100" height="100" rx="12" fill="ink" mask="url(#door)"/>
    <path fill="accent" fill-rule="evenodd" d="M44 8h12v12H44z M47 11h6v6h-6z"/>
  </symbol>
  <symbol id="lockup" viewBox="auto">
    <use href="#mark" x="0" y="0" width="100" height="100"/>
    <fb-text font="display" size="72" x="124" center-y="50" fill="ink">Example Co</fb-text>
  </symbol>
  <symbol id="stacked" viewBox="auto">
    <use href="#mark" x="-50" y="0" width="100" height="100"/>
    <fb-text font="display" size="40" x="0" y="150" anchor="middle" fill="ink">Example Co</fb-text>
  </symbol>
</svg>
`;

try {
  const design = readFileSync("DESIGN.md", "utf8");
  writeFileSync("DESIGN.md", design.replace(/(\n  display:\n(?:    .*\n)*?    fontFamily: ).*\n/, "$1Fraunces\n"));

  // 1. The brand kit's commands, now template concepts.
  node("scripts/brand-kit.mjs", "options", "--icon", "bicycle");
  for (let i = 1; i <= 6; i++) {
    assert.ok(existsSync(`design/brand/concepts/t${i}.svg`), `no template t${i}`);
    assert.ok(existsSync(`design/brand/sheets/t${i}.png`), `no sheet for t${i}`);
    const built = readFileSync(`design/brand/build/t${i}/lockup-on-light.svg`, "utf8");
    assert.ok(built.includes("<path") && !built.includes("<text") && !built.includes("NaN") && !/fill="(ink|accent)"/.test(built), `t${i} didn't build cleanly`);
  }
  assert.ok(existsSync("design/brand/sheet.png"), "no overview sheet");
  // Redrawing one concept leaves the others' sheets and the overview alone.
  const overview = readFileSync("design/brand/sheet.png");
  node("scripts/logo.mjs", "sheet", "t2");
  for (let i = 1; i <= 6; i++) assert.ok(existsSync(`design/brand/sheets/t${i}.png`), `sheet t2 removed t${i}'s sheet`);
  assert.ok(readFileSync("design/brand/sheet.png").equals(overview), "sheet t2 redrew the overview");
  assert.ok(!existsSync("design/brand/sheet.html"), "the sheet's page was left in design/brand");
  rmSync("design/brand/concepts", { recursive: true, force: true });

  // 3a. A designed concept without a brief can't be picked.
  mkdirSync("design/brand/concepts", { recursive: true });
  writeFileSync("design/brand/concepts/door.svg", CONCEPT);
  assert.notEqual(attempt("scripts/logo.mjs", "pick", "door").status, 0, "a designed concept was picked without a brief");

  // 2. With a written brief: check, sheet, pick.
  node("scripts/logo.mjs", "brief");
  writeFileSync("design/brand/brief.md", readFileSync("design/brand/brief.md", "utf8").replaceAll("To be written.", "Written for the test."));
  node("scripts/logo.mjs", "check");
  node("scripts/logo.mjs", "sheet");
  const concepts = JSON.parse(readFileSync("design/brand/concepts.json", "utf8")).concepts;
  assert.equal(concepts[0].problems.length, 0);
  node("scripts/logo.mjs", "pick", "door");
  for (const f of [...OUTPUTS, "public/favicon.svg"]) assert.ok(existsSync(f), `${f} wasn't written`);
  const kit = JSON.parse(readFileSync("design/brand/logo.json", "utf8"));
  assert.equal(kit.concept, "door");
  assert.deepEqual(Object.keys(kit.versions), ["on-dark", "on-light", "black", "white"]);
  for (const v of Object.keys(kit.versions)) {
    const pdf = readFileSync(`design/brand/kit/logo-${v}.pdf`, "latin1");
    assert.ok(pdf.startsWith("%PDF"), `logo-${v}.pdf isn't a PDF`);
    assert.ok(!/\/Subtype\s*\/Image/.test(pdf), `logo-${v}.pdf has a picture in it; the print file must be vector`);
  }
  assert.ok(readFileSync("public/logo-black.svg", "utf8").includes('fill="#000000"'));
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"), "no maskable icon in the manifest");
  assert.equal(JSON.parse(readFileSync("site.config.json", "utf8")).site.logo, "/logo.svg");
  const credits = JSON.parse(readFileSync("design/credits.json", "utf8")).images;
  for (const f of ["public/logo.svg", "public/logo-on-light.svg", "public/favicon-96.png", "public/og.png"]) assert.ok(credits.some((c) => c.file === f && c.source === "brand"), `${f} isn't credited`);
  node("scripts/check-content.mjs");

  // 3b. A concept that breaks the rules fails the check.
  writeFileSync("design/brand/concepts/bad.svg", CONCEPT.replace('fill="accent"', 'fill="#ff0000"').replace(/data-idea="[^"]*"/, 'data-idea=""'));
  const bad = attempt("scripts/logo.mjs", "check");
  assert.notEqual(bad.status, 0, "a concept with a raw colour and no idea passed the check");
  assert.match(bad.stdout, /bad: .*data-idea/);
  console.log("\nThe logo method drew the templates, built, tested and installed a designed concept, and refused a bad one");
} finally {
  restore();
}
