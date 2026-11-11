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
//                phoneBudget (screens, the home page's maximum length on a 390 x 844 phone; the QA gate checks it),
//                logo (standard|large|masthead: the logo's size in the header; standard is as tall as the buttons, 48 px;
//                large is 56 px on phones and 72 px from tablet width; masthead puts it on its own row, as wide as the
//                content column), ornament (none|mark: with mark and a logo kit, the logo's mark, the favicon's shape,
//                sits before every eyebrow label), footer (wordmark|plain: with a logo, the footer ends on it across the
//                content width, or leaves it out),
//                titleCase (as-written|upper: every page's <h1>), heroes ({ home, page }: the hero layout of the home
//                page, and the family of layouts for every other page, one or a list, each one of this site's fb_hero
//                variants in src/sections/schema.js; a hero without a variant takes the first of the family, and
//                scripts/check-content.mjs holds every page to it), closing (the section type every content page
//                ends on, as the home page does, for example fb_cta; pages with a form end on the form)
//                titleFit (the display face's average capital width in em, 0.3 to 1, for the poster route's
//                panel titles that must never break inside a word; default 0.75, which suits the widest common faces;
//                measure it with `node scripts/logo.mjs measure "ABCDEFGHIJKLMNOPQRSTUVWXYZ"`: width / 26 / size,
//                plus a tenth)
//   imagery:     style (see IMAGERY_STYLES), secondary (optional), treatment (none|duotone|tint|warm|cool|mono),
//                grain (true|false), prompt (one line of art direction reused for every generated image)
// Optional colours for the poster route (docs/SPEC.md section 12, "The poster route"): scrim (what darkens a
// picture under text; default the darker of ink and bg), on-scrim and on-scrim-muted (text on it; default the lighter
// of ink and bg, and in a dark design ink-muted), poster and poster-ink (type-only poster cards; default accent and
// accent-ink), and the inverse set (inverse-bg, -surface, -ink, -ink-muted, -line, -field, -accent, -accent-ink:
// all eight or none) for a section whose tone is "inverse". Each is checked for contrast when it is used.
// Extra tokens are allowed and exported too. Components (button-primary, button-secondary, ...) become classes
// in @layer components. Fonts must be installed Fontsource packages (self-hosted, OFL), for example
// `npm i @fontsource-variable/figtree`; the script imports the variable package when present.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  logo: ["standard", "large", "masthead"],
  ornament: ["none", "mark"],
  footer: ["wordmark", "plain"],
};
const COMPOSITION_DEFAULTS = { align: "left", density: "airy", separation: "bands", cards: "filled", imageShape: "rounded", motion: "none", phoneBudget: 6, titleCase: "as-written", logo: "standard", ornament: "none", footer: "wordmark" };
const IMAGERY_STYLES = ["owner-photo", "documentary-stock", "photoreal-generated", "line-art", "flat-illustration", "watercolor", "3d", "isometric", "collage", "cartoon", "abstract", "icon-led"];
const TREATMENTS = ["none", "duotone", "tint", "warm", "cool", "mono"];
const composition = { ...COMPOSITION_DEFAULTS, ...(tokens.composition || {}) };
for (const [k, allowed] of Object.entries(COMPOSITION)) {
  if (!allowed.includes(composition[k])) throw new Error(`composition.${k} must be one of ${allowed.join(", ")} (got ${composition[k]})`);
}
if (!(Number(composition.phoneBudget) >= 2 && Number(composition.phoneBudget) <= 20)) throw new Error("composition.phoneBudget must be a number of screens from 2 to 20");
composition.phoneBudget = Number(composition.phoneBudget);
if (composition.titleFit !== undefined && !(Number(composition.titleFit) >= 0.3 && Number(composition.titleFit) <= 1)) throw new Error("composition.titleFit must be the display face's average capital width in em, from 0.3 to 1");
if (composition.titleFit !== undefined) composition.titleFit = Number(composition.titleFit);
// One design language (SPEC section 12): the title treatment and the hero layouts are part of the route, so every
// page, including the ones added later, gets them from here rather than from whoever writes the page.
if (!["as-written", "upper"].includes(composition.titleCase)) throw new Error(`composition.titleCase must be as-written or upper (got ${composition.titleCase})`);
if (composition.heroes !== undefined || composition.closing !== undefined) {
  const { VARIANTS, SECTION_TYPES } = await import(pathToFileURL(join(process.cwd(), "src/sections/schema.js")).href);
  if (composition.heroes !== undefined) {
    const heroes = composition.heroes;
    if (typeof heroes !== "object" || !heroes.home || !heroes.page) throw new Error("composition.heroes needs home and page, for example { home: split, page: [split, editorial] }");
    // Variety within one family: the inner pages may use several layouts, all from the route (SPEC section 12).
    const family = [].concat(heroes.page);
    if (!family.length) throw new Error("composition.heroes.page needs at least one layout");
    for (const v of [heroes.home, ...family]) if (!VARIANTS.fb_hero.includes(v)) throw new Error(`composition.heroes must name this site's hero layouts: ${VARIANTS.fb_hero.join(", ")} (got ${v})`);
    composition.heroes = { home: heroes.home, page: family };
  }
  if (composition.closing !== undefined && !SECTION_TYPES.includes(composition.closing)) throw new Error(`composition.closing must be one of this site's section types: ${SECTION_TYPES.join(", ")} (got ${composition.closing})`);
}
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
// The poster route's colours (see the header): derived when DESIGN.md doesn't name them, so the route works in any
// design, and checked like the rest. Text on a scrim block sits on the scrim at 62% over a photo; the QA gate measures
// the real picture (scripts/lib/image-text.mjs), so the pair here is the floor for a black-and-white photo's darkest
// part. In a dark design (ink lighter than bg) the scrim is bg and the text ink; in a light one the reverse.
const colors = { ...tokens.colors };
const darkDesign = luminance(colors.ink) > luminance(colors.bg);
const derived = {
  scrim: darkDesign ? colors.bg : colors.ink,
  "on-scrim": darkDesign ? colors.ink : colors.bg,
  "on-scrim-muted": darkDesign ? colors["ink-muted"] : colors.bg,
  poster: colors.accent,
  "poster-ink": colors["accent-ink"],
};
for (const [name, value] of Object.entries(derived)) if (colors[name] === undefined) colors[name] = value;
CONTRAST.push(["on-scrim", "scrim", 4.5], ["on-scrim-muted", "scrim", 4.5], ["poster-ink", "poster", 4.5]);
const INVERSE = ["inverse-bg", "inverse-surface", "inverse-ink", "inverse-ink-muted", "inverse-line", "inverse-field", "inverse-accent", "inverse-accent-ink"];
const inverseNamed = INVERSE.filter((n) => tokens.colors[n] !== undefined);
if (inverseNamed.length && inverseNamed.length < INVERSE.length) throw new Error(`DESIGN.md names some inverse colours but not ${INVERSE.filter((n) => !inverseNamed.includes(n)).join(", ")}: the inverse band needs all eight`);
if (inverseNamed.length) CONTRAST.push(["inverse-ink", "inverse-bg", 4.5], ["inverse-ink", "inverse-surface", 4.5], ["inverse-ink-muted", "inverse-bg", 4.5], ["inverse-ink-muted", "inverse-surface", 4.5], ["inverse-accent", "inverse-bg", 4.5], ["inverse-accent-ink", "inverse-accent", 4.5], ["inverse-field", "inverse-bg", 3]);
const lowContrast = CONTRAST.map(([fg, bg, min]) => [fg, bg, min, ratio(colors[fg], colors[bg])]).filter(([, , min, r]) => r < min);
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
for (const [name, value] of Object.entries(colors)) lines.push(`  --color-${name}: ${resolve(value)};`);
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
// The display face's average capital width (composition.titleFit), for the poster route's panel titles (sections.css).
if (composition.titleFit !== undefined) lines.push(`  :root { --title-fit: ${composition.titleFit}; }`);
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
