#!/usr/bin/env node
// Brings a site up to a newer Framework B version, in the site's working tree (the caller commits on a branch
// and opens a pull request; production only changes when the owner merges it).
//
//   node scripts/site/update.mjs --site <site checkout> [--to <framework ref>] [--base <framework commit>]
//                                [--report <file.md>] [--no-install] [--dry-run]
//
// The framework checkout is this repo (--framework <dir> to use another); it needs full history.
// The site's starting point is framework.lock.json ({ framework: { commit } }), written by create.mjs and by
// every update. A site made before the lock existed needs --base <commit it was created from>.
//
// Framework-owned files (scripts/site/lib/framework-files.mjs) get a three-way merge between the version the
// site started from (base), the site's current file, and the new version:
//   unchanged in the site          → replaced by the new version (or removed if the framework removed it)
//   changed in the site only       → kept
//   changed in both                → merged with git merge-file; if the changes overlap, the site's file is
//                                    kept, the new version is written next to it as <file>.framework-new,
//                                    and the report says so
//   deleted in the site            → stays deleted
//   new in the framework           → added
// core/ is never edited in a site, so it is always replaced; a local edit there is reported.
// package.json is merged key by key the same way. Then (unless --no-install) it runs npm install, regenerates
// tokens.css and, with editing on, seed/seed.json, and checks the content. A changed EmDash content model is
// reported, because a deployed EmDash database keeps its model until it is migrated.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { framework } from "./lib/framework-files.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);
const FRAMEWORK = resolve(arg("framework", "") || join(dirname(fileURLToPath(import.meta.url)), "../.."));
const SITE = resolve(arg("site", "") || ".");
const DRY = flag("dry-run");
if (!existsSync(join(SITE, "site.config.json"))) throw new Error(`${SITE} is not a Framework B site (no site.config.json)`);

const fw = framework(FRAMEWORK);
const lockPath = join(SITE, "framework.lock.json");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
const base = fw.resolve(arg("base", "") || lock?.framework?.commit || "");
if (!base) throw new Error("No starting point: the site has no framework.lock.json; pass --base <framework commit it was created from>");
const next = fw.resolve(arg("to", "HEAD"));
const site = JSON.parse(readFileSync(join(SITE, "site.config.json"), "utf8"));
const editing = !!site.editing?.enabled;

const report = [];
const note = (path, action, detail = "") => report.push({ path, action, detail });
const readSite = (p) => (existsSync(join(SITE, p)) ? readFileSync(join(SITE, p), "utf8") : null);
const writeSite = (p, text) => {
  if (DRY) return;
  mkdirSync(dirname(join(SITE, p)), { recursive: true });
  writeFileSync(join(SITE, p), text);
};
const removeSite = (p) => DRY || rmSync(join(SITE, p), { force: true });

// git merge-file on three texts; returns { text, conflicts }.
function merge3(current, baseText, nextText) {
  const dir = mkdtempSync(join(tmpdir(), "fb-merge-"));
  const [c, b, n] = ["current", "base", "next"].map((f) => join(dir, f));
  writeFileSync(c, current);
  writeFileSync(b, baseText);
  writeFileSync(n, nextText);
  try {
    const text = execFileSync("git", ["merge-file", "-p", "-L", "site", "-L", "base", "-L", "framework", c, b, n], { encoding: "utf8" });
    return { text, conflicts: 0 };
  } catch (e) {
    if (typeof e.status === "number" && e.status > 0 && e.stdout) return { text: e.stdout, conflicts: e.status };
    throw e;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (base === next) {
  console.log(`Already on framework ${next.slice(0, 7)}.`);
} else {
  // 1. Framework-owned files, core included.
  const all = new Set([...fw.paths(base, editing).keys(), ...fw.paths(next, editing).keys()]);
  for (const path of [...all].sort()) {
    const b = fw.render(base, path, editing);
    const n = fw.render(next, path, editing);
    const cur = readSite(path);
    if (b === n) {
      if (cur !== null && cur !== n && path.startsWith("core/")) note(path, "core edited in the site", "left as is; the framework didn't change it");
      continue; // the framework didn't change it
    }
    if (path.startsWith("core/")) {
      if (cur !== null && cur !== b) note(path, "replaced a local edit", "core/ is never edited in a site");
      if (n === null) {
        removeSite(path);
        note(path, "removed");
      } else {
        writeSite(path, n);
        note(path, cur === null ? "added" : "updated");
      }
      continue;
    }
    if (cur === null) {
      if (b === null && n !== null) {
        writeSite(path, n);
        note(path, "added");
      } else if (n !== null) note(path, "kept deleted", "the site removed this file; the framework changed it");
      continue;
    }
    if (cur === n) continue; // already up to date
    if (cur === b) {
      if (n === null) {
        removeSite(path);
        note(path, "removed");
      } else {
        writeSite(path, n);
        note(path, "updated");
      }
      continue;
    }
    // Changed in the site too.
    if (n === null) {
      note(path, "kept", "the framework removed this file, but the site changed it");
      continue;
    }
    if (b === null) {
      writeSite(`${path}.framework-new`, n);
      note(path, "conflict", `the site and the framework both added this file; the framework's is in ${path}.framework-new`);
      continue;
    }
    const m = merge3(cur, b, n);
    if (m.conflicts === 0) {
      writeSite(path, m.text);
      note(path, "merged", "site changes kept, framework changes applied");
    } else {
      writeSite(`${path}.framework-new`, n);
      note(path, "conflict", `site and framework changed the same lines; kept the site's file, the framework's is in ${path}.framework-new`);
    }
  }

  // 2. package.json, key by key.
  const pkg = JSON.parse(readSite("package.json"));
  const pb = fw.packageView(base, editing);
  const pn = fw.packageView(next, editing);
  for (const section of ["dependencies", "devDependencies", "scripts"]) {
    const keys = new Set([...Object.keys(pb[section] || {}), ...Object.keys(pn[section] || {})]);
    pkg[section] = pkg[section] || {};
    for (const key of keys) {
      const [bv, nv, cv] = [pb[section]?.[key], pn[section]?.[key], pkg[section][key]];
      if (bv === nv || cv === nv) continue;
      if (cv === bv) {
        if (nv === undefined) delete pkg[section][key];
        else pkg[section][key] = nv;
        note(`package.json ${section}.${key}`, nv === undefined ? "removed" : bv === undefined ? "added" : "updated", `${bv ?? "—"} → ${nv ?? "—"}`);
      } else {
        note(`package.json ${section}.${key}`, "kept", `the site has ${cv ?? "nothing"}; the framework moved ${bv ?? "—"} → ${nv ?? "—"}`);
      }
    }
  }
  if (editing) pkg.emdash = pn.emdash;
  if (!DRY) writeFileSync(join(SITE, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
}

// 3. Regenerate and check, then record where the site now is.
const run = (cmd, args) => execFileSync(cmd, args, { cwd: SITE, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
let modelChanged = false;
if (!DRY && !flag("no-install") && base !== next) {
  const modelOf = () => {
    const seed = readSite("seed/seed.json");
    if (!seed) return null;
    const s = JSON.parse(seed);
    return JSON.stringify({ blockTypes: s.blockTypes, collections: s.collections });
  };
  const before = modelOf();
  run("npm", ["install", "--no-audit", "--no-fund"]);
  if (existsSync(join(SITE, "scripts/design-tokens.mjs"))) run("node", ["scripts/design-tokens.mjs"]);
  if (editing) run("node", ["scripts/editing.mjs", "seed"]);
  if (existsSync(join(SITE, "scripts/check-content.mjs"))) run("node", ["scripts/check-content.mjs"]);
  modelChanged = editing && before !== null && modelOf() !== before;
  if (modelChanged) note("seed/seed.json", "content model changed", "the deployed EmDash database keeps its current model until it is migrated");
}
if (!DRY) {
  const coreVersion = readSite("core/VERSION")?.trim();
  writeFileSync(lockPath, JSON.stringify({ framework: { repo: "framework-b", commit: next, coreVersion }, editing, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

// 4. Report.
const conflicts = report.filter((r) => r.action === "conflict");
const lines = [
  `Framework ${base.slice(0, 7)} → ${next.slice(0, 7)}${editing ? " (client editing on)" : ""}.`,
  "",
  conflicts.length ? `**${conflicts.length} file(s) need a person:** the site and the framework changed the same lines. Compare each with its \`.framework-new\` copy, keep what's right, delete the copy.` : "No conflicts.",
  modelChanged ? "\n**The EmDash content model changed.** The deployed content database keeps its old model until it is migrated; see the site's AGENTS.md." : "",
  "",
  "| File | What happened | Detail |",
  "|---|---|---|",
  ...report.map((r) => `| \`${r.path}\` | ${r.action} | ${r.detail} |`),
].filter((l, i, a) => !(l === "" && a[i - 1] === ""));
const md = lines.join("\n") + "\n";
if (arg("report")) writeFileSync(arg("report"), md);
console.log(md);
process.exit(conflicts.length ? 2 : 0);
