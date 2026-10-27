// Tests for the pure parts of scripts/design-pairs.mjs. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPairs, withPick } from "../design-pairs.mjs";

const pair = (id, a, b, recommended = "a") => ({ id, question: `${id}?`, recommended, a: { label: "A", ...a }, b: { label: "B", ...b } });
const good = {
  pairs: [
    pair("type", { display: "Lora" }, { display: "Figtree" }),
    pair("palette", { colors: { accent: "#1d5c3a" } }, { colors: { accent: "#9a3b16" } }, "b"),
    pair("imagery", { imagery: "photo", image: "porch.jpg" }, { imagery: "type-only" }),
    pair("density", { density: "airy" }, { density: "compact", radius: 0 }),
  ],
};

test("a good set of pairs passes", () => {
  assert.deepEqual(checkPairs(good), []);
});

test("bad pairs are refused with reasons", () => {
  assert.match(checkPairs({ pairs: good.pairs.slice(0, 3) }).join("\n"), /4 to 6 pairs/);
  const bad = structuredClone(good);
  bad.pairs[0].a.display = "Inter";
  bad.pairs[1].b = { label: "B", vibe: "bold" };
  bad.pairs[2].a = { label: "A", imagery: "photo" };
  bad.pairs[3].id = "type";
  bad.pairs[3].recommended = "c";
  const errors = checkPairs(bad).join("\n");
  assert.match(errors, /"Inter" is a font the QA gate bans/);
  assert.match(errors, /palette\)\.b\.vibe: unknown/);
  assert.match(errors, /imagery "photo" needs an image/);
  assert.match(errors, /duplicate id/);
  assert.match(errors, /recommended must be "a" or "b"/);
});

test("picks are recorded with who made them", () => {
  let intake = withPick({}, good, "palette", "a", "owner");
  intake = withPick(intake, good, "type", "a", "inferred");
  assert.deepEqual(intake.pairs.palette, { question: "palette?", pick: "a", label: "A", chosen: good.pairs[1].a, by: "owner" });
  assert.equal(intake.pairs.type.by, "inferred");
  assert.throws(() => withPick(intake, good, "nope", "a", "owner"), /no pair "nope"/);
  assert.throws(() => withPick(intake, good, "type", "x", "owner"), /pick "a" or "b"/);
});
