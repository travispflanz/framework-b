#!/usr/bin/env node
// Brand kit (design phase, before the drafts): a real logo for every site, drawn from the site's own display font
// and colours, never a stock logo and never anything that imitates another brand.
//
//   node scripts/brand-kit.mjs options [--icon <phosphor-name>] [--initials AB]
//       renders six logo layouts into design/brand/options/ (option-1.svg ... option-6.svg) and a contact sheet,
//       design/brand/options.png, to look at (or send to the owner) before choosing
//   node scripts/brand-kit.mjs pick <1-6>
//       installs the chosen layout: public/logo.svg, public/favicon.svg, public/apple-touch-icon.png,
//       public/icon-192.png, public/icon-512.png and public/og.png (the share image), sets site.config.json
//       site.logo, and credits every file in design/credits.json as source "brand"
//
// The name is set in the display font from DESIGN.md and converted to outlines with opentype.js (MIT), so the logo
// never depends on a web font loading. The mark is either the initials (a monogram) or a filled symbol from
// Phosphor Icons (MIT, @phosphor-icons/core). Fonts and icons are fetched into node_modules/.cache/brand-kit, never
// added to package.json. Using OFL fonts in a logo is allowed (OFL FAQ 1.1). The owner checks the name and mark
// in the USPTO trademark search before launch and records it in HANDOFF.md.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import opentype from "opentype.js";
import sharp from "sharp";
import { parse } from "yaml";

const [cmd, arg] = process.argv.slice(2);
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (!["options", "pick"].includes(cmd)) {
  console.error("usage: node scripts/brand-kit.mjs options [--icon <phosphor-name>] [--initials AB]  |  pick <1-6>");
  process.exit(2);
}

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const design = parse(readFileSync("DESIGN.md", "utf8").match(/^---\n([\s\S]*?)\n---\n/)[1]);
const C = design.colors;
const name = site.site.name;
const DIR = "design/brand";
const CACHE = resolve("node_modules/.cache/brand-kit");

// Fetch a package into the cache (a package.json there stops npm pruning earlier ones).
function cached(pkg) {
  const dir = join(CACHE, "node_modules", pkg);
  if (existsSync(dir)) return dir;
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(join(CACHE, "package.json"))) writeFileSync(join(CACHE, "package.json"), '{ "private": true }\n');
  execFileSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", "--prefix", CACHE, pkg], { stdio: ["ignore", "ignore", "inherit"] });
  if (!existsSync(dir)) throw new Error(`could not fetch ${pkg}`);
  return dir;
}

// The display font at the design's weight, as a static Fontsource WOFF (opentype.js reads WOFF, not WOFF2).
function loadFont(token) {
  const family = token.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (/^(system-ui|ui-|sans-serif|serif)/.test(family)) throw new Error(`The display font is "${family}"; the brand kit needs a named font from DESIGN.md (a Fontsource family)`);
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const files = join(cached(`@fontsource/${slug}`), "files");
  const want = Number(token.fontWeight || 700);
  const weights = [want, 700, 800, 600, 900, 500, 400];
  for (const w of weights) {
    const f = join(files, `${slug}-latin-${w}-normal.woff`);
    if (existsSync(f)) {
      const buf = readFileSync(f);
      return { font: opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), family, weight: w };
    }
  }
  throw new Error(`No Latin WOFF file for ${family} in @fontsource/${slug}`);
}

const display = loadFont(design.typography.display);
const body = (() => {
  try {
    return loadFont({ ...design.typography.body, fontWeight: design.typography.body.fontWeight || 400 });
  } catch {
    return display;
  }
})();

// Glyphs are laid out here, one character at a time with kerning, instead of through opentype.js's text shaping:
// its shaper stops on some fonts' contextual-substitution tables, and a logo needs no ligatures.
// Path data from opentype.js commands, formatted here (its own toPathData printed NaN for some coordinates).
const n2 = (v) => Number(v.toFixed(2));
function pathData(commands) {
  return commands.map((c) =>
    c.type === "M" || c.type === "L" ? `${c.type}${n2(c.x)} ${n2(c.y)}`
    : c.type === "Q" ? `Q${n2(c.x1)} ${n2(c.y1)} ${n2(c.x)} ${n2(c.y)}`
    : c.type === "C" ? `C${n2(c.x1)} ${n2(c.y1)} ${n2(c.x2)} ${n2(c.y2)} ${n2(c.x)} ${n2(c.y)}`
    : "Z").join("");
}

function textPath(f, text, size, x = 0, y = 0, tracking = 0) {
  const scale = size / f.unitsPerEm;
  const glyphs = [...text].map((ch) => f.charToGlyph(ch));
  let cx = x;
  const parts = [];
  glyphs.forEach((g, i) => {
    parts.push(pathData(g.getPath(cx, y, size).commands));
    cx += (g.advanceWidth || 0) * scale + tracking;
    if (i < glyphs.length - 1) cx += (Number(f.getKerningValue(g, glyphs[i + 1])) || 0) * scale;
  });
  return { d: parts.join(" "), width: cx - x - tracking, ascent: (f.ascender / f.unitsPerEm) * size };
}

const initials = (flag("initials") || name.split(/[\s&+-]+/).filter((w) => /^[A-Za-z0-9]/.test(w)).map((w) => w[0]).join("").slice(0, 2)).toUpperCase();
const iconName = flag("icon");
let iconSvg = null;
if (iconName) {
  const file = join(cached("@phosphor-icons/core"), "assets", "fill", `${iconName}-fill.svg`);
  if (!existsSync(file)) throw new Error(`No Phosphor icon "${iconName}" (see https://phosphoricons.com; use the name, e.g. "film-slate")`);
  iconSvg = readFileSync(file, "utf8").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""); // 256 x 256 viewBox
}

// The mark: a rounded square in the accent colour holding the initials or the symbol, size s at (x, y).
function mark(x, y, s, { round = 0.22, fg = C["accent-ink"], bg = C.accent } = {}) {
  const inner = iconSvg
    ? `<g transform="translate(${x + s * 0.2} ${y + s * 0.2}) scale(${(s * 0.6) / 256})" fill="${fg}">${iconSvg.replace(/fill="[^"]*"/g, "")}</g>`
    : (() => {
        const size = s * (initials.length > 1 ? 0.46 : 0.6);
        const t = textPath(display.font, initials, size);
        const ox = x + (s - t.width) / 2;
        const cap = (display.font.tables.os2?.sCapHeight || display.font.unitsPerEm * 0.7) / display.font.unitsPerEm * size;
        const oy = y + s / 2 + cap / 2;
        return `<path fill="${fg}" d="${textPath(display.font, initials, size, ox, oy).d}"/>`;
      })();
  return `<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s * round}" fill="${bg}"/>${inner}`;
}

const svg = (w, h, inner, bg) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" width="${Math.round(w)}" height="${Math.round(h)}" role="img" aria-label="${name.replace(/"/g, "&quot;")}">${bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ""}${inner}</svg>`;

// Six layouts. Heights are in the logo's own units; the header shows it 36 px tall.
function layouts() {
  const S = 100; // name size
  const word = textPath(display.font, name, S, 0, S * 0.8);
  const capH = S * 0.72;
  const out = [];
  // 1. Wordmark.
  out.push({ label: "Wordmark", svg: svg(word.width + 8, S * 1.05, `<path fill="${C.ink}" d="${textPath(display.font, name, S, 4, S * 0.8).d}"/>`) });
  // 2. Mark + wordmark.
  {
    const m = S * 1.0;
    const w2 = textPath(display.font, name, S * 0.82, m + S * 0.28, m * 0.5 + capH * 0.82 * 0.5);
    out.push({ label: "Mark and name", svg: svg(m + S * 0.28 + w2.width + 6, m, `${mark(0, 0, m)}<path fill="${C.ink}" d="${w2.d}"/>`) });
  }
  // 3. Stacked.
  {
    const m = S * 1.4;
    const w3 = textPath(display.font, name, S * 0.6, 0, 0);
    const W = Math.max(m, w3.width) + 8;
    const t = textPath(display.font, name, S * 0.6, (W - w3.width) / 2, m + S * 0.72);
    out.push({ label: "Stacked", svg: svg(W, m + S * 0.86, `${mark((W - m) / 2, 0, m)}<path fill="${C.ink}" d="${t.d}"/>`) });
  }
  // 4. Badge: the name reversed out of an accent pill.
  {
    const w4 = textPath(display.font, name, S * 0.7, S * 0.45, S * 0.5 + capH * 0.7 * 0.5);
    const W = w4.width + S * 0.9;
    out.push({ label: "Badge", svg: svg(W, S, `<rect width="${W}" height="${S}" rx="${S / 2}" fill="${C.accent}"/><path fill="${C["accent-ink"]}" d="${w4.d}"/>`) });
  }
  // 5. Monogram (also the favicon).
  out.push({ label: "Monogram", svg: svg(S * 1.6, S * 1.6, mark(0, 0, S * 1.6, { round: 0.5 })) });
  // 6. Wordmark with an accent rule, tracked out.
  {
    const w6 = textPath(display.font, name.toUpperCase(), S * 0.62, 0, S * 0.62, S * 0.06);
    out.push({ label: "Tracked with rule", svg: svg(w6.width + 4, S * 0.92, `<path fill="${C.ink}" d="${w6.d}"/><rect x="0" y="${S * 0.78}" width="${S * 0.9}" height="${S * 0.1}" fill="${C.accent}"/>`) });
  }
  return out;
}

if (cmd === "options") {
  mkdirSync(join(DIR, "options"), { recursive: true });
  const opts = layouts();
  const tiles = [];
  for (const [i, o] of opts.entries()) {
    writeFileSync(join(DIR, "options", `option-${i + 1}.svg`), o.svg);
    const png = await sharp(Buffer.from(o.svg)).resize({ height: 120, width: 520, fit: "inside" }).png().toBuffer();
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="40"><text x="20" y="28" font-family="sans-serif" font-size="20" fill="#444">${i + 1}. ${o.label}</text></svg>`);
    tiles.push({ png, label });
  }
  const W = 1200, H = 3 * 220;
  const comps = [];
  tiles.forEach((t, i) => {
    const x = (i % 2) * 600, y = Math.floor(i / 2) * 220;
    comps.push({ input: t.label, left: x, top: y }, { input: t.png, left: x + 40, top: y + 60 });
  });
  await sharp({ create: { width: W, height: H, channels: 3, background: C.bg } }).composite(comps).png().toFile(join(DIR, "options.png"));
  writeFileSync(join(DIR, "options.json"), JSON.stringify({ name, initials, icon: iconName || null, font: `${display.family} ${display.weight}`, options: opts.map((o) => o.label) }, null, 2) + "\n");
  console.log(`Six logo layouts in ${DIR}/options/ and a contact sheet at ${DIR}/options.png. Look at them, then: node scripts/brand-kit.mjs pick <1-6>`);
}

if (cmd === "pick") {
  const n = Number(arg);
  const file = join(DIR, "options", `option-${n}.svg`);
  if (!existsSync(file)) throw new Error(`Run "node scripts/brand-kit.mjs options" first (no ${file})`);
  const chosen = readFileSync(file, "utf8");
  const opts = layouts();
  const monogram = opts[4].svg;
  writeFileSync("public/logo.svg", chosen);
  writeFileSync("public/favicon.svg", monogram);
  await sharp(Buffer.from(svg(160, 160, mark(0, 0, 160, { round: 0 })))).resize(180, 180).png().toFile("public/apple-touch-icon.png");
  for (const s of [192, 512]) await sharp(Buffer.from(svg(160, 160, mark(0, 0, 160, { round: 0 })))).resize(s, s).png().toFile(`public/icon-${s}.png`);
  writeFileSync("public/manifest.webmanifest", JSON.stringify({
    name, short_name: name.length > 12 ? initials : name, start_url: "/", display: "standalone",
    background_color: C.bg, theme_color: C.accent,
    icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
  }, null, 2) + "\n");
  // Share image: the logo and the tagline on the page colour.
  const logoPng = await sharp(Buffer.from(chosen)).resize({ width: 900, height: 260, fit: "inside" }).png().toBuffer();
  const meta = await sharp(logoPng).metadata();
  const tagline = site.site.tagline || "";
  // The tagline wraps onto at most two centred lines of 1040 px; a longer one ends in an ellipsis.
  const lines = [];
  if (tagline) {
    let line = "";
    for (const word of tagline.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && textPath(body.font, next, 40).width > 1040) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > 2) {
      let second = lines[1];
      while (second && textPath(body.font, `${second}…`, 40).width > 1040) second = second.replace(/\s*\S+$/, "");
      lines.splice(1, lines.length - 1, `${second}…`);
    }
  }
  const tagWidth = Math.max(0, ...lines.map((l) => textPath(body.font, l, 40).width));
  const tagSvg = lines.length ? Buffer.from(svg(Math.ceil(tagWidth) + 4, lines.length * 56, lines.map((l, i) => {
    const t = textPath(body.font, l, 40);
    return `<path fill="${C["ink-muted"]}" d="${textPath(body.font, l, 40, 2 + (tagWidth - t.width) / 2, 44 + i * 56).d}"/>`;
  }).join(""))) : null;
  const tagPng = tagSvg ? await sharp(tagSvg).png().toBuffer() : null;
  const tagMeta = tagPng ? await sharp(tagPng).metadata() : { width: 0, height: 0 };
  const top = Math.round((630 - meta.height - (tagPng ? tagMeta.height + 40 : 0)) / 2);
  const comps = [{ input: logoPng, left: Math.round((1200 - meta.width) / 2), top }];
  if (tagPng) comps.push({ input: tagPng, left: Math.round((1200 - tagMeta.width) / 2), top: top + meta.height + 40 });
  comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="12"><rect width="1200" height="12" fill="${C.accent}"/></svg>`), left: 0, top: 618 });
  await sharp({ create: { width: 1200, height: 630, channels: 3, background: C.bg } }).composite(comps).png().toFile("public/og.png");

  site.site.logo = "/logo.svg";
  writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");
  const credits = JSON.parse(readFileSync("design/credits.json", "utf8"));
  const files = ["public/logo.svg", "public/favicon.svg", "public/apple-touch-icon.png", "public/icon-192.png", "public/icon-512.png", "public/og.png"];
  credits.images = credits.images.filter((c) => !files.includes(c.file));
  for (const f of files) credits.images.push({ file: f, source: "brand", alt: f.endsWith("og.png") ? `${name}: ${tagline}` : f.endsWith("logo.svg") ? name : "", note: `Made by scripts/brand-kit.mjs from ${display.family} ${display.weight} (OFL)${iconName ? ` and the Phosphor "${iconName}" icon (MIT)` : ""}` });
  writeFileSync("design/credits.json", JSON.stringify(credits, null, 2) + "\n");
  console.log(`Installed option ${n} as the logo; favicon, app icons and share image written; site.logo set. Check the name in the USPTO trademark search before launch.`);
}
