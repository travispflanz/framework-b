#!/usr/bin/env node
// Copies packages/core into a site (or the starter) as <target>/core, stamped with its version.
// Usage: node scripts/vendor-core.mjs <target-dir>
// Sites never depend on this repo at build time: they carry their own copy (see docs/DECISIONS.md).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/vendor-core.mjs <target-dir>");
  process.exit(1);
}
const src = join(root, "packages/core");
const dest = join(resolve(target), "core");
const { version } = JSON.parse(readFileSync(join(src, "package.json"), "utf8"));

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const part of ["src", "migrations", "README.md"]) cpSync(join(src, part), join(dest, part), { recursive: true });
writeFileSync(join(dest, "VERSION"), `${version}\n`);
console.log(`core ${version} → ${dest}`);
