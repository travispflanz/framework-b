// Tests for the rules in scripts/design-judge.mjs. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeJudgeBallots, tallyBallots } from "../design-judge.mjs";

test("every pair is judged both ways round on the first screen and on the rest of the tile", () => {
  const ballots = makeJudgeBallots(["a", "b", "c"], { random: () => 0.5 });
  assert.equal(ballots.length, 12);
  for (const view of ["first", "rest"]) {
    for (const pair of [["a", "b"], ["a", "c"], ["b", "c"]]) {
      const two = ballots.filter((b) => b.view === view && [b.left, b.right].sort().join() === pair.join());
      assert.deepEqual(two.map((b) => b.left).sort(), pair, `${view} ${pair} both ways`);
    }
  }
  const short = makeJudgeBallots(["a", "b", "c"], { rest: (t) => t !== "c", random: () => 0.5 });
  assert.equal(short.filter((b) => b.view === "rest").length, 2, "only pairs whose tiles both have a rest get rest ballots");
});

const vote = (view, left, right, winner) => ({ id: `${view}${left}${right}`, view, left, right, answer: winner === left ? "LEFT" : "RIGHT" });
const both = (view, a, b, winner) => [vote(view, a, b, winner), vote(view, b, a, winner)];

test("the first screen decides; the rest of the tile can only stop a win", () => {
  // a wins the first screen both ways, the rest is split: a wins.
  let r = tallyBallots([...both("first", "a", "b", "a"), vote("rest", "a", "b", "a"), vote("rest", "b", "a", "b")]);
  assert.equal(r.pick, "a");
  assert.equal(r.matches[0].rest, "split");
  // a wins the first screen, b wins the rest both ways: a tie.
  r = tallyBallots([...both("first", "a", "b", "a"), ...both("rest", "a", "b", "b")]);
  assert.equal(r.matches[0].winner, "tie");
  assert.equal(r.matches[0].blocked, true);
  assert.deepEqual(r.tied.sort(), ["a", "b"]);
  // The rest alone never makes a win: a split first screen is a tie whatever the rest says.
  r = tallyBallots([vote("first", "a", "b", "a"), vote("first", "b", "a", "b"), ...both("rest", "a", "b", "a")]);
  assert.equal(r.matches[0].winner, "tie");
  assert.equal(r.matches[0].blocked, false);
});

test("ballots from before the rest view count as first-screen ballots", () => {
  const old = both("first", "a", "b", "b").map(({ view, ...b }) => b);
  const r = tallyBallots(old);
  assert.equal(r.pick, "b");
  assert.equal(r.matches[0].rest, "not judged");
  assert.throws(() => tallyBallots([{ ...old[0], answer: "" }]), /without a LEFT or RIGHT/);
});
