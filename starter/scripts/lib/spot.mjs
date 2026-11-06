// Spot colour: one object in a black and white photograph tinted in the site's accent, the way hand-coloured prints
// and lantern slides were tinted from the 1840s on (https://en.wikipedia.org/wiki/Hand-colouring_of_photographs,
// checked 2026-11-05). The tint uses the "color" blend mode of W3C Compositing and Blending Level 1
// (https://www.w3.org/TR/compositing-1/#blendingcolor, checked 2026-11-05): the accent's hue and saturation, the
// photograph's own luminosity. Light and shadow, grain and detail stay the photograph's; nothing is drawn in.
// scripts/spot-colour.mjs is the command; this file is the arithmetic, so it can be tested without a model.

// W3C Lum, ClipColor and SetLum, on 0..1 channels.
export const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;
function clipColor(r, g, b) {
  const l = lum(r, g, b), n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0) [r, g, b] = [r, g, b].map((c) => l + ((c - l) * l) / (l - n));
  if (x > 1) [r, g, b] = [r, g, b].map((c) => l + ((c - l) * (1 - l)) / (x - l));
  return [r, g, b];
}
export function setLum(colour, l) {
  const d = l - lum(...colour);
  return clipColor(colour[0] + d, colour[1] + d, colour[2] + d);
}

// The colour blend of one pixel: `base` and `accent` are [r, g, b] in 0..255; `alpha` 0..1 is how much of the tint
// shows (the mask's feathered edge, times the strength).
export function tintPixel(base, accent, alpha) {
  const b = base.map((c) => c / 255);
  const t = setLum(accent.map((c) => c / 255), lum(...b));
  return b.map((c, i) => Math.round(255 * (c + (t[i] - c) * alpha)));
}

// The tone curve that brings an object's middle tone to the accent's own lightness, as a dense dye would: a light
// object is printed down and a dark one lifted, so the colour reads as the accent and not as a pale pink or a near
// black. Its relative light and shade stay: L' = L ^ gamma, gamma = ln(accent lightness) / ln(median), kept within
// 0.6 .. 2.5 so no object is pushed flat. Returns 1 (no change) for an empty mask.
export function toneGamma(rgb, mask, accent) {
  const hist = new Array(256).fill(0);
  let n = 0;
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) if (mask[p] >= 128) { hist[Math.round(255 * lum(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255))]++; n++; }
  if (!n) return 1;
  let seen = 0, median = 0;
  while (median < 255 && (seen += hist[median]) < n / 2) median++;
  const m = Math.min(0.98, Math.max(0.02, median / 255));
  return Math.min(2.5, Math.max(0.6, Math.log(lum(...accent.map((c) => c / 255))) / Math.log(m)));
}

// Tints a raw RGB buffer (width x height x 3) where `mask` (one byte a pixel, 0..255) says so. `gamma` (from
// toneGamma) sets the object's tones first; 1 leaves them as they are.
export function tint(rgb, mask, accent, strength = 1, gamma = 1) {
  const out = Buffer.from(rgb);
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    const a = (mask[p] / 255) * strength;
    if (a <= 0) continue;
    let base = [rgb[i], rgb[i + 1], rgb[i + 2]];
    if (gamma !== 1) {
      const l = lum(...base.map((c) => c / 255)), t = Math.pow(l, gamma);
      base = setLum(base.map((c) => c / 255), t).map((c) => c * 255);
    }
    const [r, g, b] = tintPixel(base, accent, 1);
    // The tone change and the tint fade in together at the outline's soft edge.
    out[i] = Math.round(rgb[i] + (r - rgb[i]) * a); out[i + 1] = Math.round(rgb[i + 1] + (g - rgb[i + 1]) * a); out[i + 2] = Math.round(rgb[i + 2] + (b - rgb[i + 2]) * a);
  }
  return out;
}

// A mask from tone alone, inside an area: the dark (or light) pixels, for lettering on a sign, where an outline model
// would take the whole board. `area` is a box [left, top, right, bottom] or a four-cornered shape [x1, y1, ... x4, y4]
// (for a sign photographed at an angle), in shares of the width and height; `threshold` a lightness 0..1.
export function toneMask(rgb, width, height, area, tone, threshold) {
  const mask = Buffer.alloc(width * height);
  const corners = area.length === 4 ? [[area[0], area[1]], [area[2], area[1]], [area[2], area[3]], [area[0], area[3]]] : [0, 2, 4, 6].map((i) => [area[i], area[i + 1]]);
  const poly = corners.map(([x, y]) => [x * width, y * height]);
  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  const ys = poly.map((p) => p[1]), xs = poly.map((p) => p[0]);
  for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(height, Math.ceil(Math.max(...ys))); y++)
    for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(width, Math.ceil(Math.max(...xs))); x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const i = (y * width + x) * 3;
      const l = lum(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255);
      if (tone === "dark" ? l < threshold : l > threshold) mask[y * width + x] = 255;
    }
  return mask;
}

// The share of the picture a mask covers (0..1), for the preview and to catch a mask that took the whole frame.
export function coverage(mask) {
  let n = 0;
  for (const v of mask) if (v >= 128) n++;
  return n / mask.length;
}

// "x,y" (shares of the width and height, 0..1) → [x, y]; "l,t,r,b" → [l, t, r, b].
export function parseShares(text, count) {
  const v = String(text).split(",").map(Number);
  if (v.length !== count || v.some((n) => !(n >= 0 && n <= 1))) throw new Error(`"${text}" should be ${count} numbers from 0 to 1, separated by commas`);
  return v;
}
