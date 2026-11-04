// One design language (scripts/lib/cohesion.mjs): the title comparison, the bare-banner check in a real browser,
// and the site sheet.
//   node --test scripts/test/cohesion.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { launchBrowser } from "../lib/local-site.mjs";
import { bareBanners, siteSheet, titleMismatches, titleStyle } from "../lib/cohesion.mjs";

test("a page title that differs from the home page's in case or alignment is listed; size doesn't count", () => {
  const home = { face: "Display", weight: "800", case: "uppercase", align: "left" };
  const out = titleMismatches({ "/": home, "/a": { ...home }, "/b": { ...home, case: "as written", align: "center" } });
  assert.deepEqual(out, ["/b: case as written (home: uppercase), align center (home: left)"]);
  assert.deepEqual(titleMismatches({ "/a": home }), [], "no home page, nothing to compare");
});

// A 1px grey PNG stretched by CSS stands in for a photo.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaGj4DwAEhgJ/0p3+DQAAAABJRU5ErkJggg==";
const page = (body) => `<!doctype html><html><body style="margin:0;font:16px sans-serif"><main>${body}</main></body></html>`;

test("a wide photo alone is a bare banner; with the title over it or text beside it, it isn't", async () => {
  const browser = await launchBrowser();
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.setContent(page(`<h1 style="text-transform:uppercase">Title</h1><p>Lede.</p><img src="${PIXEL}" style="display:block;width:1200px;height:500px">`));
    assert.equal((await bareBanners(p)).length, 1, "photo band under the title");
    assert.deepEqual(await titleStyle(p), { face: "sans-serif", weight: "700", case: "uppercase", align: "left" });

    await p.setContent(page(`<section style="position:relative"><img src="${PIXEL}" style="display:block;width:1280px;height:600px"><h1 style="position:absolute;bottom:20px;left:20px;margin:0">Title on the photo</h1></section>`));
    assert.deepEqual(await bareBanners(p), [], "title over the photo");

    await p.setContent(page(`<div style="display:flex"><div style="width:400px"><h1>Title</h1><p>Beside the photo.</p></div><img src="${PIXEL}" style="width:800px;height:500px"></div>`));
    assert.deepEqual(await bareBanners(p), [], "text beside the photo");

    await p.setContent(page(`<h1>Title</h1><img src="${PIXEL}" style="display:block;width:600px;height:400px">`));
    assert.deepEqual(await bareBanners(p), [], "a photo under 60% of the window wide");
  } finally {
    await browser.close();
  }
});

test("the site sheet puts each page's first screen side by side", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sheet-"));
  for (const name of ["home", "about"]) writeFileSync(join(dir, `${name}-1280.png`), await sharp({ create: { width: 1280, height: 2000, channels: 3, background: "#336699" } }).png().toBuffer());
  const file = await siteSheet({ out: dir, pages: ["/", "/about", "/missing"], width: 1280, screen: 900, file: join(dir, "sheet.png") });
  const meta = await sharp(file).metadata();
  assert.equal(meta.width, 3 * 640 + 2 * 16, "three columns at desktop width");
  assert.equal(meta.height, Math.round((900 * 640) / 1280) + 34, "one row: two pages, the missing one skipped");
});
