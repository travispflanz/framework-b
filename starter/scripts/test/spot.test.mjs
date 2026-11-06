// Spot colour (scripts/lib/spot.mjs, scripts/lib/spot-tool.mjs) and accent words (src/sections/text.js): the
// arithmetic, the masks, the visitor's script and prompt, without the segmentation model.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverage, lum, parseShares, setLum, tint, tintPixel, toneGamma, toneMask } from "../lib/spot.mjs";
import { promptText, standaloneScript } from "../lib/spot-tool.mjs";
import { accent, inline, plain } from "../../src/sections/text.js";

const RED = [240, 52, 60];
const lightness = (rgb) => lum(...rgb.map((c) => c / 255));

test("the colour blend takes the accent's hue and keeps the photograph's lightness", () => {
  for (const g of [40, 90, 128, 200]) {
    const out = tintPixel([g, g, g], RED, 1);
    assert.ok(Math.abs(lightness(out) - g / 255) < 0.01, `grey ${g} kept its lightness (${lightness(out).toFixed(3)})`);
    assert.ok(out[0] > out[1] && out[0] > out[2], `grey ${g} became red: ${out}`);
  }
  assert.deepEqual(tintPixel([128, 128, 128], RED, 0), [128, 128, 128], "no tint where the mask is empty");
  const clipped = setLum([0.94, 0.2, 0.24], 0.95);
  assert.ok(clipped.every((c) => c >= 0 && c <= 1), "setLum keeps channels in range");
});

test("tint changes only the masked pixels, and the tone curve prints a pale object down towards the accent", () => {
  const W = 4, rgb = Buffer.alloc(W * 3, 230), mask = Buffer.from([255, 255, 0, 0]);
  const gamma = toneGamma(rgb, mask, RED);
  assert.ok(gamma > 1, "a pale object is printed down");
  const out = tint(rgb, mask, RED, 1, gamma);
  assert.deepEqual([...out.subarray(6)], [230, 230, 230, 230, 230, 230], "unmasked pixels unchanged");
  const now = lightness([...out.subarray(0, 3)]);
  assert.ok(now < 230 / 255 - 0.1 && Math.abs(now - lightness(RED)) < Math.abs(230 / 255 - lightness(RED)), `the pale object is printed down towards the accent's lightness (${now.toFixed(2)})`);
  assert.ok(out[0] > out[1] + 60, "and reads red");
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
  for (const want of ["One red thing in each photo.", "**one** object", "Never a face", "#f0343c", "https://example.com/tools/spot-colour.mjs", "which model"]) assert.ok(prompt.includes(want), `the prompt says ${want}`);
});

test("==accent== words: in headlines and text, escaped, and gone from plain text", () => {
  assert.equal(accent("Two doors. ==One form== each. <b>"), 'Two doors. <span class="accent-word">One form</span> each. &lt;b&gt;');
  assert.equal(inline("a ==b== **c**"), 'a <span class="accent-word">b</span> <strong>c</strong>');
  assert.equal(plain("Seen from ==two sides=="), "Seen from two sides");
  assert.equal(accent("no == here"), "no == here", "a lone == stays as typed");
});
