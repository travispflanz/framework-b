// One design language across the site (docs/SPEC.md section 12, "One design language"): the checks the QA gate runs
// on every built page, and the site sheet a person reviews.
//
// - titleStyle: the page title's treatment (face, weight, case, alignment). Every page's <h1> must match the home
//   page's; size may differ (the home page is allowed to be louder).
// - bareBanners: a photo at least 60% of the window wide and 30% of its height tall with no text over it and none
//   beside it: a bare banner, which the owner of the first adopted site ruled out ("a large plain image taking up
//   full width space on the screen is not a modern design", 2026-11-04). Measured at desktop width only: on a phone
//   every picture is full width and text sits above and below it.
// - pictureRhythm: the longest stretch of a page without a picture, in screens. The home page sets the rhythm: no
//   other page with pictures may run more than half a screen longer without one than the home page does.
// - balance: every section's visual weight on both sides of the centre of the window, in windows of a screen down
//   the section. NN/g: "Balance occurs when there is an equally distributed (but not necessarily symmetrical) amount
//   of visual signal on both sides of an imaginary axis going through the middle of the screen" (5 Principles of
//   Visual Design, https://www.nngroup.com/articles/principles-visual-design, checked 2026-11-05). A reading column
//   set left with the right of the page empty fails it; the owner of the first adopted site called those sections
//   "floating off to the left with a ton of open space to the right" (2026-11-05). The fix is a layout, not wider
//   text (lines stay at the prose width): the headline beside the text (split), a centred column, or pictures beside.
//   Weight is the area of text lines, pictures, form fields and filled boxes; a sticky column counts wherever its row
//   runs, since it stays in view beside it. Measured at desktop width: on a phone everything is one column.
// - crops: every picture a layout crops (object-fit: cover), with how much of it shows and where. A crop that cuts a
//   third or more off a picture's width or height must name its focal point on that axis (focalX, focalY): the
//   centre is not a choice, and on the first adopted site it cut the heads off a hero photo (2026-11-05). cropSheet
//   draws each crop over the whole picture for a person to review.
// - logoFit: the header logo is at least as tall as the tallest button beside it or in the phone bar ("it's not even
//   as tall as the filmmaker and backer buttons", the same owner, 2026-11-05).
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

export async function pictureRhythm(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return { pictures: 0, longest: 0 };
    const H = innerHeight;
    const box = main.getBoundingClientRect();
    const top = box.top + scrollY, bottom = box.bottom + scrollY;
    const pics = [...main.querySelectorAll("img, video")].map((e) => e.getBoundingClientRect()).filter((b) => b.width >= 120 && b.height >= 120)
      .map((b) => [b.top + scrollY, b.bottom + scrollY]).sort((a, b) => a[0] - b[0]);
    let cursor = top, gap = 0;
    for (const [a, b] of pics) { gap = Math.max(gap, a - cursor); cursor = Math.max(cursor, b); }
    gap = Math.max(gap, bottom - cursor);
    return { pictures: pics.length, longest: Math.round((gap / H) * 10) / 10 };
  });
}

// Pages that run longer without a picture than the home page does (plus half a screen). Pages with no pictures at all
// (text pages) and a home page without pictures are left out.
export function rhythmBreaks(rhythm, home = "/") {
  const ref = rhythm[home];
  if (!ref || !ref.pictures) return [];
  const limit = Math.max(ref.longest, 1) + 0.5;
  return Object.entries(rhythm).filter(([p, r]) => p !== home && r && r.pictures && r.longest > limit).map(([p, r]) => `${p}: ${r.longest} screens without a picture (home: ${ref.longest})`);
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

// ---------- Balance ----------
// window: the height looked at together (a little under a 900 px screen); share: the least weight either side may
// carry; fill: windows with less weight than this share of their area (a spacer, the end of a band) are skipped.
export const BALANCE = { window: 800, step: 200, share: 0.1, fill: 0.03 };

export async function balance(page, opts = BALANCE) {
  return page.evaluate(({ window: WIN, step, share: least, fill }) => {
    const W = document.documentElement.clientWidth, axis = W / 2;
    const seen = (el) => { for (let e = el; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.visibility === "hidden" || cs.opacity === "0") return false; } return true; };
    const sections = [...document.querySelectorAll("main section")].filter((el) => !el.parentElement.closest("section"));
    const out = [];
    for (const sec of sections) {
      const sb = sec.getBoundingClientRect();
      const top0 = sb.top + scrollY, bottom0 = sb.bottom + scrollY, height = bottom0 - top0;
      if (height < 40) continue;
      const bg = getComputedStyle(sec).backgroundColor;
      const marks = [];
      const stickyRow = (el) => {
        for (let e = el; e && e !== sec; e = e.parentElement) if (getComputedStyle(e).position === "sticky") { const p = e.parentElement.getBoundingClientRect(); return [p.top + scrollY, p.bottom + scrollY]; }
        return null;
      };
      const add = (r, el) => {
        if (r.width < 2 || r.height < 2) return;
        marks.push({ top: r.top + scrollY, bottom: r.bottom + scrollY, left: Math.max(0, r.left), right: Math.min(W, r.right), row: stickyRow(el) });
      };
      const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim() || !n.parentElement || !seen(n.parentElement)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) add(r, n.parentElement);
      }
      for (const el of sec.querySelectorAll("*")) {
        if (!el.getClientRects().length || !seen(el)) continue;
        const tag = el.tagName.toLowerCase();
        const cs = getComputedStyle(el);
        const media = ["img", "video", "canvas", "picture"].includes(tag) || (tag === "svg" && el.getBoundingClientRect().width >= 48);
        const field = ["input", "textarea", "select", "button"].includes(tag) && cs.display !== "none";
        const filled = (cs.backgroundColor !== bg && !/rgba\(.*,\s*0\)$|transparent/.test(cs.backgroundColor)) || /url\(/.test(cs.backgroundImage);
        if (media || field || filled) add(el.getBoundingClientRect(), el);
      }
      const starts = height <= WIN ? [top0] : [...Array(Math.ceil((height - WIN) / step)).keys()].map((i) => top0 + i * step).concat(bottom0 - WIN);
      let worst = null;
      for (const y0 of starts) {
        const y1 = y0 + Math.min(WIN, height);
        let L = 0, R = 0;
        for (const m of marks) {
          let h;
          if (m.row) {
            const ov = Math.min(m.row[1], y1) - Math.max(m.row[0], y0);
            if (ov <= 0) continue;
            h = Math.min(m.bottom - m.top, ov);
          } else {
            h = Math.min(m.bottom, y1) - Math.max(m.top, y0);
            if (h <= 0) continue;
          }
          L += h * Math.max(0, Math.min(m.right, axis) - m.left);
          R += h * Math.max(0, m.right - Math.max(m.left, axis));
        }
        const total = L + R;
        if (total < W * (y1 - y0) * fill) continue;
        const s = Math.min(L, R) / total;
        if (!worst || s < worst.share) worst = { share: Math.round(s * 100) / 100, empty: L < R ? "left" : "right", at: Math.round(y0 - top0) };
      }
      if (!worst) continue;
      const name = sec.querySelector("h1, h2")?.textContent.trim().replace(/\s+/g, " ").slice(0, 48) || sec.id || "a section";
      out.push({ name, ...worst, ok: worst.share >= least });
    }
    return out;
  }, opts);
}

// ---------- Crops ----------
// cut: the share of a picture's width or height a crop may remove about the centre without naming a focal point.
export const CROP_CUT = 1 / 3;

export async function crops(page, { thumb = 200, cut = CROP_CUT } = {}) {
  return page.evaluate(({ thumb, cut }) => {
    const pos = (v, box, content) => {
      if (v.endsWith("%")) return parseFloat(v) / 100;
      const room = box - content;
      return room === 0 ? 0.5 : parseFloat(v) / room;
    };
    const out = [];
    for (const img of document.querySelectorAll("main img")) {
      const cs = getComputedStyle(img);
      const b = img.getBoundingClientRect();
      if (cs.objectFit !== "cover" || b.width < 64 || b.height < 64 || !img.naturalWidth || !img.getClientRects().length) continue;
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const scale = Math.max(b.width / nw, b.height / nh);
      const vw = Math.min(1, b.width / scale / nw), vh = Math.min(1, b.height / scale / nh);
      if (vw > 0.97 && vh > 0.97) continue;
      const [ox = "50%", oy = "50%"] = cs.objectPosition.split(/\s+/);
      const fx = Math.min(1, Math.max(0, pos(ox, b.width, nw * scale))), fy = Math.min(1, Math.max(0, pos(oy, b.height, nh * scale)));
      const set = { x: img.dataset.focalX !== undefined, y: img.dataset.focalY !== undefined };
      const needs = [vw < 1 - cut && !set.x ? "focalX" : null, vh < 1 - cut && !set.y ? "focalY" : null].filter(Boolean);
      const src = (img.currentSrc || img.src || "").split("/").pop().split("?")[0].split(".")[0];
      const section = img.closest("section")?.querySelector("h1, h2")?.textContent.trim().replace(/\s+/g, " ").slice(0, 40) || "";
      let data = null;
      try {
        const c = document.createElement("canvas");
        c.height = thumb;
        c.width = Math.round((thumb * nw) / nh);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        data = c.toDataURL("image/jpeg", 0.82);
      } catch { /* a picture from another origin can't be drawn; the sheet leaves it out */ }
      out.push({ src, section, box: [Math.round(b.width), Math.round(b.height)], shows: [Math.round(vw * 100) / 100, Math.round(vh * 100) / 100],
        window: [(1 - vw) * fx, (1 - vh) * fy, vw, vh], focal: [Math.round(fx * 100) / 100, Math.round(fy * 100) / 100], set, needs, data });
    }
    return out;
  }, { thumb, cut });
}

// Each crop drawn over its whole picture: the part that shows is outlined, the rest dimmed. One sheet per width.
export async function cropSheet({ items, file, columns = 4 }) {
  const tiles = items.filter((i) => i.data);
  if (!tiles.length) return null;
  const tileW = 300, picH = 200, label = 54, gap = 16;
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const made = [];
  for (const it of tiles) {
    const pic = await sharp(Buffer.from(it.data.split(",")[1], "base64")).resize({ width: tileW, height: picH, fit: "contain", background: "#ffffff" }).png().toBuffer();
    const meta = await sharp(Buffer.from(it.data.split(",")[1], "base64")).metadata();
    const s = Math.min(tileW / meta.width, picH / meta.height);
    const w = meta.width * s, h = meta.height * s, x0 = (tileW - w) / 2, y0 = (picH - h) / 2;
    const [wx, wy, ww, wh] = it.window;
    const r = { x: x0 + wx * w, y: y0 + wy * h, w: ww * w, h: wh * h };
    const bad = it.needs.length > 0;
    const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${picH + label}">
      <path fill="#000000" fill-opacity="0.6" fill-rule="evenodd" d="M${x0} ${y0}h${w}v${h}h${-w}z M${r.x} ${r.y}v${r.h}h${r.w}v${-r.h}z"/>
      <rect x="${r.x + 1}" y="${r.y + 1}" width="${Math.max(0, r.w - 2)}" height="${Math.max(0, r.h - 2)}" fill="none" stroke="${bad ? "#e11d48" : "#16a34a"}" stroke-width="3"/>
      <rect y="${picH}" width="${tileW}" height="${label}" fill="#ffffff"/>
      <text x="4" y="${picH + 20}" font-family="sans-serif" font-size="14" fill="#111111">${esc(`${it.path} · ${it.src}`.slice(0, 44))}</text>
      <text x="4" y="${picH + 42}" font-family="sans-serif" font-size="13" fill="${bad ? "#b91c1c" : "#444444"}">${esc(`shows ${Math.round(it.shows[0] * 100)}% × ${Math.round(it.shows[1] * 100)}% · focal ${it.focal.join(", ")}${bad ? ` · set ${it.needs.join(", ")}` : ""}`)}</text>
    </svg>`;
    made.push(await sharp({ create: { width: tileW, height: picH + label, channels: 3, background: "#ffffff" } })
      .composite([{ input: pic, left: 0, top: 0 }, { input: Buffer.from(overlay), left: 0, top: 0 }]).png().toBuffer());
  }
  const rows = Math.ceil(made.length / columns), cols = Math.min(columns, made.length);
  const W = cols * tileW + (cols - 1) * gap, H = rows * (picH + label) + (rows - 1) * gap;
  writeFileSync(file, await sharp({ create: { width: W, height: H, channels: 3, background: "#ffffff" } })
    .composite(made.map((input, i) => ({ input, left: (i % columns) * (tileW + gap), top: Math.floor(i / columns) * (picH + label + gap) }))).png().toBuffer());
  return file;
}

// ---------- Logo size ----------
// The header logo's height against the tallest link or button in the header and in the phone action bar.
export async function logoFit(page) {
  return page.evaluate(() => {
    const logo = document.querySelector('header a[href="/"] img');
    if (!logo || !logo.getClientRects().length) return null;
    const actions = [...document.querySelectorAll('header nav[aria-label="Main"] a, body > div.fixed.bottom-0 a')]
      .filter((a) => a.getClientRects().length && getComputedStyle(a).visibility !== "hidden" && !a.querySelector("img"));
    const tallest = actions.reduce((m, a) => { const h = a.getBoundingClientRect().height; return h > m.h ? { h, label: a.textContent.trim() } : m; }, { h: 0, label: "" });
    return { logo: Math.round(logo.getBoundingClientRect().height), tallest: Math.round(tallest.h), label: tallest.label };
  });
}
