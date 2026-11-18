// Tests for scripts/lib/fields.mjs: the field radius and the oval check. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldRadius, ovalField } from "../lib/fields.mjs";

test("the field radius is the smaller of the control and card radii, as one of DESIGN.md's values", () => {
  assert.equal(fieldRadius({ control: "999px", card: "16px" }), "16px", "pill buttons, card-radius fields");
  assert.equal(fieldRadius({ control: "6px", card: "8px" }), "6px", "the starter's: unchanged");
  assert.equal(fieldRadius({ control: "0px", card: "0px" }), "0px");
  assert.equal(fieldRadius({ control: "2rem", card: "12px" }), "12px", "rem is compared in px");
  assert.equal(fieldRadius({ control: 0, card: "4px" }), "0");
  assert.equal(fieldRadius({ control: "50%", card: "8px" }), "min(var(--radius-control), var(--radius-card))");
});

test("a multi-line field whose corners take more than two thirds of its height is an oval", () => {
  assert.equal(ovalField({ radius: 999, height: 146 }), true, "a pill radius on a message box");
  assert.equal(ovalField({ radius: 50, height: 146 }), true);
  assert.equal(ovalField({ radius: 48, height: 146 }), false);
  assert.equal(ovalField({ radius: 16, height: 146 }), false);
  assert.equal(ovalField({ radius: 0, height: 146 }), false);
  assert.equal(ovalField({ radius: 20, height: 0 }), false, "a hidden field is left alone");
});
