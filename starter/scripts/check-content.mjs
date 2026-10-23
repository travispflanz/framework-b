#!/usr/bin/env node
// Checks every page in src/content/ against the section library's schema (src/sections/schema.js): known
// section types, required fields, repeater sizes, select options, link and anchor formats, and form IDs that
// exist in site.config.json. The QA gate runs it; it also runs on its own: node scripts/check-content.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS } from "../src/sections/schema.js";

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
    if (f.type === "select" && !f.options.includes(v)) errors.push(`${where}.${f.slug} "${v}" is not one of: ${f.options.join(", ")}`);
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

for (const file of readdirSync("src/content").filter((f) => f.endsWith(".json"))) {
  const page = JSON.parse(readFileSync(join("src/content", file), "utf8"));
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
if (errors.length) {
  console.error(errors.map((e) => `FAIL  ${e}`).join("\n"));
  process.exit(1);
}
console.log("Content matches the section schema");
