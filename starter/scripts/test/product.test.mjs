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
