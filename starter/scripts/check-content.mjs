#!/usr/bin/env node
// Checks every page in src/content/ against the section library's schema (src/sections/schema.js): known
// section types, required fields, repeater sizes, select options, link and anchor formats, and form IDs that
// exist in site.config.json. It also checks the image credits ledger (design/credits.json): every image in public/
// or src/ has an entry with its source, and stock images name their creator, licence and link.
// The QA gate runs it; it also runs on its own: node scripts/check-content.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS } from "../src/sections/schema.js";
import { stripJsonc } from "./lib/jsonc.mjs";

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
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

// Pages: home.json is the home page; every other <slug>.json is /<slug> (src/pages/[page].astro).
const BUILT_IN = new Set(readdirSync("src/pages").map((f) => f.replace(/\.(astro|js|ts|md)$/, "")).filter((f) => !f.startsWith("[")));
for (const file of readdirSync("src/content").filter((f) => f.endsWith(".json"))) {
  const page = JSON.parse(readFileSync(join("src/content", file), "utf8"));
  const slug = file.replace(/\.json$/, "");
  if (slug !== "home") {
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) errors.push(`${file}: page file names are lowercase letters, digits and dashes (the name is the URL)`);
    if (BUILT_IN.has(slug)) errors.push(`${file}: /${slug} is already a page in src/pages/`);
    if (!page.title || typeof page.title !== "string") errors.push(`${file}: "title" is required (the browser tab and search result title)`);
  }
  if (page.description !== undefined && typeof page.description !== "string") errors.push(`${file}: "description" must be text`);
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
  });
  const anchors = (page.sections || []).map((s) => s.anchor_id).filter(Boolean);
  for (const s of page.sections || []) {
    for (const [k, v] of Object.entries(s)) {
      if (/_url$/.test(k) && typeof v === "string" && v.startsWith("#") && v.length > 1 && !anchors.includes(v.slice(1))) {
        errors.push(`${file} ${s._key}.${k} links to "${v}", which no section on the page has as its anchor_id`);
      }
    }
  }
}
// Image credits (docs/SPEC.md section 12: owner photos first, open-licensed second, generated only for abstraction).
const IMAGE = /\.(png|jpe?g|webp|avif|gif|svg|ico)$/i;
const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
const images = [...walk("public"), ...walk("src")].filter((f) => IMAGE.test(f)).map((f) => f.replace(/\\/g, "/"));
const ledger = existsSync("design/credits.json") ? JSON.parse(readFileSync("design/credits.json", "utf8")).images || [] : [];
const SOURCES = ["owner", "openverse", "stock", "generated", "framework"];
for (const file of images) if (!ledger.some((c) => c.file === file)) errors.push(`${file} has no entry in design/credits.json (source, licence, alt text)`);
for (const c of ledger) {
  const where = `design/credits.json ${c.file || "(no file)"}`;
  if (!c.file || !existsSync(c.file)) errors.push(`${where}: the file doesn't exist`);
  if (!SOURCES.includes(c.source)) errors.push(`${where}: source must be one of ${SOURCES.join(", ")}`);
  if (["openverse", "stock"].includes(c.source)) for (const k of ["creator", "license", "url"]) if (!c[k]) errors.push(`${where}: a ${c.source} image needs "${k}"`);
  if (c.source === "generated" && c.abstract !== true) errors.push(`${where}: a generated image must be abstract ("abstract": true); never people, premises or products`);
  if (typeof c.alt !== "string") errors.push(`${where}: "alt" is required ("" for a decorative image)`);
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
