// Tests for the rules in scripts/design-critique.mjs. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideBallots, DIMENSIONS, makeBallots, parseRubric, rubricPasses, rubricTemplate } from "../design-critique.mjs";

const filled = (scores, tells = [], fixes = []) =>
  rubricTemplate(1, ["home-1280-first.png"])
    .replace(DIMENSIONS.map((d) => `- ${d}: `).join("\n"), DIMENSIONS.map((d, i) => `- ${d}: ${scores[i]}`).join("\n"))
    .replace("## Tells\n\n- \n", `## Tells\n\n${tells.map((t) => `- ${t}`).join("\n")}\n`)
    .replace("## Fixes\n\n1. \n", `## Fixes\n\n${fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}\n`);

test("the rubric is read back from the filled template", () => {
  const r = parseRubric(filled([4, 3, 4, 5, 4], ["centred everything"], ["src/content/home.json hero: shorter headline"]));
  assert.deepEqual(r.errors, []);
  assert.equal(r.scores["Subject-specificity"], 3);
  assert.deepEqual(r.tells, ["centred everything"]);
  assert.deepEqual(r.fixes, ["src/content/home.json hero: shorter headline"]);
  assert.equal(rubricPasses(r), false, "a 3 fails");
  assert.equal(rubricPasses(parseRubric(filled([4, 4, 4, 5, 4], ["one tell"]))), true, "all 4+ and one tell passes");
  assert.equal(rubricPasses(parseRubric(filled([5, 5, 5, 5, 5], ["a", "b"]))), false, "two tells fail");
});

test("blank scores and too many fixes are errors", () => {
  assert.match(parseRubric(rubricTemplate(1, [])).errors.join("\n"), /Hierarchy and clarity" must be a whole number/);
  assert.match(parseRubric(filled([4, 4, 4, 4, 4], [], ["a", "b", "c", "d"])).errors.join("\n"), /at most 3 fixes/);
});

test("every changed screen is judged both ways round", () => {
  const ballots = makeBallots(["home-1280-first.png", "home-390-first.png"], () => 0.5);
  assert.equal(ballots.length, 4);
  for (const shot of ["home-1280-first.png", "home-390-first.png"]) {
    const two = ballots.filter((b) => b.shot === shot);
    assert.deepEqual(two.map((b) => b.left).sort(), ["after", "before"]);
  }
});

test("a revision is kept only if it wins both ways round on every changed screen", () => {
  const vote = (shot, leftAfter, answer) => ({ id: "x", shot, left: leftAfter ? "after" : "before", right: leftAfter ? "before" : "after", answer });
  const win = [vote("a", true, "LEFT"), vote("a", false, "RIGHT"), vote("b", true, "left"), vote("b", false, "RIGHT")];
  assert.equal(decideBallots(win).accepted, true);
  const split = [vote("a", true, "LEFT"), vote("a", false, "LEFT"), vote("b", true, "LEFT"), vote("b", false, "RIGHT")];
  const d = decideBallots(split);
  assert.equal(d.accepted, false);
  assert.deepEqual(d.perShot, [{ shot: "a", result: "split" }, { shot: "b", result: "after" }]);
  assert.throws(() => decideBallots([vote("a", true, "")]), /without a LEFT or RIGHT/);
  assert.equal(decideBallots([]).accepted, false, "no changed screen is not an improvement");
});
