// Which @google/design.md lint findings scripts/design-tokens.mjs shows. Two warnings come on every run of a Framework
// B DESIGN.md and say nothing about the draft: the contract names its main colour `accent`, not `primary`, and the
// site uses every colour through tokens.css utilities, not through DESIGN.md's components, so "defined but never
// referenced by any component" holds for line, field, focus and the rest (seen on a test build, 2026-11-17).
export const KNOWN_NOISE = [/^No 'primary' color defined\b/, /is defined but never referenced by any component/];

// Findings to print: errors and warnings, without the known noise (`all` keeps it).
export function shownFindings(findings, { all = false } = {}) {
  return (findings || []).filter((f) => f.severity !== "info" && (all || f.severity === "error" || !KNOWN_NOISE.some((re) => re.test(f.message || ""))));
}
