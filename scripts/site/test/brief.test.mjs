import { test } from "node:test";
import assert from "node:assert/strict";
import { createInputs, decisionRows, normalizeBrief, slug } from "../lib/brief.mjs";

test("a minimal brief gets every default, marked as default", () => {
  const { brief, sources, errors } = normalizeBrief({ business: { name: "Example Co" }, owner: { email: "Owner@Example.com" } });
  assert.deepEqual(errors, []);
  assert.equal(brief.business.id, "example-co");
  assert.equal(brief.owner.email, "owner@example.com");
  assert.equal(brief.mode, "idea");
  assert.equal(brief.shape, "landing");
  assert.deepEqual(brief.forms, [{ id: "contact", purpose: "contact" }]);
  assert.equal(brief.indexing, false);
  assert.equal(brief.editing, false);
  assert.equal(brief.design.autopilot, true);
  assert.equal(sources["business.name"], "stated");
  assert.equal(sources.indexing, "default");
  assert.equal(sources.shape, "default");
});

test("answers present are stated unless listed as inferred", () => {
  const { brief, sources } = normalizeBrief({
    business: { name: "Example Co", offer: "Clean bins at the curb." },
    owner: { email: "owner@example.com" },
    indexing: true,
    shape: "landing",
    design: { words: ["friendly", "trustworthy"] },
    inferred: ["shape", "business.offer"],
  });
  assert.equal(sources.indexing, "stated");
  assert.equal(sources.shape, "inferred");
  assert.equal(sources["business.offer"], "inferred");
  assert.equal(sources["design.words"], "stated");
  assert.deepEqual(createInputs(brief), { SITE_ID: "example-co", SITE_NAME: "Example Co", SITE_TAGLINE: "Clean bins at the curb.", OWNER_EMAIL: "owner@example.com", EDITING: "off", INDEXING: "on", CRM: "none" });
});

test("required answers and bad values are errors", () => {
  assert.ok(normalizeBrief({}).errors.some((e) => e.includes("business.name")));
  assert.ok(normalizeBrief({ business: { name: "X Co" } }).errors.some((e) => e.includes("owner.email")));
  const bad = normalizeBrief({ business: { name: "Example Co" }, owner: { email: "nope" }, shape: "blog", indexing: "yes" });
  assert.ok(bad.errors.some((e) => e.startsWith("owner.email")));
  assert.ok(bad.errors.some((e) => e.startsWith("shape")));
  assert.ok(bad.errors.some((e) => e.startsWith("indexing")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, mode: "launch" }).errors.some((e) => e.includes("step 9")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, claims: [{ text: "5-star" }] }).errors.some((e) => e.startsWith("claims")));
});

test("EU, newsletter-on-idea and CRM produce warnings, not errors", () => {
  const { errors, warnings } = normalizeBrief({ business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" }, audienceRegion: "EU", newsletter: true, crm: "webhook" });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes("GDPR")));
  assert.ok(warnings.some((w) => w.includes("subscriber collection only")));
  assert.ok(warnings.some((w) => w.includes("CRM_WEBHOOK_URL")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, crm: "hubspot" }).errors.some((e) => e.startsWith("crm")));
  assert.equal(createInputs(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, crm: "sheet" }).brief).CRM, "sheet");
});

test("decision rows record who decided each answer, and indexing as chosen", () => {
  const { brief, sources } = normalizeBrief({ business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" }, indexing: true, inferred: [] });
  const rows = decisionRows(brief, sources, "2026-10-26");
  assert.ok(rows.includes("| 2026-10-26 | Search engines: indexed | Kickoff | owner |"));
  assert.ok(rows.includes("| 2026-10-26 | Site shape: landing | Framework default | inferred |"));
});

test("slug makes a valid site id from a business name", () => {
  assert.equal(slug("Café & Bakery, Ltd."), "cafe-and-bakery-ltd");
  assert.equal(slug("  Example   Co  "), "example-co");
});
