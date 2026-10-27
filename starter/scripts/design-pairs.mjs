#!/usr/bin/env node
// This-or-that (design phase P2.5, docs/SPEC.md section 12): 4–6 two-option pairs, each rendered on the owner's
// real headline, so the owner picks between looks instead of describing one. Each pair changes one thing
// (display type, palette, imagery, density or shape) on top of the current DESIGN.md.
//
//   node scripts/design-pairs.mjs render [--pairs design/pairs.json]   → design/pairs/<id>.png and index.html
//   node scripts/design-pairs.mjs pick <id> a|b                         → the owner's pick, in design/intake.json
//   node scripts/design-pairs.mjs defaults                              → the recommended side for every pair not
//                                                                         picked, marked "inferred" (autopilot, or
//                                                                         an owner who stays silent)
//
// design/pairs.json, written by the agent:
//   { "pairs": [ { "id": "type", "question": "Which headline feels more like you?", "recommended": "a",
//                  "a": { "label": "Warm serif", "display": "Lora" },
//                  "b": { "label": "Plain sans", "display": "Figtree" } }, ... ] }
// An option can set: display, body (font families), colors ({ bg, ink, ink-muted, accent, accent-ink, surface }),
// radius (px), density ("airy" | "compact"), imagery ("photo" | "type-only") and image (a file in
// src/assets/images). Anything it doesn't set comes from DESIGN.md, so A and B differ only where the pair says.
// The headline, subheadline and button text come from the home page's hero unless pairs.json sets "copy".
// Fonts are Fontsource packages. A font the site hasn't installed is fetched into node_modules/.cache, not added
// to package.json. Fonts the QA gate bans are refused.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse } from "yaml";
import { launchBrowser } from "./lib/local-site.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const PAIRS = resolve(opt("pairs", "design/pairs.json"));
const OUT = resolve(opt("out", "design/pairs"));
const INTAKE = resolve("design/intake.json");
const BANNED = ["inter", "geist", "space grotesk", "instrument serif"]; // scripts/qa.mjs fails on these
const DIMENSIONS = ["display", "body", "colors", "radius", "density", "imagery", "image"];

export function checkPairs(spec) {
  const errors = [];
  const pairs = spec?.pairs;
  if (!Array.isArray(pairs) || pairs.length < 4 || pairs.length > 6) errors.push("pairs.json needs 4 to 6 pairs");
  const ids = new Set();
  for (const [i, p] of (pairs || []).entries()) {
    const where = `pairs[${i}]${p?.id ? ` (${p.id})` : ""}`;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(p?.id || "")) errors.push(`${where}: id must be lowercase letters, digits and dashes`);
    if (ids.has(p?.id)) errors.push(`${where}: duplicate id`);
    ids.add(p?.id);
    if (!p?.question) errors.push(`${where}: question is required`);
    if (!["a", "b"].includes(p?.recommended)) errors.push(`${where}: recommended must be "a" or "b"`);
    for (const side of ["a", "b"]) {
      const o = p?.[side];
      if (!o?.label) errors.push(`${where}.${side}: label is required`);
      const keys = Object.keys(o || {}).filter((k) => k !== "label");
      if (!keys.length) errors.push(`${where}.${side}: set at least one of ${DIMENSIONS.join(", ")}`);
      for (const k of keys) if (!DIMENSIONS.includes(k)) errors.push(`${where}.${side}.${k}: unknown; use ${DIMENSIONS.join(", ")}`);
      for (const f of [o?.display, o?.body].filter(Boolean)) if (BANNED.includes(String(f).toLowerCase())) errors.push(`${where}.${side}: "${f}" is a font the QA gate bans`);
      if (o?.density && !["airy", "compact"].includes(o.density)) errors.push(`${where}.${side}.density must be "airy" or "compact"`);
      if (o?.imagery && !["photo", "type-only"].includes(o.imagery)) errors.push(`${where}.${side}.imagery must be "photo" or "type-only"`);
      if (o?.imagery === "photo" && !o.image) errors.push(`${where}.${side}: imagery "photo" needs an image from src/assets/images`);
    }
  }
  return errors;
}

// The intake file with one pick recorded.
export function withPick(intake, pairsSpec, id, side, by) {
  const pair = pairsSpec.pairs.find((p) => p.id === id);
  if (!pair) throw new Error(`no pair "${id}" in pairs.json`);
  if (!["a", "b"].includes(side)) throw new Error('pick "a" or "b"');
  const out = structuredClone(intake || {});
  out.pairs = { ...(out.pairs || {}), [id]: { question: pair.question, pick: side, label: pair[side].label, chosen: pair[side], by } };
  return out;
}

const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const GENERIC = /^(system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace)$/;

// @font-face rules with the font's Latin files inlined, from the site's packages or a cached install.
function fontFace(family) {
  if (GENERIC.test(family)) return "";
  const cache = resolve("node_modules/.cache/design-pairs");
  const roots = [resolve("node_modules"), join(cache, "node_modules")];
  const find = () => {
    for (const root of roots) for (const pkg of [`@fontsource-variable/${slug(family)}`, `@fontsource/${slug(family)}`]) if (existsSync(join(root, pkg, "files"))) return join(root, pkg);
    return null;
  };
  let dir = find();
  if (!dir) {
    mkdirSync(cache, { recursive: true });
    // A package.json keeps earlier fonts: npm prunes packages a later install doesn't list.
    if (!existsSync(join(cache, "package.json"))) writeFileSync(join(cache, "package.json"), '{ "private": true }\n');
    for (const pkg of [`@fontsource-variable/${slug(family)}`, `@fontsource/${slug(family)}`]) {
      try {
        execFileSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", "--prefix", cache, pkg], { stdio: ["ignore", "ignore", "ignore"] });
        break;
      } catch {}
    }
    dir = find();
    if (!dir) throw new Error(`Font "${family}" isn't on Fontsource (tried @fontsource-variable/${slug(family)} and @fontsource/${slug(family)})`);
  }
  const files = readdirSync(join(dir, "files"));
  const wanted = files.filter((f) => /-latin-wght-normal\.woff2$/.test(f)).concat(files.filter((f) => /-latin-(400|700)-normal\.woff2$/.test(f)));
  return wanted
    .map((f) => {
      const weight = /-wght-/.test(f) ? "100 900" : f.match(/-latin-(\d+)-/)[1];
      const data = readFileSync(join(dir, "files", f)).toString("base64");
      return `@font-face{font-family:"${family}";font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
    })
    .join("\n");
}

function baseLook() {
  const front = readFileSync("DESIGN.md", "utf8").match(/^---\n([\s\S]*?)\n---/);
  const t = parse(front[1]);
  const fam = (level) => String(t.typography?.[level]?.fontFamily || "system-ui").split(",")[0].trim().replace(/^["']|["']$/g, "");
  return {
    display: fam("display"),
    body: fam("body"),
    colors: { bg: t.colors.bg, surface: t.colors.surface, ink: t.colors.ink, "ink-muted": t.colors["ink-muted"], accent: t.colors.accent, "accent-ink": t.colors["accent-ink"] },
    radius: parseInt(t.rounded?.control || "6", 10),
    density: "airy",
    imagery: "type-only",
  };
}

function heroCopy(spec) {
  if (spec.copy) return spec.copy;
  const home = JSON.parse(readFileSync("src/content/home.json", "utf8"));
  const hero = home.sections.find((s) => s._type === "fb_hero") || {};
  return { headline: hero.headline || "Your headline", subheadline: hero.subheadline || "", button: hero.primary_cta_label || "Get in touch" };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stackFor = (f) => (GENERIC.test(f) ? f : `'${f}', system-ui, sans-serif`); // single quotes: it goes inside style=""

function panel(look, copy, side, label) {
  const c = look.colors;
  const pad = look.density === "compact" ? 28 : 56;
  const gap = look.density === "compact" ? 12 : 24;
  const img = look.imagery === "photo" && look.image ? `data:image/${extname(look.image).slice(1).replace("jpg", "jpeg")};base64,${readFileSync(join("src/assets/images", look.image)).toString("base64")}` : null;
  return `<section style="width:640px;height:480px;box-sizing:border-box;background:${c.bg};color:${c.ink};padding:${pad}px;display:flex;gap:${gap}px;align-items:center;overflow:hidden">
  <div style="flex:1;display:flex;flex-direction:column;gap:${gap}px">
    <h1 style="margin:0;font:700 ${img ? 34 : 42}px/1.1 ${stackFor(look.display)};letter-spacing:-0.01em">${esc(copy.headline)}</h1>
    ${copy.subheadline ? `<p style="margin:0;font:400 17px/1.55 ${stackFor(look.body)};color:${c["ink-muted"]}">${esc(copy.subheadline)}</p>` : ""}
    <div><span style="display:inline-block;background:${c.accent};color:${c["accent-ink"]};border-radius:${look.radius}px;padding:${look.density === "compact" ? "10px 16px" : "14px 22px"};font:600 16px/1 ${stackFor(look.body)}">${esc(copy.button)}</span></div>
  </div>
  ${img ? `<div style="flex:0 0 42%;align-self:stretch;border-radius:${look.radius * 2}px;background:url(${img}) center/cover"></div>` : ""}
</section>
<div style="font:600 18px/1.4 system-ui;color:#fff;padding:10px 4px">${side.toUpperCase()}: ${esc(label)}</div>`;
}

if (cmd === "render") {
  const spec = JSON.parse(readFileSync(PAIRS, "utf8"));
  const errors = checkPairs(spec);
  if (errors.length) throw new Error(`${PAIRS}:\n- ${errors.join("\n- ")}`);
  const base = baseLook();
  const copy = heroCopy(spec);
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 2 * 640 + 3 * 24, height: 480 + 130 } });
  const rows = [];
  for (const pair of spec.pairs) {
    const look = (o) => ({ ...base, ...o, colors: { ...base.colors, ...(o.colors || {}) } });
    const a = look(pair.a);
    const b = look(pair.b);
    const faces = [...new Set([a.display, a.body, b.display, b.body])].map(fontFace).join("\n");
    await page.setContent(`<!doctype html><html><head><style>${faces}</style></head>
<body style="margin:0;background:#5b5b5b;padding:0 24px">
<div style="font:600 22px/1.3 system-ui;color:#fff;padding:18px 0 12px">${esc(pair.question)}</div>
<div style="display:flex;gap:24px"><div>${panel(a, copy, "a", pair.a.label)}</div><div>${panel(b, copy, "b", pair.b.label)}</div></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(OUT, `${pair.id}.png`) });
    rows.push(`<h2>${esc(pair.question)}</h2><p>A: ${esc(pair.a.label)} · B: ${esc(pair.b.label)} · recommended: ${pair.recommended.toUpperCase()}</p><img src="${pair.id}.png" alt="${esc(pair.question)}" style="max-width:100%">`);
  }
  await browser.close();
  writeFileSync(join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><title>This or that</title><body style="font:16px/1.5 system-ui;max-width:1400px;margin:2rem auto;padding:0 1rem">${rows.join("\n")}</body>\n`);
  console.log(`${spec.pairs.length} pairs in ${OUT} (one PNG each, and index.html). Send them to the owner; record each answer with: node scripts/design-pairs.mjs pick <id> a|b`);
} else if (cmd === "pick" || cmd === "defaults") {
  const spec = JSON.parse(readFileSync(PAIRS, "utf8"));
  let intake = existsSync(INTAKE) ? JSON.parse(readFileSync(INTAKE, "utf8")) : {};
  if (cmd === "pick") intake = withPick(intake, spec, rest[0], String(rest[1] || "").toLowerCase(), "owner");
  else for (const p of spec.pairs) if (!intake.pairs?.[p.id]) intake = withPick(intake, spec, p.id, p.recommended, "inferred");
  mkdirSync("design", { recursive: true });
  writeFileSync(INTAKE, JSON.stringify(intake, null, 2) + "\n");
  const left = spec.pairs.filter((p) => !intake.pairs?.[p.id]).map((p) => p.id);
  console.log(`design/intake.json: ${Object.keys(intake.pairs || {}).length} of ${spec.pairs.length} pairs answered${left.length ? `; still open: ${left.join(", ")}` : ""}.`);
} else if (cmd) {
  console.error("usage: design-pairs.mjs render [--pairs design/pairs.json] [--out design/pairs] | pick <id> a|b | defaults");
  process.exit(2);
}
