// One design language (scripts/lib/cohesion.mjs): the title comparison, the bare-banner check in a real browser,
// the site sheet, balance about the centre, crops and their sheet, and the logo's size.
//   node --test scripts/test/cohesion.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { launchBrowser } from "../lib/local-site.mjs";
import { balance, bareBanners, cropSheet, crops, logoFit, pictureRhythm, rhythmBreaks, siteSheet, titleMismatches, titleStyle } from "../lib/cohesion.mjs";

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

test("the home page sets the picture rhythm; a page that runs longer without a picture is listed", async () => {
  assert.deepEqual(rhythmBreaks({ "/": { pictures: 5, longest: 2 }, "/a": { pictures: 3, longest: 2.5 }, "/b": { pictures: 1, longest: 3.1 }, "/text": { pictures: 0, longest: 9 } }),
    ["/b: 3.1 screens without a picture (home: 2)"]);
  assert.deepEqual(rhythmBreaks({ "/": { pictures: 0, longest: 6 }, "/b": { pictures: 1, longest: 9 } }), [], "a home page without pictures sets no rhythm");
  const browser = await launchBrowser();
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.setContent(page(`<div style="height:900px">text</div><img src="${PIXEL}" style="display:block;width:400px;height:450px"><div style="height:2700px">text</div>`));
    assert.deepEqual(await pictureRhythm(p), { pictures: 1, longest: 3 }, "three screens of text after the only picture");
  } finally {
    await browser.close();
  }
});

const para = "A line of reading text that runs to about the prose width, as a page's paragraphs do. ".repeat(4);
const paras = (n) => Array.from({ length: n }, () => `<p style="margin:0 0 16px">${para}</p>`).join("");

test("a reading column set left with the right empty is lopsided; beside its headline or centred, it is balanced", async () => {
  const browser = await launchBrowser();
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const wrap = (inner) => page(`<section style="padding:64px 48px"><div style="max-width:1184px;margin:0 auto">${inner}</div></section>`);
    await p.setContent(wrap(`<h2 style="font-size:48px;margin:0 0 24px">How we work</h2><div style="max-width:544px">${paras(8)}</div>`));
    const [left] = await balance(p);
    assert.equal(left.ok, false, "text on the left, nothing on the right");
    assert.equal(left.empty, "right");

    await p.setContent(wrap(`<div style="display:grid;grid-template-columns:5fr 7fr;column-gap:64px;align-items:start"><h2 style="position:sticky;top:32px;font-size:48px;margin:0">How we work</h2><div style="max-width:544px">${paras(12)}</div></div>`));
    const [split] = await balance(p);
    assert.equal(split.ok, true, `headline beside the text (share ${split.share})`);

    await p.setContent(wrap(`<h2 style="font-size:48px;margin:0 auto 24px;max-width:544px;text-align:center">How we work</h2><div style="max-width:544px;margin:0 auto">${paras(8)}</div>`));
    assert.equal((await balance(p))[0].ok, true, "a centred column");

    await p.setContent(`<!doctype html><html><body style="margin:0"><main style="padding:64px 48px"><h1 style="font-size:48px;margin:0 0 24px">Website assets</h1><ul style="max-width:544px">${paras(8)}</ul></main></body></html>`);
    const generated = await balance(p);
    assert.equal(generated.length, 1, "a page with no sections is measured as one block");
    assert.equal(generated[0].ok, false);
    assert.equal(generated[0].name, "Website assets");

    // A large photo with a short text beside it: little weight on the text's side, but it runs across its half.
    await p.setContent(wrap(`<div style="display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center"><img src="${PIXEL}" style="width:100%;height:420px"><div><h2 style="margin:0 0 16px">How we work</h2><p>First paragraph, a little longer than a line.</p><p>Second.</p></div></div>`));
    const media = (await balance(p))[0];
    assert.ok(media.share < 0.1, `the photo carries most of the weight (${media.share})`);
    assert.equal(media.ok, true, `a short text beside a photo still fills its side (reach ${media.reach})`);

    await p.setContent(wrap(`<h2 style="margin:0 0 24px">Pictures</h2><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${`<img src="${PIXEL}" style="width:100%;height:300px">`.repeat(3)}</div>`));
    assert.equal((await balance(p))[0].ok, true, "a row of pictures across the page");
  } finally {
    await browser.close();
  }
});

test("a hard crop without a focal point on that axis is listed; a chosen one isn't; the crop sheet draws each", async () => {
  // A 160 x 120 picture in a tall box: only 37.5% of its width shows.
  const png = `data:image/png;base64,${(await sharp({ create: { width: 160, height: 120, channels: 3, background: "#777777" } }).png().toBuffer()).toString("base64")}`;
  const browser = await launchBrowser();
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.setContent(page(`<section><h2>Cards</h2><img src="${png}" style="width:300px;height:600px;object-fit:cover"><img src="${png}" data-focal-x="0.3" style="width:300px;height:600px;object-fit:cover;object-position:30% 50%"><img src="${png}" style="width:400px;height:305px;object-fit:cover"></section>`));
    await p.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
    const found = await crops(p);
    assert.equal(found.length, 2, "the third picture is barely cropped and is left out");
    assert.deepEqual(found[0].needs, ["focalX"]);
    assert.equal(found[0].shows[0], 0.38);
    assert.deepEqual(found[1].needs, [], "focalX was set");
    assert.equal(found[1].focal[0], 0.3);
    const dir = mkdtempSync(join(tmpdir(), "crops-"));
    const file = await cropSheet({ items: found.map((f) => ({ ...f, path: "/" })), file: join(dir, "crop-sheet.png") });
    const meta = await sharp(file).metadata();
    assert.equal(meta.width, 2 * 300 + 16, "two tiles side by side");
  } finally {
    await browser.close();
  }
});

test("the header logo is measured against the tallest button beside it", async () => {
  const browser = await launchBrowser();
  try {
    const p = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await p.setContent(`<!doctype html><html><body><header><nav aria-label="Main"><a href="/"><img src="${PIXEL}" alt="Example Co" style="height:36px;width:156px"></a><a href="/start" style="display:inline-block;height:48px">Start</a></nav></header><main></main></body></html>`);
    assert.deepEqual(await logoFit(p), { logo: 36, tallest: 48, label: "Start" });
  } finally {
    await browser.close();
  }
});
