// Tests for src/sections/hero-layout.js: which layout a page's hero takes. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { heroLayout, isHomePath } from "../../src/sections/hero-layout.js";

const heroes = { home: "bento", page: ["split", "editorial"] };
const photo = { image: { src: "a.jpg", alt: "A" } };

test("the home page's hero takes heroes.home and every other page's the first of heroes.page", () => {
  assert.equal(heroLayout(photo, { home: true, heroes }), "bento");
  assert.equal(heroLayout(photo, { home: false, heroes }), "split");
  assert.equal(heroLayout({ ...photo, variant: "editorial" }, { home: false, heroes }), "editorial", "a hero's own variant wins");
  assert.equal(heroLayout({}, { home: false, heroes }), "statement", "no picture: a statement");
  assert.equal(heroLayout({}, { home: true, heroes }), "bento", "bento keeps its tiles without a picture");
  assert.equal(heroLayout(photo, {}), "split", "no route: the first layout");
});

test("a static build's home page (/index.html) is the home page; the style tile's URL is not", () => {
  for (const p of ["/", "", "/index.html", "/index"]) assert.equal(isHomePath(p), true, p);
  for (const p of ["/design-tile", "/contact.html", "/about", "/index-of-films"]) assert.equal(isHomePath(p), false, p);
});

test("the home pages and the style tile tell the hero it is the home page's", () => {
  // The URL can't say so for the tile (/design-tile), which is why tiles showed the inner pages' hero (2026-11-18).
  for (const f of ["src/pages/index.astro", "editing/src/pages/index.astro", "scripts/design-tile/tile.astro"]) {
    assert.match(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"), /<Sections sections=\{[^}]*\}\s+home\s*\/>/, f);
  }
});
