// Spot colour (scripts/lib/spot.mjs, scripts/lib/spot-tool.mjs) and accent words (src/sections/text.js): the
// arithmetic, the masks, the repeat crop, the visitor's script and prompt, without the segmentation model.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { coverage, dye, fillHoles, oklab, open, parseShares, spots, tint, tintPixel, toneGamma, toneMask } from "../lib/spot.mjs";
import { promptText, standaloneScript } from "../lib/spot-tool.mjs";
import { accent, inline, plain } from "../../src/sections/text.js";

const RED = [240, 52, 60];
const lightness = (rgb) => oklab(rgb)[0];

test("the dye takes the accent's hue and keeps the photograph's lightness, inside the screen's colours", () => {
  for (const g of [20, 40, 90, 128, 200, 245]) {
    const out = tintPixel([g, g, g], RED, 1);
    assert.ok(Math.abs(lightness(out) - lightness([g, g, g])) < 0.01, `grey ${g} kept its lightness (${lightness(out).toFixed(3)} for ${lightness([g, g, g]).toFixed(3)})`);
    assert.ok(out[0] > out[1] && out[0] > out[2], `grey ${g} became red: ${out}`);
    assert.ok(out.every((c) => c >= 0 && c <= 255));
  }
  assert.deepEqual(tintPixel([128, 128, 128], RED, 0), [128, 128, 128], "no tint where the mask is empty");
  const [, a1, b1] = oklab(dye(0.3, RED)), [, a2, b2] = oklab(RED);
  assert.ok(Math.abs(Math.atan2(b1, a1) - Math.atan2(b2, a2)) < 0.05, "a dark dye keeps the accent's hue");
  assert.ok(Math.hypot(a1, b1) < Math.hypot(a2, b2), "and gives up chroma to stay in sRGB");
  const folds = [60, 75].map((g) => lightness(tintPixel([g, g, g], RED, 1)));
  assert.ok(folds[1] - folds[0] > 0.03, "a fold in a dark cloth stays visible once dyed");
});

test("tint changes only the masked pixels, and the tone curve moves a pale object halfway to the accent", () => {
  const W = 4, rgb = Buffer.alloc(W * 3, 230), mask = Buffer.from([255, 255, 0, 0]);
  const gamma = toneGamma(rgb, mask, RED);
  assert.ok(gamma > 1, "a pale object is printed down");
  const out = tint(rgb, mask, RED, 1, gamma);
  assert.deepEqual([...out.subarray(6)], [230, 230, 230, 230, 230, 230], "unmasked pixels unchanged");
  const was = lightness([230, 230, 230]), want = was + (lightness(RED) - was) / 2, now = lightness([...out.subarray(0, 3)]);
  assert.ok(Math.abs(now - want) < 0.02, `printed down halfway towards the accent's lightness (${now.toFixed(3)}, wanted ${want.toFixed(3)})`);
  assert.ok(out[0] > out[1] + 40, "and reads red");
  const dark = Buffer.alloc(W * 3, 50);
  assert.ok(toneGamma(dark, mask, RED) < 1, "a dark object is lifted");
  assert.equal(toneGamma(rgb, Buffer.alloc(W), RED), 1, "an empty mask leaves tones alone");
});

test("a tone mask takes the dark pixels inside a four-cornered shape only", () => {
  const W = 10, H = 10, rgb = Buffer.alloc(W * H * 3, 240);
  for (const [x, y] of [[2, 2], [5, 5], [9, 9]]) rgb.fill(10, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const mask = toneMask(rgb, W, H, [0, 0, 0.7, 0, 0.7, 0.7, 0, 0.7], "dark", 0.4);
  assert.equal(mask[2 * W + 2], 255);
  assert.equal(mask[5 * W + 5], 255);
  assert.equal(mask[9 * W + 9], 0, "outside the shape");
  assert.equal(coverage(mask), 0.02);
  assert.deepEqual(parseShares("0.1,0.2", 2), [0.1, 0.2]);
  assert.throws(() => parseShares("1.2,0.3", 2), /0 to 1/);
});

test("holes inside an outline fill; a big gap or one open to the edge stays", () => {
  const W = 20, H = 20, mask = Buffer.alloc(W * H);
  for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) mask[y * W + x] = 255;
  mask[5 * W + 5] = 0; // a speck of a hole: a printed logo
  for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) mask[y * W + x] = 0; // a gap a quarter the size of the outline
  const out = fillHoles(mask, W, H);
  assert.equal(out[5 * W + 5], 255, "the small hole is filled");
  assert.equal(out[10 * W + 10], 0, "the big gap stays open");
  assert.equal(out[0], 0, "outside stays outside");
});

test("round spots are found beside a flat panel as bright as they are, and touching spots stay apart", () => {
  const W = 60, H = 30, rgb = Buffer.alloc(W * H * 3, 20);
  const paint = (x0, y0, x1, y1, v) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgb.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3); };
  paint(30, 0, 60, 30, 235); // a lit sign, even
  for (const cx of [5, 14, 23]) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - cx) ** 2 + (y - 15) ** 2 <= 9) rgb.fill(250, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const mask = spots(rgb, W, H, [0, 0, 1, 1], "light", 0.6, 3);
  for (const cx of [5, 14, 23]) assert.equal(mask[15 * W + cx], 255, `the bulb at ${cx} is found`);
  assert.equal(mask[15 * W + 45], 0, "the middle of the even sign is not a spot");
  assert.equal(mask[15 * W + 9], 0, "the gap between two bulbs stays out");
  assert.equal(mask[2 * W + 5], 0, "a spot keeps to its own size");
});

test("opening drops a thin line and keeps a thick shape whole", () => {
  const W = 30, H = 20, mask = Buffer.alloc(W * H);
  for (let x = 0; x < W; x++) mask[3 * W + x] = 255; // the sliver of shadow under a sign's edge, one pixel high
  for (let y = 8; y < 18; y++) for (let x = 5; x < 15; x++) mask[y * W + x] = 255; // a letter
  const out = open(mask, W, H, 2);
  assert.equal(out[3 * W + 10], 0, "the line is gone");
  for (const [x, y] of [[5, 8], [14, 17], [10, 12]]) assert.equal(out[y * W + x], 255, `the letter keeps ${x},${y}`);
});

test("a local tone mask follows a thin bright tube across a ceiling lit unevenly", () => {
  const W = 60, H = 20, rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = Math.round(120 + x * 2) + (y === 10 ? 30 : 0); // a ceiling growing lighter to the right, and a tube along it
    rgb.fill(Math.min(255, v), (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  const plainMask = toneMask(rgb, W, H, [0, 0, 1, 1], "light", 0.75);
  assert.equal(plainMask[10 * W + 5], 0, "a fixed lightness misses the tube at the dim end");
  assert.equal(plainMask[5 * W + 55], 255, "and takes the ceiling at the bright end");
  const local = toneMask(rgb, W, H, [0, 0, 1, 1], "light", 0.05, 3);
  for (const x of [5, 30, 55]) assert.equal(local[10 * W + x], 255, `the tube at ${x}`);
  for (const x of [5, 30, 55]) assert.equal(local[5 * W + x], 0, `not the ceiling at ${x}`);
});

test("a photo cropped twice is cut once from its uncropped copy, and its credit records the whole cut", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crop-"));
  mkdirSync(join(dir, "src/assets/images"), { recursive: true });
  mkdirSync(join(dir, "design"), { recursive: true });
  await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(join(dir, "src/assets/images/team.jpg"));
  writeFileSync(join(dir, "design/credits.json"), JSON.stringify({ images: [{ file: "src/assets/images/team.jpg", source: "owner", alt: "The team" }] }));
  const crop = (cut) => execFileSync(process.execPath, [new URL("../images.mjs", import.meta.url).pathname, "crop", "team.jpg", "--cut", cut], { cwd: dir, stdio: "pipe" });
  crop("0.1,0,0.1,0");
  crop("0,0,0.25,0");
  const meta = await sharp(join(dir, "src/assets/images/team.jpg")).metadata();
  assert.deepEqual([meta.width, meta.height], [120, 100], "160 wide after the first cut, then a quarter of that off the right");
  const entry = JSON.parse(readFileSync(join(dir, "design/credits.json"), "utf8")).images[0];
  assert.deepEqual(entry.cropped, [0.1, 0, 0.3, 0]);
  assert.equal(entry.changes, "Cropped.", "said once");
  assert.equal((await sharp(join(dir, "design/image-candidates/team-uncropped.jpg")).metadata()).width, 200, "the uncropped copy is the original");
});

test("the visitor's script carries the same arithmetic and parses, and the prompt says how", () => {
  const script = standaloneScript({ site: "Example Co", url: "https://example.com/credits", colour: "#f0343c", transformers: "4.3.1", sharpVersion: "0.34.5" });
  assert.match(script, /npm install sharp@0\.34\.5 @huggingface\/transformers@4\.3\.1/);
  assert.match(script, /function tintPixel/);
  assert.doesNotMatch(script, /^export /m, "the library's exports are inlined");
  const dir = mkdtempSync(join(tmpdir(), "spot-"));
  writeFileSync(join(dir, "spot-colour.mjs"), script);
  execFileSync(process.execPath, ["--check", join(dir, "spot-colour.mjs")]);
  const prompt = promptText({ site: "Example Co", url: "https://example.com/credits", colour: "#f0343c", brief: "One red thing in each photo." });
  for (const want of ["One red thing in each photo.", "**one** object", "Never a face", "#f0343c", "OKLab", "https://example.com/tools/spot-colour.mjs", "which model"]) assert.ok(prompt.includes(want), `the prompt says ${want}`);
});

test("==accent== words: in headlines and text, escaped, and gone from plain text", () => {
  assert.equal(accent("Two doors. ==One form== each. <b>"), 'Two doors. <span class="accent-word">One form</span> each. &lt;b&gt;');
  assert.equal(inline("a ==b== **c**"), 'a <span class="accent-word">b</span> <strong>c</strong>');
  assert.equal(plain("Seen from ==two sides=="), "Seen from two sides");
  assert.equal(accent("no == here"), "no == here", "a lone == stays as typed");
});
