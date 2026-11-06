// Spot colour (scripts/lib/spot.mjs, scripts/lib/spot-tool.mjs) and accent words (src/sections/text.js): the
// arithmetic, the masks, the visitor's script and prompt, without the segmentation model.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage, dye, oklab, parseShares, tint, tintPixel, toneGamma, toneMask } from "../lib/spot.mjs";
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
