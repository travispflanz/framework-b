// Library of Congress record handling, scan-border cropping and the image library (scripts/images.mjs).
// No network: LoC records are fixtures; the library runs in a temporary site folder.
//   node --test scripts/test/archive-library.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { candidate, isFree, locId, pickFile, rightsOf } from "../lib/loc.mjs";
import { scanBorders } from "../lib/scan-borders.mjs";

test("only records with no known restrictions are used", () => {
  assert.equal(isFree("No known restrictions on publication."), true);
  assert.equal(isFree(["No known restrictions. For information, see U.S. Farm Security Administration"]), true);
  assert.equal(isFree("Rights status not evaluated. For general information see ..."), false);
  assert.equal(isFree(""), false);
  assert.equal(rightsOf({ item: { rights_advisory: ["No known restrictions on publication."] } }), "No known restrictions on publication.");
  assert.equal(locId("http://www.loc.gov/item/2014706018/"), "2014706018");
  assert.equal(locId("loc:2014706018"), "2014706018");
});

test("the master scan is chosen over the small JPEG copies", () => {
  const resources = [{ files: [[
    { mimetype: "image/tiff", width: 0, height: 0, url: "https://tile.loc.gov/storage-services/master/pnp/x/00100/00101u.tif" },
    { mimetype: "image/jpeg", width: 150, height: 110, url: "https://tile.loc.gov/storage-services/service/pnp/x/00100/00101_150px.jpg" },
    { mimetype: "image/jpeg", width: 1024, height: 749, url: "https://tile.loc.gov/storage-services/service/pnp/x/00100/00101v.jpg" },
  ]] }];
  assert.equal(pickFile(resources).master, true);
  assert.match(pickFile(resources).url, /u\.tif$/);
  const jpegOnly = [{ files: [[resources[0].files[0][1], resources[0].files[0][2]]] }];
  assert.equal(pickFile(jpegOnly).width, 1024);
  assert.equal(pickFile([]), null);
  assert.equal(candidate({ id: "http://www.loc.gov/item/1/", title: "T", image_url: ["https://x/1_150px.jpg#h=1&w=1", "https://x/1r.jpg"], rights_advisory: "No known restrictions on publication." }).id, "loc:1");
  assert.equal(candidate({ id: "http://www.loc.gov/item/2/", image_url: ["https://x/2.jpg"], rights_advisory: "Rights status not evaluated." }), null);
});

test("a scan's mat and black frame are found and cut, with a safety margin", () => {
  // 400 × 300: a 20 px white mat, a 6 px black frame, then a noisy mid-grey picture.
  const w = 400, h = 300, g = new Uint8Array(w * h);
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
    g[y * w + x] = edge < 20 ? 250 : edge < 26 ? 8 : Math.round(60 + rnd() * 120);
  }
  const b = scanBorders(g, w, h);
  for (const [k, size] of [["left", w], ["right", w], ["top", h], ["bottom", h]]) {
    assert.ok(b[k] >= 26, `${k} cuts the whole border (${b[k]})`);
    assert.ok(b[k] <= 26 + Math.round(size * 0.025) + 1, `${k} keeps the picture (${b[k]})`);
  }
  // A scan with no border keeps everything but the margin.
  const plain = Uint8Array.from({ length: w * h }, () => Math.round(60 + rnd() * 120));
  assert.equal(scanBorders(plain, w, h).left, Math.round(w * 0.025));
});

test("the library keeps a photo and its credit off the pages, and brings it back", async () => {
  const site = mkdtempSync(join(tmpdir(), "library-"));
  const script = resolve("scripts/images.mjs");
  mkdirSync(join(site, "src/assets/images"), { recursive: true });
  mkdirSync(join(site, "src/content"), { recursive: true });
  mkdirSync(join(site, "design"), { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#777" } }).jpeg().toFile(join(site, "src/assets/images/old-hero.jpg"));
  await sharp({ create: { width: 64, height: 48, channels: 3, background: "#333" } }).jpeg().toFile(join(site, "src/assets/images/in-use.jpg"));
  writeFileSync(join(site, "design/credits.json"), JSON.stringify({ images: [
    { file: "src/assets/images/old-hero.jpg", source: "stock", creator: "Someone", license: "No known restrictions on publication", url: "https://example.com/1", alt: "An old hero", for: "Home hero" },
    { file: "src/assets/images/in-use.jpg", source: "owner", alt: "In use" },
  ] }));
  writeFileSync(join(site, "src/content/home.json"), JSON.stringify({ sections: [{ _type: "fb_hero", image: { src: "in-use.jpg", alt: "In use" } }] }));
  const run = (...args) => execFileSync("node", [script, ...args], { cwd: site, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run("shelve", "old-hero.jpg");
  assert.ok(existsSync(join(site, "design/library/old-hero.jpg")));
  assert.ok(!existsSync(join(site, "src/assets/images/old-hero.jpg")));
  const shelf = JSON.parse(readFileSync(join(site, "design/library/credits.json"), "utf8")).images;
  assert.equal(shelf[0].file, "design/library/old-hero.jpg");
  assert.equal(shelf[0].for, "Home hero");
  assert.equal(JSON.parse(readFileSync(join(site, "design/credits.json"), "utf8")).images.length, 1);
  assert.throws(() => run("shelve", "in-use.jpg"), /still used/);
  assert.match(run("library"), /1 in the library/);
  assert.ok(existsSync(join(site, "design/library/sheet.png")));
  run("unshelve", "old-hero.jpg");
  assert.ok(existsSync(join(site, "src/assets/images/old-hero.jpg")));
  assert.equal(JSON.parse(readFileSync(join(site, "design/credits.json"), "utf8")).images.length, 2);
});
