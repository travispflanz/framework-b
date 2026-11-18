// Tests for the rules in scripts/design-critique.mjs. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ballotView, changedRegion, cropStack, decideBallots, DIMENSIONS, GAP, makeBallots, parseRubric, rubricPasses, rubricTemplate } from "../design-critique.mjs";

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

// A page screenshot as raw pixels: `height` rows of one grey, with the rows in `marks` ({ at, rows, value }) another.
const shot = (height, marks = [], width = 4) => {
  const data = Buffer.alloc(width * height * 4, 200);
  for (const m of marks) data.fill(m.value ?? 0, m.at * width * 4, (m.at + m.rows) * width * 4);
  return { data, width, height, channels: 4 };
};
const SCREEN = { screen: 900 };

test("a change low on the page is shown where it is, not as the first screen", () => {
  // The case found: a fix to the message box on a long contact page, far below the first screen.
  const region = changedRegion(shot(4000, [{ at: 2400, rows: 150, value: 10 }]), shot(4000, [{ at: 2400, rows: 150, value: 90 }]));
  assert.deepEqual(region, { top: 2400, before: 2550, after: 2550 });
  const view = ballotView(region, { ...SCREEN, beforeHeight: 4000, afterHeight: 4000 });
  assert.equal(view.view, "change");
  const [w] = view.crops.after;
  assert.ok(w.top <= 2400 && w.top + w.height >= 2550, "the window holds the whole change");
  assert.ok(w.top > 900, "and isn't the first screen");
  assert.deepEqual(view.crops.before, view.crops.after, "both sides show the same rows");
});

test("a change within the first screen is judged on the first screen, as calibrated", () => {
  const region = changedRegion(shot(3000, [{ at: 100, rows: 300 }]), shot(3000));
  assert.deepEqual(ballotView(region, { ...SCREEN, beforeHeight: 3000, afterHeight: 3000 }), { view: "first" });
  assert.equal(changedRegion(shot(3000), shot(3000)), null, "no change, no region");
});

test("a change that makes the page longer is one region, not everything below it", () => {
  // 200 rows inserted at row 1500: the rows below move down but are the same, so they are trimmed from the bottom.
  const before = shot(3000, [{ at: 2800, rows: 200, value: 50 }]);
  const after = shot(3200, [{ at: 1500, rows: 200, value: 120 }, { at: 3000, rows: 200, value: 50 }]);
  const region = changedRegion(before, after);
  assert.deepEqual(region, { top: 1500, before: 1500, after: 1700 });
  const view = ballotView(region, { ...SCREEN, beforeHeight: 3000, afterHeight: 3200 });
  assert.equal(view.view, "change");
  assert.equal(view.crops.after.length, 1);
});

test("two changes far apart are shown as the first and last screen of the change", () => {
  const region = changedRegion(shot(5000, [{ at: 300, rows: 50 }, { at: 4200, rows: 80 }]), shot(5000));
  const view = ballotView(region, { ...SCREEN, beforeHeight: 5000, afterHeight: 5000 });
  assert.equal(view.crops.before.length, 2);
  const [first, last] = view.crops.before;
  assert.ok(first.top <= 300 && first.top + first.height >= 350, "the first window holds the first change");
  assert.ok(last.top <= 4200 && last.top + last.height >= 4280, "the last window holds the last change");
  assert.equal(ballotView({ top: 0, before: 10, after: 10, unaligned: true }, { ...SCREEN, beforeHeight: 10, afterHeight: 10 }).view, "full");
});

test("a ballot side is cut from the full-page screenshot, windows stacked, grey past the end of the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-critique-"));
  try {
    const file = join(dir, "page.png");
    writeFileSync(file, await sharp({ create: { width: 40, height: 1000, channels: 4, background: "#ff0000" } }).png().toBuffer());
    const png = await cropStack(file, [{ top: 0, height: 300 }, { top: 900, height: 300 }]);
    const { width, height } = await sharp(png).metadata();
    assert.deepEqual([width, height], [40, 600 + GAP]);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const px = (y) => [...data.subarray((y * info.width) * info.channels, (y * info.width) * info.channels + 3)];
    assert.deepEqual(px(10), [255, 0, 0], "the first window");
    assert.deepEqual(px(300 + 5), [0x44, 0x44, 0x44], "the band between windows");
    assert.deepEqual(px(300 + GAP + 50), [255, 0, 0], "the second window");
    assert.deepEqual(px(300 + GAP + 200), [0x88, 0x88, 0x88], "past the end of the page");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ballots carry their view and windows, both ways round", () => {
  const view = { shot: "contact-1280", view: "change", crops: { before: [{ top: 2000, height: 900 }], after: [{ top: 2000, height: 900 }] } };
  const ballots = makeBallots([view, "home-390"], () => 0.5);
  assert.equal(ballots.length, 4);
  const two = ballots.filter((b) => b.shot === "contact-1280");
  assert.deepEqual(two.map((b) => b.left).sort(), ["after", "before"]);
  assert.ok(two.every((b) => b.view === "change" && b.crops.after[0].top === 2000));
});
