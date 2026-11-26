// What the QA gate reads from PRODUCT.md (scripts/lib/product.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approvedClaims, ownerWording } from "../lib/product.mjs";
import { STARTER_ONLY } from "./in-site.mjs";

test("the starter's PRODUCT.md has every heading the QA gate reads, and approves nothing yet", { skip: STARTER_ONLY }, () => {
  const template = readFileSync(new URL("../../PRODUCT.md", import.meta.url), "utf8");
  for (const h of ["Facts from research", "Evidence on hand", "Owner's wording", "Approved claims"]) assert.match(template, new RegExp(`^## ${h}$`, "m"), h);
  // The template's notes are comments: they never approve a phrase or list one as the owner's.
  assert.equal(approvedClaims(template).trim(), "");
  assert.deepEqual(ownerWording(template), []);
});

test("each section runs to the next heading, and comments never count", () => {
  const md = `# Product\n\n## Approved claims\n\n<!-- trusted by -->\n- "120 reviews" (Evidence on hand: the owner's review page)\n\n## Owner's wording\n\n- "seamless"\n- Unlock your garden\n\n## Later\n\n- "not this"\n`;
  assert.ok(approvedClaims(md).includes("120 reviews"));
  assert.ok(!approvedClaims(md).includes("trusted by"));
  assert.ok(!approvedClaims(md).includes("seamless"));
  assert.deepEqual(ownerWording(md), ["seamless", "Unlock your garden"]);
  assert.equal(approvedClaims("# Product\n"), "");
});

test("a heading straight after another still ends the section", () => {
  // The first version dropped the newline before such a heading, so the next section ran on into this one.
  assert.ok(!approvedClaims(`## Approved claims\n## Evidence on hand\n- 4.9 stars from 120 reviews\n`).includes("120 reviews"));
  assert.deepEqual(ownerWording(`## Owner's wording\n## Approved claims\n- "seamless"\n`), []);
});

test("a section keeps its own subheadings, and its heading may be deeper or carry a date", () => {
  const md = `## Approved claims (2026-11-01)\n\n### From the owner\n\n- "120 reviews"\n\n## Owner's wording:\n\n- "seamless"\n`;
  assert.ok(approvedClaims(md).includes("120 reviews"));
  assert.ok(!approvedClaims(md).includes("seamless"));
  assert.deepEqual(ownerWording(md), ["seamless"]);
  assert.ok(approvedClaims(`# Product\n\n### Approved claims\n\n- "4.9 stars"\n\n### Later\n\n- "not this"\n`).includes("4.9 stars"));
  assert.ok(!approvedClaims(`# Product\n\n### Approved claims\n\n- "4.9 stars"\n\n### Later\n\n- "not this"\n`).includes("not this"));
  // A heading that only starts with the name is another section.
  assert.equal(approvedClaims(`## Approved claimsless\n\n- "4.9 stars"\n`), "");
});
