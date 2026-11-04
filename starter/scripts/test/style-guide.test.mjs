// The style guide's parts (scripts/lib/style-guide.mjs, scripts/lib/style-guide-stamp.mjs): the sections the
// template must have, the prose renderer, the stamp and the cited specs.
//   node --test scripts/test/style-guide.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inline } from "../../src/sections/text.js";
import { missingSections, parseGuide, PLACEHOLDER, renderProse, REQUIRED, SPECS, unwritten } from "../lib/style-guide.mjs";
import { hash, staleInputs } from "../lib/style-guide-stamp.mjs";

test("the starter's template has every section, all still unwritten", () => {
  const md = readFileSync("STYLE-GUIDE.md", "utf8");
  assert.deepEqual(missingSections(md), []);
  assert.deepEqual(parseGuide(md).sections.map((s) => s.heading), REQUIRED);
  assert.deepEqual(unwritten(md), REQUIRED);
});

test("a written section counts; a missing one is named; comments are left out", () => {
  const md = `# Guide\n\n## Brand\n\n<!-- note to the agent -->\nFor people who make films.\n\n## Logo\n\n${PLACEHOLDER}\n`;
  const g = parseGuide(md);
  assert.equal(g.title, "Guide");
  assert.equal(g.sections[0].body, "For people who make films.");
  assert.deepEqual(unwritten(md), ["Logo"]);
  assert.ok(missingSections(md).includes("Colour"));
});

test("prose keeps to paragraphs, lists, subheadings and the site's inline formatting, and escapes the rest", () => {
  const html = renderProse("### Clear space\n\nKeep **one letter height** around it.\n\n- Never stretch it\n- Never outline it\n\n<script>x</script>", inline);
  assert.match(html, /<h3>Clear space<\/h3>/);
  assert.match(html, /<strong>one letter height<\/strong>/);
  assert.match(html, /<ul><li>Never stretch it<\/li><li>Never outline it<\/li><\/ul>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(renderProse("Three heroes:\n- One\n- Two", inline), "<p>Three heroes:</p><ul><li>One</li><li>Two</li></ul>", "a sentence that goes on into a list");
});

test("the stamp names the inputs that changed since the guide was rendered", () => {
  const inputs = { "DESIGN.md": "a", "STYLE-GUIDE.md": "b" };
  const stamp = { inputs: { "DESIGN.md": hash("a"), "STYLE-GUIDE.md": hash("old") } };
  assert.deepEqual(staleInputs(stamp, inputs), ["STYLE-GUIDE.md"]);
  assert.deepEqual(staleInputs(null, inputs), ["DESIGN.md", "STYLE-GUIDE.md"]);
});

test("every size and print setting names its source and when it was checked", () => {
  for (const s of SPECS) {
    assert.match(s.url, /^https:\/\//, s.use);
    assert.match(s.checked, /^\d{4}-\d{2}-\d{2}$/, s.use);
    assert.ok(s.source && s.spec, s.use);
  }
});
