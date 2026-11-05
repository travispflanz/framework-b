#!/usr/bin/env node
// Logo (docs/SPEC.md section 12, "Logo"; docs/BUILD.md step 3): a brief, concepts the agent draws from the brand's own
// world, a sheet that tests every concept the way the logo will be used, and the whole kit from the one picked.
//
//   node scripts/logo.mjs brief                  writes design/brand/brief.md to fill in (kept if it exists), from
//                                                the site's design research (design/research.md: the business, the
//                                                field, current design and the site's own look)
//   node scripts/logo.mjs measure "<words>" [--font display|body] [--family <Fontsource family>] [--weight 800]
//                                               [--size 100] [--tracking 0.05]
//                                                width, capital height and ascent of words in a font, for drawing
//   node scripts/logo.mjs templates [--initials AB] [--icon <Phosphor name>]
//                                                six quick concepts from the display font (t1 ... t6), for a site
//                                                without the time or need for a designed logo
//   node scripts/logo.mjs check                  the brief and every concept against the rules (scripts/lib/logo.mjs)
//   node scripts/logo.mjs sheet [<id> ...]       builds every concept in design/brand/concepts/ (or only the ids
//                                                given, leaving the others' sheets alone) and draws its test
//                                                sheet: header, phone header, dark and light paper, one colour
//                                                black and white, on a photo, the mark at 16/32/48 px, a browser tab,
//                                                a circle avatar, the maskable app icon and a business card.
//                                                design/brand/sheet.png (all concepts), sheets/<id>.png (each) and
//                                                concepts.pdf (all of them, a page each, to send the owner).
//   node scripts/logo.mjs pick <id>              installs the kit (below), sets site.logo and credits every file
//
// The kit: public/logo.svg (the version for the site's page colour), logo-on-dark.svg, logo-on-light.svg,
// logo-black.svg, logo-white.svg, mark.svg, favicon.svg, favicon-96.png, apple-touch-icon.png, icon-192.png,
// icon-512.png, icon-maskable-512.png, og.png and manifest.webmanifest; design/brand/kit/ for print and social (each
// version as a vector PDF and a 2000 px PNG, avatar.png); design/brand/logo.json (the versions, colours, clear space
// and minimum sizes, which the style guide shows).
//
// Words are set in the design's fonts and converted to outlines with opentype.js (MIT), so the logo never depends on
// a web font. Fonts are fetched from Fontsource into node_modules/.cache/brand-kit, never into package.json; a
// family="" font must be OFL, Apache or MIT (using OFL fonts in a logo is allowed: OFL FAQ 1.1). Before launch the
// owner searches the name and the mark in the USPTO trademark database and records it in HANDOFF.md.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import opentype from "opentype.js";
import sharp from "sharp";
import { parse } from "yaml";
import { launchBrowser } from "./lib/local-site.mjs";
import { FILE as RESEARCH, unwrittenLenses } from "./lib/design-research.mjs";
import {
  SHEET_SIZES, VARIANT_NAMES, boxOf, briefProblems, briefTemplate, escapeXml, expandSymbol, lintConcept,
  paint, parseConcept, ratio, squareBox, svgFile, usage, variantPalettes,
} from "./lib/logo.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i > 0 ? args[i + 1] : undefined; };
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
const USAGE = 'usage: node scripts/logo.mjs brief | measure "<words>" [--font display|body] | templates [--initials AB] [--icon <name>] | check | sheet [<id> ...] | pick <id>';
if (!["brief", "measure", "templates", "check", "sheet", "pick"].includes(cmd)) { console.error(USAGE); process.exit(2); }

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const design = parse(readFileSync("DESIGN.md", "utf8").match(/^---\n([\s\S]*?)\n---\n/)[1]);
const C = design.colors;
const name = site.site.name;
const DIR = "design/brand";
const CONCEPTS = join(DIR, "concepts");
const CACHE = resolve("node_modules/.cache/brand-kit");

// ---------- fonts ----------

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

const FREE = /^(OFL-1\.1|Apache-2\.0|MIT)$/;
const fonts = new Map();
// A static Fontsource WOFF (opentype.js reads WOFF, not WOFF2) at the nearest weight there is.
function loadFamily(family, weight = 700) {
  const key = `${family}|${weight}`;
  if (fonts.has(key)) return fonts.get(key);
  if (/^(system-ui|ui-|sans-serif|serif|monospace)/.test(family)) throw new Error(`The font is "${family}"; a logo needs a named font (a Fontsource family in DESIGN.md, or family="...")`);
  const slug = family.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const pkg = cached(`@fontsource/${slug}`);
  const license = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).license || "";
  if (!FREE.test(license)) throw new Error(`${family} is licensed "${license}"; a logo uses an OFL, Apache or MIT font`);
  const files = join(pkg, "files");
  const have = readdirSync(files).map((f) => f.match(new RegExp(`^${slug}-latin-(\\d+)-normal\\.woff$`))?.[1]).filter(Boolean).map(Number);
  if (!have.length) throw new Error(`No Latin WOFF files for ${family} in @fontsource/${slug}`);
  const w = have.sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)[0];
  const buf = readFileSync(join(files, `${slug}-latin-${w}-normal.woff`));
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const result = { font, family, weight: w, license };
  fonts.set(key, result);
  return result;
}
const familyOf = (token) => String(token?.fontFamily || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
const fontFor = ({ font = "display", family, weight } = {}) => {
  const token = font === "body" ? design.typography.body : design.typography.display;
  return loadFamily(family || familyOf(token), Number(weight) || Number(token?.fontWeight) || (font === "body" ? 400 : 700));
};
const used = new Set();

// Glyphs are laid out one at a time with kerning, not through opentype.js's shaper: it stops on some fonts'
// contextual tables, and a logo needs no ligatures. Path data is formatted here (its toPathData printed NaN).
const n2 = (v) => Number(v.toFixed(2));
const pathData = (commands) => commands.map((c) =>
  c.type === "M" || c.type === "L" ? `${c.type}${n2(c.x)} ${n2(c.y)}`
  : c.type === "Q" ? `Q${n2(c.x1)} ${n2(c.y1)} ${n2(c.x)} ${n2(c.y)}`
  : c.type === "C" ? `C${n2(c.x1)} ${n2(c.y1)} ${n2(c.x2)} ${n2(c.y2)} ${n2(c.x)} ${n2(c.y)}`
  : "Z").join("");

function layout(f, words, size, tracking = 0) {
  const scale = size / f.unitsPerEm;
  const glyphs = [...words].map((ch) => f.charToGlyph(ch));
  const xs = [];
  let cx = 0;
  glyphs.forEach((g, i) => {
    xs.push(cx);
    cx += (g.advanceWidth || 0) * scale + tracking * size;
    if (i < glyphs.length - 1) cx += (Number(f.getKerningValue(g, glyphs[i + 1])) || 0) * scale;
  });
  const capHeight = ((f.tables.os2?.sCapHeight || f.charToGlyph("H").getBoundingBox().y2) / f.unitsPerEm) * size;
  return { glyphs, xs, unitsPerEm: f.unitsPerEm, width: cx - tracking * size, capHeight, ascent: (f.ascender / f.unitsPerEm) * size, descent: (-f.descender / f.unitsPerEm) * size };
}

// An <fb-text>'s attributes and words -> outlines.
function setText(attrs, words) {
  const ff = fontFor(attrs);
  used.add(`${ff.family} ${ff.weight} (${ff.license})`);
  const size = Number(attrs.size);
  const l = layout(ff.font, words, size, Number(attrs.tracking) || 0);
  const x0 = Number(attrs.x) || 0;
  const x = attrs.anchor === "middle" ? x0 - l.width / 2 : attrs.anchor === "end" ? x0 - l.width : x0;
  const y = attrs["center-y"] !== undefined ? Number(attrs["center-y"]) + l.capHeight / 2 : Number(attrs.y) || 0;
  if (attrs.arc) return { d: arcText(l, size, attrs), width: l.width, capHeight: l.capHeight };
  const d = l.glyphs.map((g, i) => pathData(g.getPath(x + l.xs[i], y, size).commands)).join(" ");
  return { d, width: l.width, capHeight: l.capHeight };
}

// Words along a circle, for seals and badges: arc="top" reads clockwise over the top with the letters' feet on the
// circle of radius r (centre cx, cy); arc="bottom" reads left to right along the bottom with their feet on the circle
// and their heads towards the centre. at: the angle the words are centred on, in degrees clockwise from the top
// (default 0 for top, 180 for bottom).
function arcText(l, size, attrs) {
  const r = Number(attrs.r), cx = Number(attrs.cx) || 0, cy = Number(attrs.cy) || 0;
  const bottom = attrs.arc === "bottom";
  const at = attrs.at !== undefined ? Number(attrs.at) : bottom ? 180 : 0;
  const rad = (deg) => (deg * Math.PI) / 180;
  return l.glyphs.map((g, i) => {
    const half = ((g.advanceWidth || 0) / l.unitsPerEm) * size / 2;
    const mid = l.xs[i] + half - l.width / 2; // distance along the arc from its centre
    const theta = bottom ? at - (mid / r) * (180 / Math.PI) : at + (mid / r) * (180 / Math.PI);
    const rot = rad(bottom ? theta - 180 : theta);
    const px = cx + r * Math.sin(rad(theta)), py = cy - r * Math.cos(rad(theta));
    const [c, s] = [Math.cos(rot), Math.sin(rot)];
    const map = (X, Y) => [px + X * c - Y * s, py + X * s + Y * c];
    return pathData(g.getPath(-half, 0, size).commands.map((cmd) => {
      const out = { ...cmd };
      for (const [kx, ky] of [["x", "y"], ["x1", "y1"], ["x2", "y2"]]) if (cmd[kx] !== undefined) [out[kx], out[ky]] = map(cmd[kx], cmd[ky]);
      return out;
    }));
  }).join(" ");
}

// PDFKit and SVG-to-PDFKit (both MIT), fetched into the cache like the fonts. SVG-to-PDFKit keeps masks as vector
// soft masks; Chromium's print to PDF turned them into pictures.
function pdfKit() {
  cached("pdfkit");
  cached("svg-to-pdfkit");
  const need = createRequire(join(CACHE, "package.json"));
  return { PDFDocument: need("pdfkit"), SVGtoPDF: need("svg-to-pdfkit") };
}

// ---------- building ----------

const palettes = variantPalettes(C);
const conceptIds = () => (existsSync(CONCEPTS) ? readdirSync(CONCEPTS).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")).sort() : []);
const readConcept = (id) => parseConcept(readFileSync(join(CONCEPTS, `${id}.svg`), "utf8"));

// Measure a symbol drawn with viewBox="auto": render it large, find what it covers, then again closer for precision.
async function measure(concept, id, boxes) {
  const content = paint(expandSymbol(concept, id, { text: setText, boxes }), { ink: "#000000", accent: "#000000" });
  const scan = async ([x, y, w, h], px) => {
    const H = Math.round((h / w) * px);
    const { data, info } = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${px}" height="${H}">${content}</svg>`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
    for (let j = 0; j < info.height; j++) for (let i = 0; i < info.width; i++) if (data[(j * info.width + i) * 4 + 3] > 8) { if (i < x1) x1 = i; if (i > x2) x2 = i; if (j < y1) y1 = j; if (j > y2) y2 = j; }
    if (x2 < 0) throw new Error(`symbol "${id}" draws nothing`);
    const k = w / info.width;
    return [x + x1 * k, y + y1 * k, (x2 - x1 + 1) * k, (y2 - y1 + 1) * k];
  };
  const rough = await scan([-1000, -1000, 4000, 4000], 2000);
  const pad = Math.max(rough[2], rough[3]) * 0.04;
  let box = await scan([rough[0] - pad, rough[1] - pad, Math.max(rough[2], rough[3]) + 2 * pad, Math.max(rough[2], rough[3]) + 2 * pad], 3000);
  box = box.map((v) => Number(v.toFixed(2)));
  return id === "mark" ? squareBox(box) : box;
}

// Every symbol of a concept in every version: { boxes, files: { "<symbol>-<variant>": svg }, notes }.
async function build(id) {
  const concept = readConcept(id);
  const problems = lintConcept(concept);
  if (problems.length) return { id, concept, problems };
  const boxes = {};
  // Marks first: lockups place them.
  const order = Object.keys(concept.symbols).sort((a, b) => (a === "mark" ? -1 : b === "mark" ? 1 : 0));
  for (const s of order) if (concept.symbols[s].viewBox === "auto") boxes[s] = await measure(concept, s, boxes);
  const files = {};
  for (const s of order) {
    const content = expandSymbol(concept, s, { text: setText, boxes });
    for (const v of VARIANT_NAMES) files[`${s}-${v}`] = svgFile(paint(content, palettes[v]), boxOf(concept, s, boxes), { label: s === "mark" ? "" : name });
  }
  const box = boxOf(concept, "lockup", boxes);
  const clear = Number(concept.src.match(/data-clear="([\d.]+)"/)?.[1]) || 0.25;
  const use = usage(box, { clear });
  const notes = [];
  for (const v of VARIANT_NAMES) for (const n of palettes[v].notes) notes.push(`${v}: ${n}`);
  if (use.headerWidthPx > 240) notes.push(`At the header's 36 px the logo is ${use.headerWidthPx} px wide; on a 390 px phone that leaves little room beside it (look at the phone header)`);
  const size = Math.max(...Object.values(files).map((f) => f.length));
  if (size > 40000) notes.push(`The biggest file is ${Math.round(size / 1024)} KB; simplify the shapes`);
  if (/data-template="true"/.test(concept.src)) notes.push("A template: the name in the display font, with no idea of its own");
  return { id, concept, problems, boxes, files, usage: use, notes };
}

// ---------- commands ----------

if (cmd === "brief") {
  const file = join(DIR, "brief.md");
  mkdirSync(DIR, { recursive: true });
  if (existsSync(file)) console.log(`${file} already exists; it's kept.`);
  else { writeFileSync(file, briefTemplate(name)); console.log(`Wrote ${file}. Fill in every section, then draw concepts in ${CONCEPTS}/ (format at the top of scripts/lib/logo.mjs).`); }
}

if (cmd === "measure") {
  const words = positional[0];
  if (!words) { console.error(USAGE); process.exit(2); }
  const ff = fontFor({ font: flag("font") || "display", family: flag("family"), weight: flag("weight") });
  const size = Number(flag("size") || 100);
  const l = layout(ff.font, words, size, Number(flag("tracking") || 0));
  console.log(JSON.stringify({ font: `${ff.family} ${ff.weight}`, size, width: n2(l.width), capHeight: n2(l.capHeight), ascent: n2(l.ascent), descent: n2(l.descent) }));
}

if (cmd === "templates") {
  // The six layouts of the first brand kit, as concepts: quick and plain. A designed concept starts from the brief.
  mkdirSync(CONCEPTS, { recursive: true });
  const initials = (flag("initials") || name.split(/[\s&+-]+/).filter((w) => /^[A-Za-z0-9]/.test(w)).map((w) => w[0]).join("").slice(0, 2)).toUpperCase();
  const icon = flag("icon");
  let iconBody = "";
  if (icon) {
    const file = join(cached("@phosphor-icons/core"), "assets", "fill", `${icon}-fill.svg`);
    if (!existsSync(file)) throw new Error(`No Phosphor icon "${icon}" (see https://phosphoricons.com; use the name, e.g. "film-slate")`);
    iconBody = readFileSync(file, "utf8").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").replace(/\sfill="[^"]*"/g, "").replace(/<(path|circle|rect|polygon|ellipse)\b/g, '<$1 fill="black"');
  }
  const cut = (round) => `<mask id="cut"><rect width="100" height="100" fill="white"/>${iconBody ? `<g transform="translate(20 20) scale(${60 / 256})">${iconBody}</g>` : `<fb-text font="display" size="${initials.length > 1 ? 46 : 60}" x="50" center-y="50" anchor="middle" fill="black">${escapeXml(initials)}</fb-text>`}</mask><rect width="100" height="100" rx="${round}" fill="accent" mask="url(#cut)"/>`;
  const head = (n, label) => `<svg xmlns="http://www.w3.org/2000/svg" data-type="${n === 5 ? "lettermark" : n === 1 || n === 6 ? "wordmark" : "combination"}" data-template="true" data-idea="Template ${n}, ${label}: the name set in the display font${icon ? `, with the Phosphor ${icon} icon` : ""}" data-from="site.config.json: the name">`;
  const N = escapeXml(name);
  const nameWidth = (size, words = name, tracking = 0) => layout(fontFor().font, words, size, tracking).width;
  const tpl = [
    ["Wordmark", `<symbol id="mark" viewBox="0 0 100 100">${cut(22)}</symbol><symbol id="lockup" viewBox="auto"><fb-text size="100" fill="ink">${N}</fb-text></symbol>`],
    ["Mark and name", `<symbol id="mark" viewBox="0 0 100 100">${cut(22)}</symbol><symbol id="lockup" viewBox="auto"><use href="#mark" x="0" y="0" width="100" height="100"/><fb-text size="82" x="128" center-y="50" fill="ink">${N}</fb-text></symbol>`],
    ["Stacked", `<symbol id="mark" viewBox="0 0 100 100">${cut(22)}</symbol><symbol id="lockup" viewBox="auto"><use href="#mark" x="-70" y="0" width="140" height="140"/><fb-text size="60" x="0" y="212" anchor="middle" fill="ink">${N}</fb-text></symbol>`],
    ["Badge", (() => { const w = nameWidth(70) + 90; return `<symbol id="mark" viewBox="0 0 100 100">${cut(22)}</symbol><symbol id="lockup" viewBox="0 0 ${n2(w)} 100"><mask id="pill"><rect width="${n2(w)}" height="100" fill="white"/><fb-text size="70" x="${n2(w / 2)}" center-y="50" anchor="middle" fill="black">${N}</fb-text></mask><rect width="${n2(w)}" height="100" rx="50" fill="accent" mask="url(#pill)"/></symbol>`; })()],
    ["Monogram", `<symbol id="mark" viewBox="0 0 100 100">${cut(50)}</symbol><symbol id="lockup" viewBox="0 0 100 100"><use href="#mark" x="0" y="0" width="100" height="100"/></symbol>`],
    ["Tracked with rule", `<symbol id="mark" viewBox="0 0 100 100">${cut(22)}</symbol><symbol id="lockup" viewBox="auto"><fb-text size="62" tracking="0.1" fill="ink">${escapeXml(name.toUpperCase())}</fb-text><rect x="0" y="16" width="90" height="10" fill="accent"/></symbol>`],
  ];
  tpl.forEach(([label, body], i) => writeFileSync(join(CONCEPTS, `t${i + 1}.svg`), `${head(i + 1, label)}\n${body}\n</svg>\n`));
  console.log(`Six template concepts in ${CONCEPTS}/ (t1 ... t6). Next: node scripts/logo.mjs sheet`);
}

if (cmd === "check") {
  let bad = 0;
  const brief = join(DIR, "brief.md");
  const ids = conceptIds();
  const designed = ids.filter((id) => !/data-template="true"/.test(readFileSync(join(CONCEPTS, `${id}.svg`), "utf8")));
  if (designed.length) {
    const p = existsSync(brief) ? briefProblems(readFileSync(brief, "utf8")) : ["there is no brief: node scripts/logo.mjs brief"];
    for (const x of p) { console.log(`  fail  brief: ${x}`); bad++; }
  }
  for (const id of ids) {
    const p = lintConcept(readConcept(id));
    for (const x of p) { console.log(`  fail  ${id}: ${x}`); bad++; }
    if (!p.length) console.log(`  ok    ${id}`);
  }
  if (!ids.length) console.log(`  note  no concepts in ${CONCEPTS}/ yet`);
  if (existsSync(RESEARCH)) {
    const todo = unwrittenLenses(readFileSync(RESEARCH, "utf8"));
    if (todo.length) console.log(`  note  ${RESEARCH} isn't written yet (${todo.join(", ")}): the brief draws on it`);
  }
  process.exit(bad ? 1 : 0);
}

// The site's own photo for the "on a photo" test: the home page hero's.
async function photo() {
  try {
    const home = JSON.parse(readFileSync("src/content/home.json", "utf8"));
    const src = home.sections?.find((s) => s._type === "fb_hero")?.image?.src;
    if (!src || !existsSync(join("src/assets/images", src))) return null;
    const buf = await sharp(join("src/assets/images", src)).resize({ width: 640, height: 300, fit: "cover" }).jpeg({ quality: 70 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch { return null; }
}

const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const pngOf = async (svg, w, h) => sharp(Buffer.from(svg), { density: 300 }).resize(w, h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();

// A square icon: the mark on a paper square, the mark taking `share` of its side.
function iconSvg(markSvgInner, markBox, paper, share, { round = 0 } = {}) {
  const S = 100, m = S * share, o = (S - m) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}"><rect width="${S}" height="${S}" rx="${S * round}" fill="${paper}"/><svg x="${o}" y="${o}" width="${m}" height="${m}" viewBox="${markBox.join(" ")}">${markSvgInner}</svg></svg>`;
}
const inner = (svg) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
// A maskable icon's safe zone is the circle in the middle with a radius of 40% of the icon (web.dev, "Adaptive icon
// support in PWAs with maskable icons"); a square mark fits inside it at 0.8 / sqrt(2) = 56% of the side.
const MASKABLE_SHARE = 0.56;

if (cmd === "sheet") {
  // With ids, only those concepts are redrawn: the other concepts' sheets, the overview, concepts.pdf and
  // concepts.json are left as they were.
  const subset = positional.length > 0;
  const ids = subset ? positional : conceptIds();
  if (!ids.length) throw new Error(`No concepts in ${CONCEPTS}/: write the brief (node scripts/logo.mjs brief) and draw some, or run templates`);
  const brief = join(DIR, "brief.md");
  if (!existsSync(brief)) console.log("  note  no brief yet (node scripts/logo.mjs brief): a designed logo starts from one");
  const built = [];
  for (const id of ids) built.push(await build(id));
  if (subset) for (const id of ids) rmSync(join(DIR, "build", id), { recursive: true, force: true });
  else rmSync(join(DIR, "build"), { recursive: true, force: true });
  for (const b of built.filter((x) => !x.problems.length)) {
    mkdirSync(join(DIR, "build", b.id), { recursive: true });
    for (const [k, svg] of Object.entries(b.files)) writeFileSync(join(DIR, "build", b.id, `${k}.svg`), svg);
  }
  const pic = await photo();
  const page = palettes.pageVariant;
  const dark = palettes["on-dark"], light = palettes["on-light"];
  const font = familyOf(design.typography.body) || "sans-serif";
  const fg = (paper) => (ratio(paper, "#000000") < ratio(paper, "#ffffff") ? "#dddddd" : "#555555"); // caption colour on a tile
  const img = (svg, h, extra = "") => `<img src="${dataUri(svg)}" style="height:${h}px;width:auto;display:block;${extra}" alt="">`;
  const pixel = async (svg) => {
    const small = await sharp(Buffer.from(svg), { density: 72 }).resize(16, 16, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const big = await sharp(small).resize(96, 96, { kernel: "nearest" }).png().toBuffer();
    return `data:image/png;base64,${big.toString("base64")}`;
  };
  const sections = [];
  for (const [i, b] of built.entries()) {
    if (b.problems.length) {
      sections.push(`<section class="c"><h2>${i + 1}. ${escapeXml(b.id)}: can't be built</h2><ul>${b.problems.map((p) => `<li>${escapeXml(p)}</li>`).join("")}</ul></section>`);
      continue;
    }
    const f = b.files;
    const mb = boxOf(b.concept, "mark", b.boxes);
    const favLight = iconSvg(inner(f[`mark-${page}`]), mb, palettes[page].paper, 0.88, { round: 0.18 });
    const maskable = iconSvg(inner(f[`mark-${page}`]), mb, palettes[page].paper, MASKABLE_SHARE);
    const stacked = f[`stacked-${page}`];
    sections.push(`<section class="c" id="${escapeXml(b.id)}">
<h2>${i + 1}. ${escapeXml(b.id)} <small>${escapeXml(b.concept.meta.type)}</small></h2>
<p class="idea">${escapeXml(b.concept.meta.idea)}</p><p class="from">From: ${escapeXml(b.concept.meta.from)}</p>${b.concept.meta.trend ? `<p class="from">Current design: ${escapeXml(b.concept.meta.trend)}</p>` : ""}${b.concept.meta.look ? `<p class="from">Fits the site: ${escapeXml(b.concept.meta.look)}</p>` : ""}
<div class="row"><figure style="flex:1"><div class="hdr" style="background:${palettes[page].paper}">${img(f[`lockup-${page}`], SHEET_SIZES.headerPx)}<span class="nav" style="color:${palettes[page].ink}">Page · Page · Page</span><span class="btn" style="background:${C.accent};color:${C["accent-ink"] || "#000"}">Action</span></div><figcaption>Site header, logo ${SHEET_SIZES.headerPx} px tall (${b.usage.headerWidthPx} px wide)</figcaption></figure>
<figure><div class="phone" style="background:${palettes[page].paper}">${img(f[`lockup-${page}`], 28, "max-width:250px;height:auto;max-height:28px")}<span class="btn" style="background:${C.accent};color:${C["accent-ink"] || "#000"}">Action</span></div><figcaption>Phone header, 390 px</figcaption></figure></div>
<div class="row">${["on-dark", "on-light", "black", "white"].map((v) => `<figure class="t" style="background:${palettes[v].paper};color:${fg(palettes[v].paper)}">${img(f[`lockup-${v}`], 72, "max-width:100%;height:auto;max-height:72px")}<figcaption>${{ "on-dark": "Dark paper", "on-light": "Light paper", black: "One colour, black", white: "One colour, white" }[v]}</figcaption></figure>`).join("")}</div>
<div class="row">${pic ? `<figure class="t photo" style="background-image:linear-gradient(transparent 30%, rgba(0,0,0,.65)),url(${pic})"><div style="position:absolute;left:20px;bottom:18px">${img(f["lockup-on-dark"], 40, "max-width:300px;height:auto;max-height:40px")}</div><figcaption style="color:#fff">On a photo (the home hero)</figcaption></figure>` : ""}
<figure class="t" style="background:${palettes[page].paper};color:${fg(palettes[page].paper)}"><div class="marks">${[16, 32, 48].map((s) => img(f[`mark-${page}`], s)).join("")}<img src="${await pixel(f[`mark-${page}`])}" style="width:96px;height:96px;image-rendering:pixelated" alt=""></div><figcaption>Mark at 16, 32, 48 px; 16 px enlarged</figcaption></figure></div>
<div class="row"><figure class="t" style="background:#dee1e6"><div class="tab"><img src="${dataUri(favLight)}" width="16" height="16" alt=""><span>${escapeXml(name)}</span></div><div class="tab dark"><img src="${dataUri(favLight)}" width="16" height="16" alt=""><span>${escapeXml(name)}</span></div><figcaption>Favicon in light and dark browser tabs</figcaption></figure>
<figure class="t" style="background:#eee"><div style="width:120px;height:120px;border-radius:50%;overflow:hidden">${img(iconSvg(inner(f[`mark-${page}`]), mb, palettes[page].paper, 0.6), 120)}</div><figcaption>Social avatar (circle)</figcaption></figure>
<figure class="t" style="background:#eee"><div style="position:relative;width:120px;height:120px">${img(maskable, 120)}<div style="position:absolute;inset:12px;border:1.5px dashed #e00;border-radius:50%"></div></div><figcaption>App icon; dashed: the maskable safe zone</figcaption></figure></div>
<div class="row">${[["on-dark", dark], ["on-light", light]].map(([v, p]) => `<figure class="t"><div class="card" style="background:${p.paper}">${img(f[`lockup-${v}`], SHEET_SIZES.card.lockupHeightIn * 96, "max-width:80%;height:auto")}</div><figcaption>Business card, 3.5 × 2 in at full size</figcaption></figure>`).join("")}${stacked ? `<figure class="t" style="background:${palettes[page].paper};color:${fg(palettes[page].paper)}">${img(stacked, 120, "max-width:100%;height:auto;max-height:120px")}<figcaption>Stacked</figcaption></figure>` : ""}</div>
${b.notes.length ? `<ul class="notes">${b.notes.map((n) => `<li>${escapeXml(n)}</li>`).join("")}</ul>` : ""}
</section>`);
  }
  const overview = built.map((b, i) => b.problems.length ? `<div class="o bad"><b>${i + 1}. ${escapeXml(b.id)}</b><br>can't be built</div>`
    : `<div class="o"><div class="o-logo" style="background:${palettes[page].paper}">${img(b.files[`lockup-${page}`], 56, "max-width:100%;height:auto;max-height:56px")}</div><div class="o-meta"><div class="o-marks" style="background:${palettes[page].paper}">${img(b.files[`mark-${page}`], 48)}${img(b.files[`mark-${page}`], 16)}</div><div><b>${i + 1}. ${escapeXml(b.id)}</b> · ${escapeXml(b.concept.meta.type)}<br>${escapeXml(b.concept.meta.idea)}</div></div></div>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:15px/1.4 "${font}",system-ui,sans-serif;color:#222;background:#fff;width:1200px}
section,.ov{padding:28px 32px;border-bottom:8px solid #eee}
h1,h2{margin:0 0 6px;font-size:22px} h2 small{font-weight:400;color:#666;font-size:15px}
.idea{margin:0 0 4px;font-size:16px}.from{margin:0 0 4px;color:#666}h2+.idea{margin-top:2px}section .row:first-of-type{margin-top:12px}
.row{display:flex;gap:12px;margin:0 0 12px;flex-wrap:wrap}
figure{margin:0}figcaption{font-size:12px;color:#666;margin-top:6px}
.t{flex:1;min-width:200px;padding:16px;border-radius:6px;min-height:90px;display:flex;flex-direction:column;justify-content:space-between;position:relative}
.t figcaption{color:inherit}
.photo{background-size:cover;background-position:center;min-height:170px}
.hdr{display:flex;align-items:center;gap:24px;padding:14px 24px;height:64px;box-sizing:border-box}
.hdr .nav{margin-left:auto;font-size:14px;opacity:.8}
.btn{padding:8px 14px;font-size:14px;font-weight:600}
.phone{width:390px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;padding:10px 16px;height:56px}
.marks{display:flex;align-items:flex-end;gap:18px}
.tab{display:flex;align-items:center;gap:8px;background:#fff;border-radius:8px 8px 0 0;padding:8px 12px;width:200px;font-size:12px;margin-bottom:6px}
.tab.dark{background:#35363a;color:#eee}
.card{width:336px;height:192px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.notes{margin:8px 0 0;padding-left:20px;color:#8a4b00}
.ovg{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.o{border:1px solid #ddd;border-radius:6px;overflow:hidden}.o.bad{padding:16px;color:#b00}
.o-logo{padding:24px;height:104px;box-sizing:border-box;display:flex;align-items:center}
.o-meta{display:flex;gap:12px;padding:12px;align-items:flex-start;font-size:13px}
.o-marks{display:flex;gap:10px;align-items:flex-end;padding:8px;border-radius:4px}
</style><div class="ov" id="overview"><h1>Logo concepts: ${escapeXml(name)}</h1><p class="from">${built.length} concepts · fonts ${escapeXml([...used].join(", ") || "none")} · rendered by scripts/logo.mjs</p><div class="ovg">${overview}</div></div>${sections.join("\n")}`;
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, "sheet.html"), html); // the page the sheets are shot from, for debugging; not a deliverable
  const browser = await launchBrowser();
  try {
    const p = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await p.setContent(html, { waitUntil: "load" });
    if (!subset) {
      await (await p.$("#overview")).screenshot({ path: join(DIR, "sheet.png") });
      rmSync(join(DIR, "sheets"), { recursive: true, force: true });
    }
    mkdirSync(join(DIR, "sheets"), { recursive: true });
    for (const b of built) {
      const el = await p.$(`section[id="${b.id}"]`);
      if (el) await el.screenshot({ path: join(DIR, "sheets", `${b.id}.png`) });
    }
  } finally { await browser.close(); }
  // One file to send: the overview and every concept's sheet, a page each.
  const PDFDocument = pdfKit().PDFDocument;
  if (!subset) await new Promise((done, fail) => {
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: `${name}: logo concepts` } });
    const stream = createWriteStream(join(DIR, "concepts.pdf"));
    stream.on("finish", done).on("error", fail);
    doc.pipe(stream);
    for (const file of [join(DIR, "sheet.png"), ...built.filter((b) => existsSync(join(DIR, "sheets", `${b.id}.png`))).map((b) => join(DIR, "sheets", `${b.id}.png`))]) {
      const img = doc.openImage(file);
      doc.addPage({ size: [img.width * 0.6, img.height * 0.6], margin: 0 });
      doc.image(img, 0, 0, { width: img.width * 0.6, height: img.height * 0.6 });
    }
    doc.end();
  });
  if (!subset) writeFileSync(join(DIR, "concepts.json"), JSON.stringify({
    rendered: new Date().toISOString(), brief: existsSync(brief) ? briefProblems(readFileSync(brief, "utf8")) : "missing", fonts: [...used],
    concepts: built.map((b) => ({ id: b.id, ...b.concept.meta, problems: b.problems, notes: b.notes || [], usage: b.usage })),
  }, null, 2) + "\n");
  const failed = built.filter((b) => b.problems.length);
  for (const b of built) console.log(`  ${b.problems.length ? "fail" : "ok  "}  ${b.id}${b.problems.length ? `: ${b.problems.join("; ")}` : b.notes.length ? ` (${b.notes.length} note${b.notes.length > 1 ? "s" : ""})` : ""}`);
  if (subset) console.log(`Redrew ${ids.map((id) => `${DIR}/sheets/${id}.png`).join(", ")}; the overview, concepts.pdf and concepts.json are as they were (run sheet with no ids to redo them).`);
  else console.log(`Sheets: ${DIR}/sheet.png (all), ${DIR}/sheets/<id>.png and ${DIR}/concepts.pdf. Look at every one, then: node scripts/logo.mjs pick <id>`);
  if (failed.length) process.exit(1);
}

if (cmd === "pick") {
  const id = positional[0];
  if (!id || !existsSync(join(CONCEPTS, `${id}.svg`))) throw new Error(`No concept "${id}" in ${CONCEPTS}/ (ids: ${conceptIds().join(", ") || "none"})`);
  const b = await build(id);
  if (b.problems.length) throw new Error(`${id} can't be built: ${b.problems.join("; ")}`);
  const isTemplate = /data-template="true"/.test(b.concept.src);
  if (!isTemplate) {
    const brief = join(DIR, "brief.md");
    const p = existsSync(brief) ? briefProblems(readFileSync(brief, "utf8")) : ["missing"];
    if (p.length) throw new Error(`The logo brief isn't finished (${p.join("; ")}); a designed logo is picked against it`);
  }
  const page = palettes.pageVariant;
  const f = b.files;
  const mb = boxOf(b.concept, "mark", b.boxes);
  const markPage = inner(f[`mark-${page}`]);
  const paper = palettes[page].paper;
  const out = {
    "public/logo.svg": f[`lockup-${page}`],
    "public/logo-on-dark.svg": f["lockup-on-dark"],
    "public/logo-on-light.svg": f["lockup-on-light"],
    "public/logo-black.svg": f["lockup-black"],
    "public/logo-white.svg": f["lockup-white"],
    "public/mark.svg": f[`mark-${page}`],
    "public/favicon.svg": iconSvg(markPage, mb, paper, 0.88, { round: 0.18 }),
  };
  for (const [file, svg] of Object.entries(out)) writeFileSync(file, svg);
  // Icons: the mark on the page colour. Google Search wants a square favicon over 48 px in a raster format
  // (it doesn't list SVG); the maskable icon keeps the mark inside the middle 80% circle (web.dev).
  await sharp(Buffer.from(iconSvg(markPage, mb, paper, 0.88, { round: 0.18 })), { density: 300 }).resize(96, 96).png().toFile("public/favicon-96.png");
  await sharp(Buffer.from(iconSvg(markPage, mb, paper, 0.72)), { density: 300 }).resize(180, 180).png().toFile("public/apple-touch-icon.png");
  for (const s of [192, 512]) await sharp(Buffer.from(iconSvg(markPage, mb, paper, 0.72)), { density: 300 }).resize(s, s).png().toFile(`public/icon-${s}.png`);
  await sharp(Buffer.from(iconSvg(markPage, mb, paper, MASKABLE_SHARE)), { density: 300 }).resize(512, 512).png().toFile("public/icon-maskable-512.png");
  writeFileSync("public/manifest.webmanifest", JSON.stringify({
    name, short_name: name.length > 12 ? name.split(/\s+/).map((w) => w[0]).join("").toUpperCase() : name, start_url: "/", display: "standalone",
    background_color: paper, theme_color: C.accent,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  }, null, 2) + "\n");

  // Share image: the logo and the tagline on the page colour, with an accent line along the bottom.
  const logoPng = await sharp(Buffer.from(f[`lockup-${page}`]), { density: 600 }).resize({ width: 900, height: 260, fit: "inside" }).png().toBuffer();
  const meta = await sharp(logoPng).metadata();
  const tagline = site.site.tagline || "";
  const logoFonts = [...used];
  let bodyFont = "body";
  try { fontFor({ font: "body" }); } catch { bodyFont = "display"; } // a system body font: set the tagline in the display font
  const body = fontFor({ font: bodyFont });
  const lines = [];
  if (tagline) {
    let line = "";
    for (const word of tagline.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && layout(body.font, next, 40).width > 1040) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > 2) {
      let second = lines[1];
      while (second && layout(body.font, `${second}…`, 40).width > 1040) second = second.replace(/\s*\S+$/, "");
      lines.splice(1, lines.length - 1, `${second}…`);
    }
  }
  // The tagline in the muted ink when it holds 4.5:1 on the page colour (the share image's paper is the page colour).
  const muted = /^#[0-9a-f]{6}$/i.test(C["ink-muted"] || "") && ratio(C["ink-muted"], paper) >= 4.5 ? C["ink-muted"] : palettes[page].ink;
  const tagW = Math.max(0, ...lines.map((l) => layout(body.font, l, 40).width));
  const tagPng = lines.length ? await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(tagW) + 4}" height="${lines.length * 56}">${lines.map((l, i) => {
    const w = layout(body.font, l, 40).width;
    return `<path fill="${muted}" d="${setText({ font: bodyFont, size: 40, x: 2 + (tagW - w) / 2, y: 44 + i * 56 }, l).d}"/>`;
  }).join("")}</svg>`)).png().toBuffer() : null;
  const tagMeta = tagPng ? await sharp(tagPng).metadata() : { height: 0, width: 0 };
  const top = Math.round((630 - meta.height - (tagPng ? tagMeta.height + 40 : 0)) / 2);
  const comps = [{ input: logoPng, left: Math.round((1200 - meta.width) / 2), top }];
  if (tagPng) comps.push({ input: tagPng, left: Math.round((1200 - tagMeta.width) / 2), top: top + meta.height + 40 });
  comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="12"><rect width="1200" height="12" fill="${palettes[page].accent}"/></svg>`), left: 0, top: 618 });
  await sharp({ create: { width: 1200, height: 630, channels: 3, background: paper } }).composite(comps).png().toFile("public/og.png");

  // Print and social: every version as a vector PDF (for a printer) and a 2000 px PNG, and a square avatar.
  const KIT = join(DIR, "kit");
  rmSync(KIT, { recursive: true, force: true });
  mkdirSync(KIT, { recursive: true });
  const box = boxOf(b.concept, "lockup", b.boxes);
  const { PDFDocument, SVGtoPDF } = pdfKit();
  for (const v of VARIANT_NAMES) {
    const svg = f[`lockup-${v}`];
    writeFileSync(join(KIT, `logo-${v}.svg`), svg);
    writeFileSync(join(KIT, `mark-${v}.svg`), f[`mark-${v}`]);
    await sharp(Buffer.from(svg), { density: 600 }).resize({ width: 2000 }).png().toFile(join(KIT, `logo-${v}.png`));
    // 4 in wide at the logo's own shape, with its clear space around it, in points.
    const W = 4 * 72, H = (box[3] / box[2]) * W, pad = b.usage.clearSpace.share * H;
    await new Promise((done, fail) => {
      const doc = new PDFDocument({ size: [W + 2 * pad, H + 2 * pad], margin: 0, info: { Title: `${name} logo (${v})` } });
      const stream = createWriteStream(join(KIT, `logo-${v}.pdf`));
      stream.on("finish", done).on("error", fail);
      doc.pipe(stream);
      SVGtoPDF(doc, svg, pad, pad, { width: W, height: H });
      doc.end();
    });
  }
  await sharp(Buffer.from(iconSvg(markPage, mb, paper, 0.6)), { density: 300 }).resize(1000, 1000).png().toFile(join(KIT, "avatar.png"));

  const logoJson = {
    concept: id, type: b.concept.meta.type, idea: b.concept.meta.idea, from: b.concept.meta.from, template: isTemplate,
    fonts: logoFonts, picked: new Date().toISOString().slice(0, 10), pageVersion: page,
    versions: Object.fromEntries(VARIANT_NAMES.map((v) => [v, { file: `/logo-${v}.svg`, ink: palettes[v].ink, accent: palettes[v].accent, paper: palettes[v].paper }])),
    mark: "/mark.svg", ...b.usage, notes: b.notes,
  };
  writeFileSync(join(DIR, "logo.json"), JSON.stringify(logoJson, null, 2) + "\n");

  site.site.logo = "/logo.svg";
  writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");
  const credits = JSON.parse(readFileSync("design/credits.json", "utf8"));
  const files = [...Object.keys(out), "public/favicon-96.png", "public/apple-touch-icon.png", "public/icon-192.png", "public/icon-512.png", "public/icon-maskable-512.png", "public/og.png"];
  credits.images = credits.images.filter((c) => !files.includes(c.file));
  const note = `Logo concept "${id}" (design/brand/concepts/${id}.svg), built by scripts/logo.mjs${logoFonts.length ? `; type set in ${logoFonts.join(", ")}` : ""}`;
  for (const file of files) credits.images.push({ file, source: "brand", alt: /logo(-[a-z-]+)?\.svg$/.test(file) ? name : file.endsWith("og.png") ? `${name}${tagline ? `: ${tagline}` : ""}` : "", note });
  writeFileSync("design/credits.json", JSON.stringify(credits, null, 2) + "\n");
  console.log(`Installed "${id}": ${files.length} files in public/, print and social files in ${KIT}/, ${DIR}/logo.json. site.logo is set.`);
  for (const n of b.notes) console.log(`  note  ${n}`);
  console.log("Next: render the style guide again (node scripts/style-guide.mjs), and before launch search the name and mark in the USPTO trademark database (HANDOFF.md).");
}
