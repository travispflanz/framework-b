#!/usr/bin/env node
// Turns DESIGN.md (Google's DESIGN.md format, https://github.com/google-labs-code/design.md) into
// src/styles/tokens.css, the only place the site's colours, type, radii and spacing are defined.
//
//   node scripts/design-tokens.mjs           lint DESIGN.md, then write src/styles/tokens.css
//   node scripts/design-tokens.mjs --check   lint, then fail if tokens.css is out of date (used by the QA gate)
//
// DESIGN.md is linted with @google/design.md (errors fail; warnings are printed). On top of the format, Framework B
// requires a small token contract, so the section library works with any design:
//   colors:     bg, surface, ink, ink-muted, line, field, accent, accent-ink, highlight, highlight-ink, error, focus
//               (hex; see CONTRAST below). accent is for actions and links; highlight is a decorative fill.
//   typography: display, headline, title, body, small, label  (fontFamily, fontSize, fontWeight, lineHeight)
//   rounded:    control, card
//   spacing:    gutter, section, content, prose  (content and prose are container widths)
// Two Framework B blocks set the skeleton and the imagery, not just the skin (both optional; defaults keep the
// original look). They are written to src/styles/design.json, which Base.astro and the sections read:
//   composition: align (left|center), density (airy|compact), separation (bands|hairlines|none),
//                cards (filled|outlined|flat), imageShape (rounded|square|full-bleed), motion (none|subtle|expressive),
//                phoneBudget (screens, the home page's maximum length on a 390 x 844 phone; the QA gate checks it)
//   imagery:     style (see IMAGERY_STYLES), secondary (optional), treatment (none|duotone|tint|warm|cool|mono),
//                grain (true|false), prompt (one line of art direction reused for every generated image)
// Extra tokens are allowed and exported too. Components (button-primary, button-secondary, ...) become classes
// in @layer components. Fonts must be installed Fontsource packages (self-hosted, OFL), for example
// `npm i @fontsource-variable/figtree`; the script imports the variable package when present.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const CHECK = process.argv.includes("--check");
const OUT = "src/styles/tokens.css";
const DESIGN_OUT = "src/styles/design.json";
const FONTS_OUT = "src/styles/fonts.js";
const REQUIRED = {
  colors: ["bg", "surface", "ink", "ink-muted", "line", "field", "accent", "accent-ink", "highlight", "highlight-ink", "error", "focus"],
  typography: ["display", "headline", "title", "body", "small", "label"],
  rounded: ["control", "card"],
  spacing: ["gutter", "section", "content", "prose"],
};
const FALLBACK = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

// 1. Lint with the official CLI. Errors stop the run; warnings are shown.
// The package exports no subpaths, so its CLI is run from node_modules directly.
const cli = "node_modules/@google/design.md/dist/index.js";
if (!existsSync(cli)) throw new Error("@google/design.md is not installed (npm ci)");
let report;
try {
  report = JSON.parse(execFileSync("node", [cli, "lint", "DESIGN.md"], { encoding: "utf8" }));
} catch (e) {
  report = JSON.parse(e.stdout || "{}");
}
const findings = report.findings || [];
for (const f of findings.filter((f) => f.severity !== "info")) console.log(`${f.severity.toUpperCase()}  ${f.path || ""} ${f.message}`);
if (!report.summary) throw new Error("design.md lint gave no report");
if (report.summary.errors) throw new Error(`DESIGN.md has ${report.summary.errors} lint error(s)`);

// 2. Parse the tokens and check the contract.
const text = readFileSync("DESIGN.md", "utf8");
const front = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!front) throw new Error("DESIGN.md has no YAML front matter");
const tokens = parse(front[1]);
const missing = Object.entries(REQUIRED).flatMap(([group, names]) => names.filter((n) => tokens[group]?.[n] === undefined).map((n) => `${group}.${n}`));
if (missing.length) throw new Error(`DESIGN.md is missing required tokens: ${missing.join(", ")}`);
for (const name of REQUIRED.typography) {
  for (const prop of ["fontFamily", "fontSize", "fontWeight", "lineHeight"]) {
    if (tokens.typography[name][prop] === undefined) throw new Error(`typography.${name}.${prop} is required`);
  }
}

// Composition and imagery (Framework B blocks). Every value is checked, so a typo fails here, not on the page.
const COMPOSITION = {
  align: ["left", "center"],
  density: ["airy", "compact"],
  separation: ["bands", "hairlines", "none"],
  cards: ["filled", "outlined", "flat"],
  imageShape: ["rounded", "square", "full-bleed"],
  motion: ["none", "subtle", "expressive"],
};
const COMPOSITION_DEFAULTS = { align: "left", density: "airy", separation: "bands", cards: "filled", imageShape: "rounded", motion: "none", phoneBudget: 6 };
const IMAGERY_STYLES = ["owner-photo", "documentary-stock", "photoreal-generated", "line-art", "flat-illustration", "watercolor", "3d", "isometric", "collage", "cartoon", "abstract", "icon-led"];
const TREATMENTS = ["none", "duotone", "tint", "warm", "cool", "mono"];
const composition = { ...COMPOSITION_DEFAULTS, ...(tokens.composition || {}) };
for (const [k, allowed] of Object.entries(COMPOSITION)) {
  if (!allowed.includes(composition[k])) throw new Error(`composition.${k} must be one of ${allowed.join(", ")} (got ${composition[k]})`);
}
if (!(Number(composition.phoneBudget) >= 2 && Number(composition.phoneBudget) <= 20)) throw new Error("composition.phoneBudget must be a number of screens from 2 to 20");
composition.phoneBudget = Number(composition.phoneBudget);
const imagery = { style: "owner-photo", treatment: "none", grain: false, prompt: "", ...(tokens.imagery || {}) };
for (const k of ["style", "secondary"]) if (imagery[k] !== undefined && !IMAGERY_STYLES.includes(imagery[k])) throw new Error(`imagery.${k} must be one of ${IMAGERY_STYLES.join(", ")}`);
if (!TREATMENTS.includes(imagery.treatment)) throw new Error(`imagery.treatment must be one of ${TREATMENTS.join(", ")}`);
const designJson = JSON.stringify({ composition, imagery }, null, 2) + "\n";

// WCAG 2.2 AA pairs the section library and forms rely on: text 4.5:1 (1.4.3), input borders and the focus
// ring 3:1 against what they sit on (1.4.11). "line" is decorative only and has no minimum.
const CONTRAST = [
  ["ink", "bg", 4.5], ["ink", "surface", 4.5], ["ink-muted", "bg", 4.5], ["ink-muted", "surface", 4.5],
  ["accent", "bg", 4.5], ["accent", "surface", 4.5], ["accent-ink", "accent", 4.5], ["highlight-ink", "highlight", 4.5], ["error", "bg", 4.5],
  ["field", "bg", 3], ["focus", "bg", 3], ["focus", "surface", 3],
];
const luminance = (hex) => {
  const m = String(hex).match(/^#([0-9a-f]{6})$/i);
  if (!m) throw new Error(`Contract colours must be #RRGGBB hex (got ${hex})`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const lowContrast = CONTRAST.map(([fg, bg, min]) => [fg, bg, min, ratio(tokens.colors[fg], tokens.colors[bg])]).filter(([, , min, r]) => r < min);
for (const [fg, bg, min, r] of lowContrast) console.log(`ERROR  colors.${fg} on colors.${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
if (lowContrast.length) throw new Error("DESIGN.md colours fail WCAG AA contrast");

const resolve = (value) =>
  typeof value === "string"
    ? value.replace(/\{([a-z0-9_.-]+)\}/gi, (_, path) => {
        const hit = path.split(".").reduce((o, k) => o?.[k], tokens);
        if (hit === undefined || typeof hit === "object") throw new Error(`Unresolved token reference {${path}}`);
        return resolve(hit);
      })
    : value;

// 3. Fonts: one CSS family per distinct fontFamily, each with a fallback stack and a self-hosted Fontsource import.
const slug = (family) => family.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const families = [...new Set(Object.values(tokens.typography).map((t) => t.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "")))];
const imports = [];
for (const family of families) {
  if (/^(system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif|serif|monospace)$/.test(family)) continue;
  const variable = `@fontsource-variable/${slug(family)}`;
  const fixed = `@fontsource/${slug(family)}`;
  const has = (pkg) => existsSync(`node_modules/${pkg}/package.json`);
  if (has(variable)) imports.push(variable);
  else if (has(fixed)) imports.push(fixed);
  else throw new Error(`Font "${family}" is not installed. Run: npm i ${variable}  (or ${fixed} if it has no variable version)`);
}
// The Latin files of the design's fonts, preloaded by Base.astro so a heading doesn't reflow (and push the hero
// image down) when its web font arrives after the first paint: a font-swap layout shift failed the CLS check
// on a preview (2026-10-27). Variable packages ship one file per subset; fixed ones one per weight.
const preload = [];
for (const pkg of imports) {
  const family = pkg.split("/")[1];
  const weights = [...new Set(Object.values(tokens.typography).filter((t) => slug(t.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "")) === family).map((t) => String(t.fontWeight || 400)))];
  const files = pkg.startsWith("@fontsource-variable/") ? [`${family}-latin-wght-normal.woff2`] : weights.map((w) => `${family}-latin-${w}-normal.woff2`);
  for (const f of files) if (existsSync(`node_modules/${pkg}/files/${f}`)) preload.push(`${pkg}/files/${f}`);
}
const fontsJs = [
  "// Generated from DESIGN.md by scripts/design-tokens.mjs. Do not edit: change DESIGN.md and run it again.",
  "// The design's Latin font files, preloaded by src/layouts/Base.astro.",
  ...preload.map((f, i) => `import f${i} from "${f}?url";`),
  `export default [${preload.map((_, i) => `f${i}`).join(", ")}];`,
  "",
].join("\n");

const stack = (fontFamily) => {
  const [first, ...rest] = fontFamily.split(",").map((s) => s.trim()).filter(Boolean);
  const name = first.replace(/^["']|["']$/g, "");
  const generic = rest.length ? rest.join(", ") : /serif/i.test(name) && !/sans/i.test(name) ? FALLBACK.serif : /mono/i.test(name) ? FALLBACK.mono : FALLBACK.sans;
  const fontsourceName = imports.find((p) => p.endsWith(`/${slug(name)}`))?.startsWith("@fontsource-variable/") ? `"${name} Variable", "${name}"` : `"${name}"`;
  return /^(system-ui|ui-)/.test(name) ? [first, ...(rest.length ? rest : [FALLBACK.sans])].join(", ") : `${fontsourceName}, ${generic}`;
};

// 4. Write tokens.css.
const lines = [];
const kebab = (k) => k.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
lines.push("/* Generated from DESIGN.md by scripts/design-tokens.mjs. Do not edit: change DESIGN.md and run it again. */");
lines.push('@import "tailwindcss";');
for (const pkg of imports) lines.push(`@import "${pkg}";`);
lines.push("", "@theme {");
lines.push("  /* Only the design's own colours exist: Tailwind's default palette is switched off. */");
lines.push("  --color-*: initial;");
for (const [name, value] of Object.entries(tokens.colors)) lines.push(`  --color-${name}: ${resolve(value)};`);
lines.push("");
lines.push(`  --font-display: ${stack(tokens.typography.display.fontFamily)};`);
lines.push(`  --font-body: ${stack(tokens.typography.body.fontFamily)};`);
lines.push("  --font-sans: var(--font-body);");
// A "<name>-mobile" typography token makes "<name>" fluid: it scales from the mobile size at a 360px viewport
// to the main size at 1280px, and stays within both (CSS clamp). Mobile tokens aren't exported on their own.
const px = (v) => (String(v).endsWith("rem") || String(v).endsWith("em") ? parseFloat(v) * 16 : parseFloat(v));
const fluid = (min, max) => {
  const [a, b] = [px(min), px(max)];
  if (a === b) return max;
  const slope = (b - a) / (1280 - 360);
  return `clamp(${a / 16}rem, ${((a - slope * 360) / 16).toFixed(4)}rem + ${(slope * 100).toFixed(4)}vw, ${b / 16}rem)`;
};
for (const [name, t] of Object.entries(tokens.typography)) {
  if (name.endsWith("-mobile") && tokens.typography[name.slice(0, -7)]) continue;
  const mobile = tokens.typography[`${name}-mobile`];
  lines.push(`  --text-${name}: ${mobile ? fluid(mobile.fontSize, t.fontSize) : t.fontSize};`);
  lines.push(`  --text-${name}--line-height: ${t.lineHeight};`);
  if (t.letterSpacing) lines.push(`  --text-${name}--letter-spacing: ${t.letterSpacing};`);
  lines.push(`  --text-${name}--font-weight: ${t.fontWeight};`);
}
lines.push("");
for (const [name, value] of Object.entries(tokens.rounded)) lines.push(`  --radius-${name}: ${value};`);
for (const [name, value] of Object.entries(tokens.spacing)) {
  if (name === "content" || name === "prose") lines.push(`  --container-${name}: ${value};`);
  else lines.push(`  --spacing-${name}: ${value};`);
}
lines.push("}", "");

// Each typography token's family, for elements that use it (headings use display; the rest use body).
lines.push("@layer base {");
lines.push("  html { font-family: var(--font-body); color: var(--color-ink); background: var(--color-bg); -webkit-text-size-adjust: 100%; }");
lines.push("  body { min-height: 100dvh; display: flex; flex-direction: column; }");
lines.push("  h1, h2, h3 { font-family: var(--font-display); text-wrap: balance; }");
lines.push("  p { text-wrap: pretty; }");
lines.push("  :focus-visible { outline: 3px solid var(--color-focus); outline-offset: 2px; }");
lines.push("  a { color: var(--color-accent); text-underline-offset: 0.15em; }");
lines.push("}", "");

const props = {
  backgroundColor: "background-color",
  textColor: "color",
  borderColor: "border-color",
  rounded: "border-radius",
  padding: "padding",
  height: "min-height",
  width: "width",
  size: "font-size",
};
const components = Object.entries(tokens.components || {});
if (components.length) {
  lines.push("@layer components {");
  for (const [name, spec] of components) {
    const m = name.match(/^(.*)-(hover|active|focus)$/);
    const selector = m ? `.${m[1]}:${m[2] === "focus" ? "focus-visible" : m[2]}` : `.${name}`;
    const decls = [];
    for (const [prop, raw] of Object.entries(spec)) {
      if (prop === "typography") {
        const ref = String(raw).match(/^\{typography\.([a-z0-9-]+)\}$/i)?.[1];
        if (!ref || !tokens.typography[ref]) throw new Error(`${name}.typography must reference a typography token`);
        const t = tokens.typography[ref];
        const useDisplay = t.fontFamily === tokens.typography.display.fontFamily && t.fontFamily !== tokens.typography.body.fontFamily;
        decls.push(`font-family: ${useDisplay ? "var(--font-display)" : "var(--font-body)"}`);
        decls.push(`font-size: var(--text-${ref})`, `line-height: var(--text-${ref}--line-height)`, `font-weight: var(--text-${ref}--font-weight)`);
        if (t.letterSpacing) decls.push(`letter-spacing: var(--text-${ref}--letter-spacing)`);
        continue;
      }
      const css = props[prop] || kebab(prop);
      const value = String(raw).replace(/^\{colors\.([a-z0-9-]+)\}$/i, "var(--color-$1)").replace(/^\{rounded\.([a-z0-9-]+)\}$/i, "var(--radius-$1)");
      decls.push(`${css}: ${resolve(value)}`);
    }
    lines.push(`  ${selector} { ${decls.join("; ")}; }`);
  }
  lines.push("}", "");
}

const css = lines.join("\n");
if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== css) throw new Error(`${OUT} is out of date with DESIGN.md. Run: node scripts/design-tokens.mjs`);
  const currentFonts = existsSync(FONTS_OUT) ? readFileSync(FONTS_OUT, "utf8") : "";
  if (currentFonts !== fontsJs) throw new Error(`${FONTS_OUT} is out of date with DESIGN.md. Run: node scripts/design-tokens.mjs`);
  const currentDesign = existsSync(DESIGN_OUT) ? readFileSync(DESIGN_OUT, "utf8") : "";
  if (currentDesign !== designJson) throw new Error(`${DESIGN_OUT} is out of date with DESIGN.md. Run: node scripts/design-tokens.mjs`);
  console.log(`${OUT}, ${FONTS_OUT} and ${DESIGN_OUT} match DESIGN.md`);
} else {
  writeFileSync(OUT, css);
  writeFileSync(FONTS_OUT, fontsJs);
  writeFileSync(DESIGN_OUT, designJson);
  console.log(`Wrote ${OUT} from DESIGN.md (${families.join(", ")})`);
}
