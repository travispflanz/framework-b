#!/usr/bin/env node
// CI check of the brand kit: with a named display font, `options` draws six logo layouts and a contact sheet, and
// `pick` installs the logo, favicon, app icons, share image and manifest, sets site.logo and credits every file.
// Then the content check runs, and everything it changed is put back (also after a failure). Needs the network
// (npm) for the font and icon packages.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const BACKUP = ["DESIGN.md", "site.config.json", "design/credits.json"];
const OUTPUTS = ["public/logo.svg", "public/apple-touch-icon.png", "public/icon-192.png", "public/icon-512.png", "public/og.png", "public/manifest.webmanifest"];
const saved = new Map(BACKUP.map((f) => [f, readFileSync(f)]));
const favicon = existsSync("public/favicon.svg") ? readFileSync("public/favicon.svg") : null;
function restore() {
  for (const [f, data] of saved) writeFileSync(f, data);
  for (const f of OUTPUTS) rmSync(f, { force: true });
  if (favicon) writeFileSync("public/favicon.svg", favicon);
  rmSync("design/brand", { recursive: true, force: true });
}
process.on("SIGINT", () => { restore(); process.exit(130); });
const run = (...args) => execFileSync("node", ["scripts/brand-kit.mjs", ...args], { stdio: "inherit" });

try {
  // A named display font (an OFL family on Fontsource); the starter's own is the system font.
  const design = readFileSync("DESIGN.md", "utf8");
  writeFileSync("DESIGN.md", design.replace(/(\n  display:\n(?:    .*\n)*?    fontFamily: ).*\n/, "$1Fraunces\n"));
  run("options", "--icon", "bicycle");
  for (let i = 1; i <= 6; i++) {
    const svg = readFileSync(`design/brand/options/option-${i}.svg`, "utf8");
    assert.ok(svg.includes("<path"), `option ${i} has no outlines`);
    assert.ok(!svg.includes("<text"), `option ${i} depends on a font (it has <text>)`);
    assert.ok(!svg.includes("NaN"), `option ${i} has NaN coordinates`);
  }
  assert.ok(existsSync("design/brand/options.png"), "no contact sheet");
  run("pick", "2");
  for (const f of [...OUTPUTS, "public/favicon.svg"]) assert.ok(existsSync(f), `${f} wasn't written`);
  const site = JSON.parse(readFileSync("site.config.json", "utf8"));
  assert.equal(site.site.logo, "/logo.svg");
  const credits = JSON.parse(readFileSync("design/credits.json", "utf8")).images;
  for (const f of ["public/logo.svg", "public/og.png"]) assert.ok(credits.some((c) => c.file === f && c.source === "brand"), `${f} isn't credited`);
  execFileSync("node", ["scripts/check-content.mjs"], { stdio: "inherit" });
  console.log("\nThe brand kit drew six layouts and installed the pick");
} finally {
  restore();
}
