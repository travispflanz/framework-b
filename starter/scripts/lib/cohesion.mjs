// One design language across the site (docs/SPEC.md section 12, "One design language"): the checks the QA gate runs
// on every built page, and the site sheet a person reviews.
//
// - titleStyle: the page title's treatment (face, weight, case, alignment). Every page's <h1> must match the home
//   page's; size may differ (the home page is allowed to be louder).
// - bareBanners: a photo at least 60% of the window wide and 30% of its height tall with no text over it and none
//   beside it: a bare banner, which the owner of the first adopted site ruled out ("a large plain image taking up
//   full width space on the screen is not a modern design", 2026-11-04). Measured at desktop width only: on a phone
//   every picture is full width and text sits above and below it.
// - siteSheet: the first screen of every page side by side, from the QA gate's own screenshots.
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

export async function titleStyle(page) {
  return page.evaluate(() => {
    const h = document.querySelector("h1");
    if (!h) return null;
    const cs = getComputedStyle(h);
    const align = cs.textAlign === "start" ? (cs.direction === "rtl" ? "right" : "left") : cs.textAlign === "end" ? (cs.direction === "rtl" ? "left" : "right") : cs.textAlign;
    return { face: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim(), weight: cs.fontWeight, case: cs.textTransform === "none" ? "as written" : cs.textTransform, align };
  });
}

// Pages whose title treatment differs from the home page's, with what differs.
export function titleMismatches(styles, home = "/") {
  const ref = styles[home];
  if (!ref) return [];
  return Object.entries(styles).filter(([p, s]) => p !== home && s).flatMap(([p, s]) => {
    const diff = ["face", "weight", "case", "align"].filter((k) => s[k] !== ref[k]);
    return diff.length ? [`${p}: ${diff.map((k) => `${k} ${s[k]} (home: ${ref[k]})`).join(", ")}`] : [];
  });
}

export async function bareBanners(page) {
  return page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const shown = (el) => { const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.opacity !== "0" && !el.closest('[aria-hidden="true"]'); };
    const texts = [];
    const walker = document.createTreeWalker(document.querySelector("main") || document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.textContent.trim().length < 2 || !n.parentElement || !shown(n.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.width > 1 && r.height > 1) texts.push({ top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right });
    }
    return [...document.querySelectorAll("main img, main video")].filter(shown).flatMap((img) => {
      const b = img.getBoundingClientRect();
      if (b.width < W * 0.6 || b.height < H * 0.3) return [];
      const box = { top: b.top + scrollY, bottom: b.bottom + scrollY, left: b.left, right: b.right };
      const vOverlap = (t) => Math.min(t.bottom, box.bottom) - Math.max(t.top, box.top) > (t.bottom - t.top) * 0.3;
      const over = texts.some((t) => vOverlap(t) && t.right > box.left && t.left < box.right);
      const beside = texts.some((t) => vOverlap(t) && (t.right <= box.left || t.left >= box.right));
      if (over || beside) return [];
      const src = (img.currentSrc || img.src || "").split("/").pop().split("?")[0].replace(/_[A-Za-z0-9-]+\.(webp|avif|jpe?g|png)$/, "");
      return [`${src || img.tagName.toLowerCase()} ${Math.round(b.width)}×${Math.round(b.height)}`];
    });
  });
}

// The first screen of each page from the QA screenshots (<out>/<name>-<width>.png), labelled, in one image.
export async function siteSheet({ out, pages, width, screen, file, columns = width > 700 ? 3 : 6 }) {
  const tileW = width > 700 ? 640 : 300;
  const tileH = Math.round((screen * tileW) / width);
  const label = 34;
  const tiles = [];
  for (const path of pages) {
    const name = (path.slice(1) || "home").replace(/\//g, "_");
    let shot;
    try { shot = readFileSync(`${out}/${name}-${width}.png`); } catch { continue; }
    const meta = await sharp(shot).metadata();
    const top = await sharp(shot).extract({ left: 0, top: 0, width: meta.width, height: Math.min(meta.height, screen) }).resize({ width: tileW, height: tileH, fit: "cover", position: "top" }).png().toBuffer();
    const text = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${label}"><rect width="100%" height="100%" fill="#ffffff"/><text x="4" y="23" font-family="sans-serif" font-size="18" fill="#111111">${path.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`;
    tiles.push({ top, text: Buffer.from(text) });
  }
  if (!tiles.length) return null;
  const gap = 16;
  const rows = Math.ceil(tiles.length / columns);
  const sheetW = columns * tileW + (columns - 1) * gap;
  const sheetH = rows * (tileH + label) + (rows - 1) * gap;
  const composite = tiles.flatMap((t, i) => {
    const x = (i % columns) * (tileW + gap), y = Math.floor(i / columns) * (tileH + label + gap);
    return [{ input: t.text, left: x, top: y }, { input: t.top, left: x, top: y + label }];
  });
  writeFileSync(file, await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: "#ffffff" } }).composite(composite).png().toBuffer());
  return file;
}
