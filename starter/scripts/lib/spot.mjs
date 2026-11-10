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
// With `local` (a radius in pixels), a pixel is measured against the average round it instead: `threshold` is then how
// far it must stand out (0..1), for a thin bright tube or dark lettering on a surface lit unevenly from end to end.
export function toneMask(rgb, width, height, area, tone, threshold, local = 0) {
  const mask = Buffer.alloc(width * height);
  const { inside, x0, y0, x1, y1 } = shape(area, width, height);
  const m = local ? Math.ceil(3 * local) : 0;
  const bx0 = Math.max(0, x0 - m), by0 = Math.max(0, y0 - m), bw = Math.min(width, x1 + m) - bx0, bh = Math.min(height, y1 + m) - by0;
  if (bw <= 0 || bh <= 0) return mask;
  const L = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = ((y + by0) * width + x + bx0) * 3;
      L[y * bw + x] = lum(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255);
    }
  const round = local ? blur(L, bw, bh, local) : null;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      if (!inside(x + 0.5, y + 0.5)) continue;
      const p = (y - by0) * bw + x - bx0, l = L[p], d = round ? (tone === "dark" ? round[p] - l : l - round[p]) : null;
      if (round ? d > threshold : tone === "dark" ? l < threshold : l > threshold) mask[y * width + x] = 255;
    }
  return mask;
}

// A box [left, top, right, bottom] or four corners [x1, y1, ... x4, y4], in shares, as a point-in-shape test in pixels
// and the pixel rows and columns it spans.
function shape(area, width, height) {
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
  return { inside, x0: Math.max(0, Math.floor(Math.min(...xs))), y0: Math.max(0, Math.floor(Math.min(...ys))), x1: Math.min(width, Math.ceil(Math.max(...xs))), y1: Math.min(height, Math.ceil(Math.max(...ys))) };
}

// A separable Gaussian blur of a lightness plane (edges repeated outwards).
function blur(src, w, h, sigma) {
  const r = Math.ceil(3 * sigma), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = v;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = v;
    }
  return out;
}

// Small round light (or dark) spots: the bulbs round a marquee, along a canopy or down a pillar. Each is a peak of a
// difference of Gaussians tuned to the spot's size (a faster stand-in for the Laplacian of Gaussian, with a blob's
// radius the square root of 2 times its scale, as in scikit-image's blob detection: https://scikit-image.org/docs/
// 0.23.x/auto_examples/features_detection/plot_blob.html, checked 2026-11-10), so a lit sign as bright as the bulbs
// round it, being even, gives no peak and bulbs that touch stay apart. Each spot then takes the pixels within its radius of the peak that are at least halfway
// from its surroundings to the peak, so it keeps the bulb's own shape and leaves its glow. `radius` is a spot's radius in pixels, `contrast` how far
// (0..1 lightness) it must stand out, `threshold` the least lightness at its centre (the most, for dark spots). Only
// peaks inside `area` count; lettering and other detail inside it can make spots too, so cut those afterwards.
export function spots(rgb, width, height, area, tone, threshold, radius, contrast = 0.08) {
  const mask = Buffer.alloc(width * height);
  const sigma = radius / Math.SQRT2, reach = Math.ceil(radius);
  const margin = Math.ceil(3 * 1.6 * sigma) + reach;
  const { inside, x0: ax0, y0: ay0, x1: ax1, y1: ay1 } = shape(area, width, height);
  const x0 = Math.max(0, ax0 - margin), y0 = Math.max(0, ay0 - margin), x1 = Math.min(width, ax1 + margin), y1 = Math.min(height, ay1 + margin);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return mask;
  // Lightness, turned over for dark spots so a spot is always a peak.
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((y + y0) * width + x + x0) * 3, l = lum(rgb[i] / 255, rgb[i + 1] / 255, rgb[i + 2] / 255);
      L[y * w + x] = tone === "dark" ? 1 - l : l;
    }
  const near = blur(L, w, h, sigma), wide = blur(L, w, h, 1.6 * sigma);
  const D = near.map((v, i) => v - wide[i]);
  // The largest response within the spot's own width, row by row and then column by column.
  const k = Math.max(1, Math.round(radius)), rows = new Float32Array(w * h), most = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let i = Math.max(0, x - k); i <= Math.min(w - 1, x + k); i++) m = Math.max(m, D[y * w + i]);
      rows[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let i = Math.max(0, y - k); i <= Math.min(h - 1, y + k); i++) m = Math.max(m, rows[i * w + x]);
      most[y * w + x] = m;
    }
  const least = tone === "dark" ? 1 - threshold : threshold;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (D[p] < contrast || D[p] < most[p] || L[p] < least || !inside(x + x0 + 0.5, y + y0 + 0.5)) continue;
      const half = (L[p] + wide[p]) / 2;
      for (let dy = -reach; dy <= reach; dy++)
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = x + dx, yy = y + dy;
          if (dx * dx + dy * dy > reach * reach || xx < 0 || yy < 0 || xx >= w || yy >= h || L[yy * w + xx] < half) continue;
          mask[(yy + y0) * width + xx + x0] = 255;
        }
    }
  return mask;
}

// Fills the small holes inside an outline (a printed logo, a crease the segmenter left out): every unmasked patch that
// doesn't touch the edge of the picture and is no bigger than `share` of the outline. A reel's hub holes or the gap
// between a tripod's legs are bigger than that, so they stay open.
export function fillHoles(mask, width, height, share = 0.01) {
  const out = Buffer.from(mask), seen = new Uint8Array(width * height);
  let area = 0;
  for (const v of mask) if (v >= 128) area++;
  const limit = Math.max(1, area * share);
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || mask[start] >= 128) continue;
    const patch = [start];
    seen[start] = 1;
    let edge = false;
    for (let i = 0; i < patch.length; i++) {
      const p = patch[i], x = p % width, y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edge = true;
      for (const q of [x > 0 && p - 1, x < width - 1 && p + 1, y > 0 && p - width, y < height - 1 && p + width]) {
        if (q === false || seen[q] || mask[q] >= 128) continue;
        seen[q] = 1;
        patch.push(q);
      }
    }
    if (!edge && patch.length <= limit) for (const p of patch) out[p] = 255;
  }
  return out;
}

// Takes away every part of a mask thinner than 2 * radius + 1 pixels and keeps the rest as it was (a morphological
// opening: shrink, then grow back by the same square, https://en.wikipedia.org/wiki/Opening_(morphology), checked
// 2026-11-10): the thin shadow under a sign's edge goes, the lettering stays.
export function open(mask, width, height, radius) {
  const pass = (src, keep, along) => {
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let hit = keep === "all";
        for (let i = -radius; i <= radius; i++) {
          const xx = along ? x + i : x, yy = along ? y : y + i;
          const on = xx >= 0 && yy >= 0 && xx < width && yy < height && src[yy * width + xx] >= 128;
          if (keep === "all" ? !on : on) { hit = !hit; break; }
        }
        out[y * width + x] = hit ? 255 : 0;
      }
    return out;
  };
  const shrunk = pass(pass(mask, "all", true), "all", false);
  return Buffer.from(pass(pass(shrunk, "any", true), "any", false));
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
