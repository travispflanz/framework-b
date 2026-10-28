// The imagery treatment from DESIGN.md (`imagery.treatment` and `imagery.grain`, generated into
// src/styles/design.json), applied with sharp to every stock or generated image so a site's pictures read as one set.
//   none     unchanged
//   duotone  greyscale mapped from a dark accent (ink mixed with accent: shadows) to the highlight colour (lights)
//   tint     20% of the accent colour laid over the photo
//   warm     a little more red, a little less blue
//   cool     a little less red, a little more blue
//   mono     greyscale
//   grain    (on top of any of these) fine monochrome film grain, the same on every image of a run
import { existsSync, readFileSync } from "node:fs";
import sharp from "sharp";

export function readImagery(dir = ".") {
  const path = `${dir}/src/styles/design.json`;
  const imagery = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).imagery || {} : {};
  return { style: "owner-photo", treatment: "none", grain: false, prompt: "", ...imagery };
}

export function readPalette(dir = ".") {
  const css = readFileSync(`${dir}/src/styles/tokens.css`, "utf8");
  const colour = (name) => {
    const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
    if (!m) throw new Error(`tokens.css has no --color-${name}; run node scripts/design-tokens.mjs`);
    return [1, 3, 5].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  return { ink: colour("ink"), accent: colour("accent"), highlight: colour("highlight"), bg: colour("bg") };
}

// A seeded generator so the grain is reproducible (tests compare outputs).
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Returns { buffer (JPEG), changes (a sentence for the credit, "" when nothing changed) }.
export async function applyTreatment(input, { treatment = "none", grain = false, palette } = {}) {
  if (treatment === "none" && !grain) return { buffer: input, changes: "" };
  const { data, info } = await sharp(input).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  const ch = info.channels;
  const random = rng(0x5eed);
  const lerp = (a, b, t) => a + (b - a) * t;
  for (let i = 0; i < px.length; i += ch) {
    let r = px[i], g = px[i + 1], b = px[i + 2];
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (treatment === "mono") r = g = b = y * 255;
    else if (treatment === "duotone") {
      const d = palette.ink.map((v, c) => lerp(v, palette.accent[c], 0.5));
      const l = palette.highlight;
      [r, g, b] = [0, 1, 2].map((c) => lerp(d[c], l[c], y));
    } else if (treatment === "tint") [r, g, b] = [r, g, b].map((v, c) => lerp(v, palette.accent[c], 0.2));
    else if (treatment === "warm") [r, g, b] = [r * 1.06 + 4, g * 1.01, b * 0.9];
    else if (treatment === "cool") [r, g, b] = [r * 0.92, g * 1.0, b * 1.06 + 4];
    if (grain) {
      // Box-Muller: gaussian noise, sigma 7 of 255, the same offset on all three channels (monochrome grain).
      const n = Math.sqrt(-2 * Math.log(random() || 1e-9)) * Math.cos(2 * Math.PI * random()) * 7;
      r += n; g += n; b += n;
    }
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
  const buffer = await sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: info }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const what = { duotone: "duotone in the site's colours", tint: "tinted with the site's accent colour", warm: "warmed", cool: "cooled", mono: "converted to black and white" }[treatment];
  const changes = [what, grain ? "film grain added" : ""].filter(Boolean).join(", ");
  return { buffer, changes: changes.charAt(0).toUpperCase() + changes.slice(1) + "." };
}
