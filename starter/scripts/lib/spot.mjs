// Spot colour: one object in a black and white photograph tinted in the site's accent, the way hand-coloured prints
// and lantern slides were tinted from the 1840s on (https://en.wikipedia.org/wiki/Hand-colouring_of_photographs,
// checked 2026-11-05). The tint works in OKLab, a perceptual colour space: every pixel keeps the photograph's own
// lightness and takes the accent's hue and chroma, so light and shadow, folds, grain and detail stay the
// photograph's and nothing is drawn in. (The W3C "color" blend, tried first, keeps Rec. 601 luma instead: a saturated
// red carries little of it, so a dark object came out as a flat bright red with its folds lost; 2026-11-06.)
// scripts/spot-colour.mjs is the command; this file is the arithmetic, so it can be tested without a model.

// Rec. 601 luma on 0..1 channels: the lightness the tone masks threshold on.
export const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

// sRGB <-> OKLab. Coefficients from Björn Ottosson's definition (https://bottosson.github.io/posts/oklab/), as in
// the oklab crate (https://docs.rs/crate/oklab/latest/source/src/lib.rs, checked 2026-11-06).
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export function oklab(rgb) {
  const [r, g, b] = rgb.map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function linearRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = (c) => c.every((v) => v >= -1e-5 && v <= 1 + 1e-5);

// The dye: the accent's hue at lightness L (0..1), in sRGB 0..255. Where the accent's chroma doesn't fit sRGB at that
// lightness (deep shadow, near white), the chroma is reduced by binary search while lightness and hue are held, as in
// CSS Color 4 gamut mapping (https://drafts.csswg.org/css-color-4/#gamut-mapping, checked 2026-11-06; without its
// final clip, which isn't needed when the search ends inside the gamut).
export function dye(L, accent) {
  const [, a, b] = oklab(accent);
  const C = Math.hypot(a, b), h = Math.atan2(b, a);
  const at = (c) => linearRgb([L, c * Math.cos(h), c * Math.sin(h)]);
  let lo = 0, hi = C;
  if (inGamut(at(C))) lo = C;
  else for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (inGamut(at(mid))) lo = mid; else hi = mid; }
  return at(lo).map((v) => Math.round(255 * toSrgb(Math.min(1, Math.max(0, v)))));
}

// One pixel: `base` and `accent` are [r, g, b] in 0..255; `alpha` 0..1 is how much of the dye shows (the mask's
// feathered edge, times the strength).
export function tintPixel(base, accent, alpha) {
  const t = dye(oklab(base)[0], accent);
  return base.map((c, i) => Math.round(c + (t[i] - c) * alpha));
}

// The tone curve that moves an object's middle tone part of the way to the accent's own lightness (`lift`, 0..1;
// half by default), as a dense dye would: a light object is printed down and a dark one lifted, so the colour reads
// as the accent and not as a pale pink or a near black, while it keeps its own light and shade. L' = L ^ gamma on
// OKLab lightness, gamma = ln(target) / ln(median), kept within 0.4 .. 4. Returns 1 (no change) for an empty mask.
export function toneGamma(rgb, mask, accent, lift = 0.5) {
  const hist = new Array(1024).fill(0);
  let n = 0;
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) if (mask[p] >= 128) { hist[Math.min(1023, Math.round(1023 * oklab([rgb[i], rgb[i + 1], rgb[i + 2]])[0]))]++; n++; }
  if (!n) return 1;
  let seen = 0, median = 0;
  while (median < 1023 && (seen += hist[median]) < n / 2) median++;
  const m = Math.min(0.98, Math.max(0.02, median / 1023));
  const target = m + (oklab(accent)[0] - m) * lift;
  return Math.min(4, Math.max(0.4, Math.log(target) / Math.log(m)));
}

// Tints a raw RGB buffer (width x height x 3) where `mask` (one byte a pixel, 0..255) says so. `gamma` (from
// toneGamma) sets the object's tones first; 1 leaves them as they are.
export function tint(rgb, mask, accent, strength = 1, gamma = 1) {
  const out = Buffer.from(rgb);
  const dyes = new Map();
  for (let p = 0, i = 0; p < mask.length; p++, i += 3) {
    const a = (mask[p] / 255) * strength;
    if (a <= 0) continue;
    const L = Math.round(4095 * Math.pow(oklab([rgb[i], rgb[i + 1], rgb[i + 2]])[0], gamma));
    if (!dyes.has(L)) dyes.set(L, dye(L / 4095, accent));
    const t = dyes.get(L);
    // The tone change and the dye fade in together at the outline's soft edge.
    for (let k = 0; k < 3; k++) out[i + k] = Math.round(rgb[i + k] + (t[k] - rgb[i + k]) * a);
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
