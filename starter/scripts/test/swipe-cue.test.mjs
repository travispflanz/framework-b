// The phone swipe cue's geometry (src/scripts/swipe-cue.js): bar length is the share on screen, position follows the
// scroll, the arrow flips at the end, and a strip that doesn't overflow shows nothing.
//   node --test scripts/test/swipe-cue.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cueState } from "../../src/scripts/swipe-cue.js";

test("the bar is as long as the share of the strip on screen and starts at the left", () => {
  const s = cueState({ scrollLeft: 0, scrollWidth: 1200, clientWidth: 300, track: 340 });
  assert.equal(s.overflow, true);
  assert.equal(s.width, 85);
  assert.equal(s.x, 0);
  assert.equal(s.atEnd, false);
});

test("it moves with the scroll and points back at the end", () => {
  const mid = cueState({ scrollLeft: 450, scrollWidth: 1200, clientWidth: 300, track: 340 });
  assert.equal(mid.x, Math.round((340 - 85) * 0.5));
  const end = cueState({ scrollLeft: 900, scrollWidth: 1200, clientWidth: 300, track: 340 });
  assert.equal(end.atEnd, true);
  assert.equal(end.x, 340 - 85);
});

test("a very long strip still gets a bar long enough to see, and overscroll is clamped", () => {
  const s = cueState({ scrollLeft: 5000, scrollWidth: 20000, clientWidth: 300, track: 340 });
  assert.equal(s.width, 32);
  assert.equal(cueState({ scrollLeft: -40, scrollWidth: 1200, clientWidth: 300, track: 340 }).x, 0);
  assert.equal(cueState({ scrollLeft: 9999, scrollWidth: 1200, clientWidth: 300, track: 340 }).x, 255);
});

test("nothing to scroll, nothing to show", () => {
  const s = cueState({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300, track: 340 });
  assert.equal(s.overflow, false);
  assert.equal(s.atEnd, false);
});
