// Tests the --ops half of scripts/docs-check.mjs on a copy of the template's callers in a temporary folder.
//   node --test scripts/docs-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(ROOT, "ops/ops-repo/.github/workflows");

// Runs the check on an ops repo made from the template, with `edit` applied to one caller's text (an edit that
// changes nothing fails the test) and `prepare` given the folder; the folder is removed whatever happens.
function check(file, edit, prepare) {
  const dir = mkdtempSync(join(tmpdir(), "docs-check-ops-"));
  try {
    const wf = join(dir, ".github/workflows");
    cpSync(TEMPLATE, wf, { recursive: true });
    if (file && edit) {
      const before = readFileSync(join(wf, file), "utf8");
      const after = edit(before);
      assert.notEqual(after, before, `the fixture's edit of ${file} changed it`);
      writeFileSync(join(wf, file), after);
    }
    if (prepare) prepare(wf);
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/docs-check.mjs"), "--ops", dir], { encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an ops repo made from the template passes", () => {
  const r = check();
  assert.equal(r.code, 0, r.out);
});

test("a dispatch input the template has and the ops caller dropped fails, and so does not passing it on", () => {
  const r = check("site-teardown.yml", (t) => t.split("\n").filter((l) => !/^\s+mail_domain:/.test(l)).join("\n"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /docs check: 2 problem\(s\)/);
  assert.match(r.out, /ops\/site-teardown\.yml: has no "mail_domain" input \(the template's site-teardown\.yml has it\)/);
  assert.match(r.out, /ops\/site-teardown\.yml: doesn't pass "mail_domain" to site-teardown\.yml/);
});

test("an input of the ops repo's own, beyond the template's, is allowed", () => {
  const r = check("site-teardown.yml", (t) => t.replace(/^(\s+)(site_id: \{.*)$/m, "$1$2\n$1note: { description: \"the owner's own note\", required: false, default: \"\" }"));
  assert.equal(r.code, 0, r.out);
});

test("a caller that calls another reusable workflow than the template's fails", () => {
  const r = check("site-park.yml", (t) => t.replace("workflows/site-park.yml@", "workflows/site-snapshot.yml@"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ops\/site-park\.yml: doesn't call site-park\.yml \(the template's site-park\.yml does\)/);
});

test("a template caller missing from the ops repo fails", () => {
  const r = check(null, null, (wf) => rmSync(join(wf, "site-park.yml")));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ops: has no "site park" workflow \(the template has site-park\.yml\)/);
});
