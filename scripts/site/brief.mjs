#!/usr/bin/env node
// Checks a kickoff brief and prints what a build from it would do.
//
//   node scripts/site/brief.mjs check <brief.json>    errors, warnings, every answer with its source; exit 1 on errors
//   node scripts/site/brief.mjs inputs <brief.json>   the create inputs as JSON (for the ops repo's site create)
//
// Format and defaults: scripts/site/lib/brief.mjs. Runbook: docs/BUILD.md.
import { readFileSync } from "node:fs";
import { createInputs, normalizeBrief } from "./lib/brief.mjs";

const [cmd, file] = process.argv.slice(2);
if (!["check", "inputs"].includes(cmd) || !file) {
  console.error("usage: brief.mjs check|inputs <brief.json>");
  process.exit(2);
}
const { brief, sources, errors, warnings } = normalizeBrief(JSON.parse(readFileSync(file, "utf8")));
if (cmd === "inputs") {
  if (errors.length) {
    console.error(errors.map((e) => `error: ${e}`).join("\n"));
    process.exit(1);
  }
  console.log(JSON.stringify(createInputs(brief), null, 2));
  process.exit(0);
}
for (const e of errors) console.log(`error    ${e}`);
for (const w of warnings) console.log(`warning  ${w}`);
if (brief) for (const [path, source] of Object.entries(sources)) console.log(`${source.padEnd(8)} ${path} = ${JSON.stringify(path.split(".").reduce((v, k) => v?.[k], brief))}`);
console.log(errors.length ? `\n${errors.length} error(s)` : "\nBrief OK");
process.exit(errors.length ? 1 : 0);
