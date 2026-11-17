// The live self-test's upload file (scripts/live-lead.mjs): the small default keeps its marker, and a large one is
// exactly the size asked for, starts with the same marker and has the same bytes on every run, so a stored copy can be
// checked by its SHA-256.
//   node --test scripts/test/live-lead.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { selftestFile } from "../live-lead.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");

test("the default file is the small marker PDF", () => {
  assert.equal(selftestFile(0).toString(), "%PDF-1.4\n% live self-test file\n");
});

test("a large file has the exact size, the marker and the same bytes every time", () => {
  const bytes = Math.round(9.5 * 1024 * 1024);
  const a = selftestFile(bytes);
  assert.equal(a.length, bytes);
  assert.ok(a.subarray(0, 40).toString("latin1").includes("% live self-test file"));
  assert.equal(sha(a), sha(selftestFile(bytes)));
  // Not a run of zeros: the body is hash blocks, so no byte value dominates.
  const counts = new Uint32Array(256);
  for (const v of a.subarray(1024, 1024 + 65536)) counts[v]++;
  assert.ok(Math.max(...counts) < 65536 / 64);
});

test("sizes that end mid-block are filled to the last byte", () => {
  const b = selftestFile(100);
  assert.equal(b.length, 100);
  assert.notEqual(b[99], 0);
});
