#!/usr/bin/env node
// Checks every page in src/content/ against the section library's schema (src/sections/schema.js): known
// section types, required fields, repeater sizes, select options, link and anchor formats, and form IDs that
// exist in site.config.json. It also checks the image credits ledger (design/credits.json): every image in public/
// or src/ has an entry with its source, and stock images name their creator, licence and link.
// The QA gate runs it; it also runs on its own: node scripts/check-content.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS } from "../src/sections/schema.js";
import { STEPS as AI_STEPS } from "../src/lib/ai-use.js";
import { stripJsonc } from "./lib/jsonc.mjs";
import { missingSections } from "./lib/style-guide.mjs";
import { FILE as RESEARCH, missingLenses, undatedLenses, unwrittenLenses } from "./lib/design-research.mjs";

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const design = existsSync("src/styles/design.json") ? JSON.parse(readFileSync("src/styles/design.json", "utf8")) : {};
const heroes = design.composition?.heroes;
const bySlug = Object.fromEntries(SECTIONS.map((s) => [s.slug, s.versions.at(-1).fields]));
const errors = [];

function checkFields(fields, value, where) {
  for (const f of fields) {
    const v = value[f.slug];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errors.push(`${where}.${f.slug} is required`);
      continue;
    }
    if (["string", "text"].includes(f.type) && typeof v !== "string") errors.push(`${where}.${f.slug} must be text`);
    if (f.type === "boolean" && typeof v !== "boolean") errors.push(`${where}.${f.slug} must be true or false`);
    const choices = f.options || f.validation?.options || [];
    if (f.type === "select" && !choices.includes(v)) errors.push(`${where}.${f.slug} "${v}" is not one of: ${choices.join(", ")}`);
    if (f.type === "image") {
      if (typeof v !== "object" || typeof v.src !== "string" || !v.src) errors.push(`${where}.${f.slug} must be { "src": "<file in src/assets/images>", "alt": "..." }`);
      else {
        if (!/^(https?:)?\/\//.test(v.src) && !existsSync(join("src/assets/images", v.src))) errors.push(`${where}.${f.slug}: src/assets/images/${v.src} doesn't exist`);
        if (typeof v.alt !== "string" || !v.alt.trim()) errors.push(`${where}.${f.slug}: "alt" is required; describe what the image shows`);
        // A focal point (Picture.astro): EmDash's media fields, shares of the width and height.
        for (const k of ["focalX", "focalY"]) if (k in v && v[k] !== null && !(typeof v[k] === "number" && v[k] >= 0 && v[k] <= 1)) errors.push(`${where}.${f.slug}.${k} must be a number from 0 to 1 (a share of the image's ${k === "focalX" ? "width, from the left" : "height, from the top"})`);
      }
    }
    if (f.validation?.pattern && typeof v === "string" && !new RegExp(f.validation.pattern).test(v)) errors.push(`${where}.${f.slug} "${v}" has the wrong format`);
    if (f.type === "repeater") {
      if (!Array.isArray(v)) {
        errors.push(`${where}.${f.slug} must be a list`);
        continue;
      }
      const { minItems = 0, maxItems = Infinity, subFields } = f.validation;
      if (v.length < minItems || v.length > maxItems) errors.push(`${where}.${f.slug} needs ${minItems}–${maxItems} items, has ${v.length}`);
      v.forEach((item, i) => checkFields(subFields, item, `${where}.${f.slug}[${i}]`));
    }
  }
  const known = new Set([...fields.map((f) => f.slug), "_type", "_key", "_version"]);
  for (const k of Object.keys(value)) if (!known.has(k)) errors.push(`${where}.${k} is not a field of this section`);
}

// Pages: home.json is the home page; every other <slug>.json is /<slug> (src/pages/[page].astro). privacy.json and
// not-found.json replace the generated privacy page and the 404 page with the owner's own words, and contact.json the
// plain contact page.
const REPLACES = { privacy: "privacy", "not-found": "404", contact: "contact" };
const BUILT_IN = new Set(readdirSync("src/pages").map((f) => f.replace(/\.(astro|js|ts|md)$/, "")).filter((f) => !f.startsWith("[")));
for (const file of readdirSync("src/content").filter((f) => f.endsWith(".json"))) {
  const page = JSON.parse(readFileSync(join("src/content", file), "utf8"));
  const slug = file.replace(/\.json$/, "");
  if (slug !== "home") {
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) errors.push(`${file}: page file names are lowercase letters, digits and dashes (the name is the URL)`);
    if (BUILT_IN.has(slug) && !REPLACES[slug]) errors.push(`${file}: /${slug} is already a page in src/pages/`);
    if (!page.title || typeof page.title !== "string") errors.push(`${file}: "title" is required (the browser tab and search result title)`);
  }
  if (page.description !== undefined && typeof page.description !== "string") errors.push(`${file}: "description" must be text`);
  if (page.noindex !== undefined && typeof page.noindex !== "boolean") errors.push(`${file}: "noindex" must be true or false`);
  if (!(page.sections || []).length) errors.push(`${file}: a page needs at least one section`);
  else if (page.sections[0]._type !== "fb_hero") errors.push(`${file}: the first section must be a hero (the page's only <h1>)`);
  const keys = new Set();
  (page.sections || []).forEach((section, i) => {
    const where = `${file} sections[${i}] (${section._type})`;
    const fields = bySlug[section._type];
    if (!fields) return errors.push(`${where}: unknown section type`);
    if (!section._key) errors.push(`${where}: _key is required`);
    else if (keys.has(section._key)) errors.push(`${where}: _key "${section._key}" is used twice`);
    keys.add(section._key);
    checkFields(fields, section, where);
    if (section._type === "fb_form" && !site.forms[section.form]) errors.push(`${where}.form "${section.form}" is not in site.config.json`);
    if (section._type === "fb_hero" && i !== 0) errors.push(`${where}: the hero must be the first section`);
    // One design language (SPEC section 12): a photo goes with the page's title, never in a bare band under it, and
    // every page's hero is the route's (composition.heroes in DESIGN.md); a hero with no picture may also be a
    // statement, which keeps the same title treatment.
    if (section._type === "fb_hero" && i === 0) {
      const hasImage = !!section.image?.src;
      const family = heroes ? (slug === "home" ? [heroes.home] : [].concat(heroes.page)) : null;
      if (section.variant === "statement" && hasImage) errors.push(`${where}: a statement hero takes no picture (a bare photo band under the title is not used); pick a layout that puts the photo with the title${family ? ` (this site's: ${family.join(", ")})` : " (split, full-bleed, editorial or bento)"}`);
      if (family && section.variant !== undefined && !family.includes(section.variant) && !(section.variant === "statement" && !hasImage)) {
        errors.push(`${where}: the hero layout is "${section.variant}", but this site's ${slug === "home" ? "home page uses" : "pages use one of"} ${family.map((v) => `"${v}"`).join(", ")} (composition.heroes in DESIGN.md); leave "variant" out to get "${family[0]}"`);
      }
    }
  });
  // Page flow (SPEC section 12): a content page ends the way the home page does, on the route's closing section;
  // a page with a form ends on the form, and thanks, privacy and 404 pages are left alone.
  const closing = design.composition?.closing;
  const sections = page.sections || [];
  if (closing && sections.length && !sections.some((s) => s._type === "fb_form") && !page.noindex && !["privacy", "not-found"].includes(slug) && sections[sections.length - 1]._type !== closing) {
    errors.push(`${file}: a content page ends on the route's closing section (${closing}, composition.closing in DESIGN.md), as the home page does; it ends on ${sections[sections.length - 1]._type}`);
  }
  const anchors = (page.sections || []).map((s) => s.anchor_id).filter(Boolean);
  for (const s of page.sections || []) {
    for (const [k, v] of Object.entries(s)) {
      if (/_url$/.test(k) && typeof v === "string" && v.startsWith("#") && v.length > 1 && !anchors.includes(v.slice(1))) {
        errors.push(`${file} ${s._key}.${k} links to "${v}", which no section on the page has as its anchor_id`);
      }
    }
  }
}
// Image credits (docs/SPEC.md section 12: owner photos first; open-licensed or generated images only as illustration).
const IMAGE = /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i;
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const images = [...walk("public"), ...walk("src")].filter((f) => IMAGE.test(f)).map((f) => f.replace(/\\/g, "/"));
const creditsFile = existsSync("design/credits.json") ? JSON.parse(readFileSync("design/credits.json", "utf8")) : {};
const ledger = creditsFile.images || [];
const SOURCES = ["owner", "openverse", "stock", "generated", "framework", "brand"];
for (const file of images) if (!ledger.some((c) => c.file === file)) errors.push(`${file} has no entry in design/credits.json (source, licence, alt text)`);
for (const c of ledger) {
  const where = `design/credits.json ${c.file || "(no file)"}`;
  if (!c.file || !existsSync(c.file)) errors.push(`${where}: the file doesn't exist`);
  if (!SOURCES.includes(c.source)) errors.push(`${where}: source must be one of ${SOURCES.join(", ")}`);
  if (["openverse", "stock"].includes(c.source)) for (const k of ["creator", "license", "url"]) if (!c[k]) errors.push(`${where}: a ${c.source} image needs "${k}"`);
  // Generated images are illustrative only: never the business's own people, premises, products, work or results.
  if (c.source === "generated" && c.abstract !== true && c.illustrative !== true) errors.push(`${where}: a generated image must be marked "illustrative": true (or "abstract": true); it may never show the business's own people, premises, products, work or results`);
  if (typeof c.alt !== "string") errors.push(`${where}: "alt" is required ("" for a decorative image)`);
  // What AI did with the image, for the Website assets page (src/lib/ai-use.js; the tools write it).
  if (c.ai !== undefined && (!Array.isArray(c.ai) || c.ai.some((s) => !AI_STEPS.includes(s)))) errors.push(`${where}: "ai" lists the steps AI took, from ${AI_STEPS.join(", ")}`);
}
if (ledger.some((c) => (Array.isArray(c.ai) && c.ai.length) || c.spot) && !creditsFile.aiBy) errors.push('design/credits.json: name the model that did the AI work on the images as "aiBy" (as --by names it for spot colour), for the Website assets page');

// The style guide (SPEC section 12, "Style guide"): every section heading, so the rendered guide is complete.
if (existsSync("STYLE-GUIDE.md")) {
  const missing = missingSections(readFileSync("STYLE-GUIDE.md", "utf8"));
  if (missing.length) errors.push(`STYLE-GUIDE.md is missing sections: ${missing.join(", ")} (the starter's STYLE-GUIDE.md has them all)`);
}

// Design research (SPEC section 12, "Four lenses"): the business, its field, current design and the site's own look.
// A missing lens fails; an unwritten or undated one is a note until the routes are drawn.
if (existsSync(RESEARCH)) {
  const md = readFileSync(RESEARCH, "utf8");
  const missing = missingLenses(md);
  if (missing.length) errors.push(`${RESEARCH} is missing lenses: ${missing.join(", ")} (the starter's ${RESEARCH} has all four)`);
  const todo = unwrittenLenses(md);
  if (todo.length) console.log(`  note  ${RESEARCH}: not written yet: ${todo.join(", ")} (docs/BUILD.md step 3)`);
  const undated = undatedLenses(md);
  if (undated.length) console.log(`  note  ${RESEARCH}: no dated source under ${undated.join(", ")}`);
}

// Drips (core src/drips.js) need their Workflow binding; without it, leads would silently get no emails.
if (site.drips) {
  const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));
  const bound = (wrangler.workflows || []).some((w) => w.binding === "DRIPS" && w.class_name === "DripWorkflow");
  if (!bound) errors.push(`site.config.json has "drips" but wrangler.jsonc has no Workflow binding: "workflows": [{ "name": "${site.site.id}-drips", "binding": "DRIPS", "class_name": "DripWorkflow" }]`);
}

if (errors.length) {
  console.error(errors.map((e) => `FAIL  ${e}`).join("\n"));
  process.exit(1);
}
console.log(`Content matches the section schema; ${images.length} image(s) credited`);
