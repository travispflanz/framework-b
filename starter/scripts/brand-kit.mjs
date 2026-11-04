#!/usr/bin/env node
// The first brand kit, kept so its commands still work: its six layouts are now template concepts of the logo method
// (scripts/logo.mjs, docs/SPEC.md section 12, "Logo"), and they go through the same tests and make the same kit.
//
//   node scripts/brand-kit.mjs options [--icon <phosphor-name>] [--initials AB]
//       = node scripts/logo.mjs templates [...] && node scripts/logo.mjs sheet t1 t2 t3 t4 t5 t6
//   node scripts/brand-kit.mjs pick <1-6>
//       = node scripts/logo.mjs pick t<n>
//
// A template is the name in the display font. For a logo with an idea of its own, start with
// `node scripts/logo.mjs brief`.
import { execFileSync } from "node:child_process";

const [cmd, arg, ...rest] = process.argv.slice(2);
const run = (...a) => execFileSync(process.execPath, ["scripts/logo.mjs", ...a], { stdio: "inherit" });
if (cmd === "options") {
  run("templates", ...[arg, ...rest].filter((x) => x !== undefined));
  run("sheet", "t1", "t2", "t3", "t4", "t5", "t6");
} else if (cmd === "pick" && /^[1-6]$/.test(arg || "")) {
  run("pick", `t${arg}`);
} else {
  console.error("usage: node scripts/brand-kit.mjs options [--icon <phosphor-name>] [--initials AB]  |  pick <1-6>\n(or the logo method: node scripts/logo.mjs brief)");
  process.exit(2);
}
