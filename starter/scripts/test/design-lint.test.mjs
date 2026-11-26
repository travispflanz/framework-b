// The design.md lint findings design-tokens.mjs prints (scripts/lib/design-lint.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shownFindings } from "../lib/design-lint.mjs";

const findings = [
  { severity: "warning", path: "colors", message: "No 'primary' color defined. The agent will auto-generate key colors, reducing your control over the palette." },
  { severity: "warning", path: "colors.line", message: "'line' is defined but never referenced by any component." },
  { severity: "warning", path: "typography.body", message: "Font size below 12px." },
  { severity: "error", path: "colors.accent", message: "'accent' is defined but never referenced by any component." },
  { severity: "info", path: "", message: "Summary" },
];

test("the two warnings every Framework B DESIGN.md triggers are not printed; other warnings and every error are", () => {
  assert.deepEqual(shownFindings(findings).map((f) => f.path), ["typography.body", "colors.accent"]);
  assert.deepEqual(shownFindings(findings, { all: true }).map((f) => f.path), ["colors", "colors.line", "typography.body", "colors.accent"]);
  assert.deepEqual(shownFindings(undefined), []);
});
