// Text over images: contrast measured against the picture, not against a colour token.
//
// design-tokens.mjs only checks the colour pairs in DESIGN.md, and axe and Lighthouse didn't flag text laid over
// a photo: a real site's phone poster titles at 1.2:1 passed every other check (2026-11-03). WCAG's failure F83 says how to check it: "the area of the image that is darkest
// (for dark text) or lightest (for light text)" must meet the ratio (w3.org/WAI/WCAG22/Techniques/failures/F83,
// checked 2026-11-03). The ratio is 1.4.3's: 4.5:1, or 3:1 for large text, at least 24 px, or 18.5 px bold
// (w3.org/WAI/WCAG22/Understanding/contrast-minimum.html, checked 2026-11-03).
//
// How it measures, on a page already loaded and scrolled through (lazy images loaded):
// 1. Finds every picture on the page: <img> at least 64 px each way, and every element with a CSS background image
//    or gradient. Video is skipped (its frame changes; untested). Sideways flex strips are unrolled first, so cards
//    that start off screen are measured too.
// 2. Finds every line of text that overlaps one, from the text's own line boxes (Range.getClientRects), skipping
//    text in fixed or sticky elements and visually hidden text.
// 3. Makes all text transparent (shadows too, so a text shadow never counts as background), hides fixed and sticky
//    elements, and takes one full-page screenshot.
// 4. For each element's lines, takes the 99th-percentile lightest pixel behind light text (or the 1st-percentile
//    darkest behind dark text). The percentile keeps a few specks of film grain or JPEG noise from deciding; F83's
//    quick check is the lightest area, which this approximates.

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** WCAG relative luminance of an sRGB colour, channels 0–255. */
export function luminance(r, g, b) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two relative luminances. */
export function contrast(l1, l2) {
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** A computed CSS colour (rgb(), rgba() or color(srgb ...)) as { r, g, b, a }, channels 0–255. Null if unknown. */
export function parseColor(s) {
  const str = String(s || "").trim();
  let m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: alpha(m[4]) };
  m = str.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i);
  if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: alpha(m[4]) };
  return null;
}
const alpha = (v) => (v === undefined ? 1 : v.endsWith("%") ? parseFloat(v) / 100 : +v);

/** Large text in WCAG terms: at least 24 px, or at least 18.5 px and bold (700 or more). */
export function isLarge(px, weight) {
  return px >= 24 || (px >= 18.5 && weight >= 700);
}

/** The ratio a piece of text needs. */
export const required = (px, weight) => (isLarge(px, weight) ? 3 : 4.5);

export const BINS = 2048;

/** Reduces pixels ([r, g, b, r, g, b, ...], 0–255) to what judge() needs: a luminance histogram and the mean colour. */
export function histogram(pixels) {
  const hist = new Array(BINS).fill(0);
  let r = 0, g = 0, b = 0;
  const n = Math.floor(pixels.length / 3);
  for (let i = 0; i < n; i++) {
    const pr = pixels[3 * i], pg = pixels[3 * i + 1], pb = pixels[3 * i + 2];
    hist[Math.min(BINS - 1, Math.floor(luminance(pr, pg, pb) * BINS))]++;
    r += pr; g += pg; b += pb;
  }
  return { hist, n, mean: n ? { r: r / n, g: g / n, b: b / n } : null };
}

const percentile = ({ hist, n }, q) => {
  const target = Math.min(n - 1, Math.floor(n * q));
  for (let i = 0, seen = 0; i < BINS; i++) { seen += hist[i]; if (seen > target) return (i + 0.5) / BINS; }
  return 1;
};

/**
 * Judges one piece of text from the background behind it (a histogram() result) and the text colour { r, g, b, a }.
 * Light text is judged against the lightest 1% of the background, dark text against the darkest 1%.
 * Returns { ratio, light, behind } (behind: that background luminance), or null without pixels.
 */
export function judge(bg, text) {
  if (!bg?.n) return null;
  // Semi-transparent text is blended over the mean background first.
  const a = text.a ?? 1;
  const t = a >= 1 ? text : { r: a * text.r + (1 - a) * bg.mean.r, g: a * text.g + (1 - a) * bg.mean.g, b: a * text.b + (1 - a) * bg.mean.b };
  const tl = luminance(t.r, t.g, t.b);
  const light = tl >= percentile(bg, 0.5);
  const behind = light ? percentile(bg, 0.99) : percentile(bg, 0.01);
  return { ratio: contrast(tl, behind), light, behind };
}

// Runs in the page (Playwright page.evaluate): the text over pictures, as boxes in page coordinates.
function collectInPage() {
  const sx = window.scrollX, sy = window.scrollY;
  const pinned = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const pictures = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.tagName === "VIDEO") continue;
    const cs = getComputedStyle(el);
    const isImg = el.tagName === "IMG" && el.complete && el.naturalWidth > 0;
    const hasBg = cs.backgroundImage && cs.backgroundImage !== "none";
    if (!isImg && !hasBg) continue;
    if (cs.visibility === "hidden" || +cs.opacity === 0 || pinned(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 64 || r.height < 64) continue;
    pictures.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });
  }
  const overlaps = (a) => pictures.some((p) => a.x < p.x + p.w && a.x + a.w > p.x && a.y < p.y + p.h && a.y + a.h > p.y);
  const groups = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const el = node.parentElement;
    if (!el || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName) || pinned(el)) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()].filter((r) => r.width >= 4 && r.height >= 4)
      .map((r) => ({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height })).filter(overlaps);
    if (!rects.length) continue;
    const cs = getComputedStyle(el);
    if (!groups.has(el)) groups.set(el, { text: "", color: cs.color, px: parseFloat(cs.fontSize), weight: +cs.fontWeight || 400, rects: [] });
    const g = groups.get(el);
    g.text = (g.text + " " + node.textContent.trim()).trim();
    g.rects.push(...rects);
  }
  return [...groups.values()].map((g) => ({ ...g, text: g.text.slice(0, 60) }));
}

// Runs in a blank page: decodes the screenshot and reduces the pixels behind each piece of text to a histogram()
// (the same function as above, repeated here because this one runs in the browser; a unit test keeps them equal).
async function histogramsInPage({ png, boxes, bins }) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  return boxes.map((rects) => {
    const hist = new Array(bins).fill(0);
    let r = 0, g = 0, b = 0, n = 0;
    for (const box of rects) {
      const x = Math.max(0, Math.floor(box.x)), y = Math.max(0, Math.floor(box.y));
      const w = Math.min(bmp.width - x, Math.ceil(box.w)), h = Math.min(bmp.height - y, Math.ceil(box.h));
      if (w <= 0 || h <= 0) continue;
      const d = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
        hist[Math.min(bins - 1, Math.floor(l * bins))]++;
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    }
    return { hist, n, mean: n ? { r: r / n, g: g / n, b: b / n } : null };
  });
}
export const _histogramsInPage = histogramsInPage; // for the unit test

/**
 * Measures every piece of text over a picture on `page` (Playwright), using `scratch` (a blank Playwright page) to
 * read the screenshot. Leaves the page with its text transparent: run it last on a page.
 * Returns [{ text, px, weight, ratio, needs, ok }], worst first.
 */
export async function measureImageText(page, scratch) {
  await page.evaluate(() => document.fonts.ready);
  // A sideways strip (flex row that scrolls) keeps most of its cards off screen. Unroll it into wrapped rows of the
  // same card width, so every card is on the page and measured as it looks when swiped to. Grid strips stay as they
  // are (only their visible part is measured).
  await page.evaluate(() => {
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1 && cs.display.includes("flex")) {
        for (const [k, v] of [["flex-wrap", "wrap"], ["overflow", "visible"], ["scroll-snap-type", "none"]]) el.style.setProperty(k, v, "important");
      }
    }
  });
  const items = await page.evaluate(collectInPage);
  if (!items.length) return [];
  await page.addStyleTag({ content: "*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }" });
  await page.evaluate(() => { for (const el of document.querySelectorAll("body *")) { const p = getComputedStyle(el).position; if (p === "fixed" || p === "sticky") el.style.setProperty("visibility", "hidden", "important"); } });
  await page.waitForTimeout(100);
  const png = (await page.screenshot({ fullPage: true, animations: "disabled" })).toString("base64");
  const bgs = await scratch.evaluate(histogramsInPage, { png, boxes: items.map((i) => i.rects), bins: BINS });
  const rows = [];
  items.forEach((item, i) => {
    const color = parseColor(item.color);
    if (!color || color.a === 0) return;
    const j = judge(bgs[i], color);
    if (!j) return;
    const needs = required(item.px, item.weight);
    rows.push({ text: item.text, px: Math.round(item.px), weight: item.weight, ratio: Math.round(j.ratio * 100) / 100, needs, ok: j.ratio >= needs });
  });
  return rows.sort((a, b) => a.ratio / a.needs - b.ratio / b.needs);
}
