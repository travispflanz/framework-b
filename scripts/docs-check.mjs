#!/usr/bin/env node
// Checks that the docs still match the repo, so a rename or a removed script can't leave a doc pointing at nothing.
//
//   node scripts/docs-check.mjs                      this repo
//   node scripts/docs-check.mjs --ops <dir>          also an ops repo's caller workflows (a private clone)
//
// What it checks:
//   1. Every path in backticks in a Markdown file exists (relative to the repo root, the file's folder, or
//      `starter/` for the site docs that ship in the starter). Placeholders (`<id>`), URL paths (`/admin`) and
//      globs are skipped; a glob's folder must exist.
//   2. Every `node <script>` and `npm run <script>` named in a doc exists.
//   3. Every ops workflow named in a doc (`site create`, **site update**, ...) is a caller in ops/ops-repo.
//   4. Every caller in ops/ops-repo (and --ops) uses a reusable workflow that exists, passes only inputs it declares
//      and every input it requires; every reusable site workflow has a caller in the template.
//   5. The core version in packages/core/README.md is CORE_VERSION.
// docs/research/ is a dated record of past research and is not checked.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const opsArg = process.argv.indexOf("--ops");
const OPS = opsArg > 0 ? resolve(process.argv[opsArg + 1]) : null;
const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const basenames = new Set(tracked.map((f) => f.split("/").pop()));
// Existence is checked against tracked files, so a local build output or vendored copy can't hide a missing file.
const trackedExists = (p) => {
  const clean = p.replace(/^\.\//, "").replace(/\/+$/, "");
  return clean === "" || tracked.includes(clean) || tracked.some((f) => f.startsWith(`${clean}/`));
};
const mdFiles = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
  .split("\n").filter((f) => f && !f.startsWith("docs/research/") && !f.includes("node_modules/"));

// --- workflows -------------------------------------------------------------------------------------------------
// The workflows are plain block YAML, so a small indentation reader is enough (no dependency to install in CI).
const indent = (l) => l.match(/^ */)[0].length;
function block(lines, start) {
  const out = [];
  const base = indent(lines[start]);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "" || lines[i].trim().startsWith("#")) continue;
    if (indent(lines[i]) <= base) break;
    out.push(lines[i]);
  }
  return out;
}
const childKeys = (body) => {
  if (!body.length) return [];
  const d = Math.min(...body.map(indent));
  return body.filter((l) => indent(l) === d).map((l) => l.trim().match(/^([\w-]+):/)?.[1]).filter(Boolean);
};
function reusableInputs(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const wc = lines.findIndex((l) => /^\s+workflow_call:/.test(l));
  if (wc < 0) return null;
  const body = block(lines, wc);
  const at = lines.indexOf(body.find((l) => /^\s+inputs:/.test(l)));
  if (at < 0) return { all: [], required: [] };
  const inner = block(lines, at);
  const d = Math.min(...inner.map(indent));
  const all = [];
  const required = [];
  for (let i = 0; i < inner.length; i++) {
    if (indent(inner[i]) !== d) continue;
    const name = inner[i].trim().match(/^([\w-]+):/)[1];
    all.push(name);
    const rest = [inner[i], ...inner.slice(i + 1).filter((l, j, a) => a.slice(0, j + 1).every((x) => indent(x) > d))].join(" ");
    if (/required:\s*true/.test(rest) && !/default:/.test(rest)) required.push(name);
  }
  return { all, required };
}
function callers(dir) {
  const wf = join(dir, ".github/workflows");
  if (!existsSync(wf)) return [];
  return readdirSync(wf).filter((f) => f.endsWith(".yml")).map((f) => {
    const text = readFileSync(join(wf, f), "utf8");
    const lines = text.split("\n");
    const name = text.match(/^name:\s*(.+)$/m)?.[1].trim();
    const calls = [];
    lines.forEach((l, i) => {
      const m = l.match(/uses:\s*[\w.-]+\/framework-b\/\.github\/workflows\/([\w.-]+\.yml)@/);
      if (!m) return;
      const w = lines.slice(i + 1).findIndex((x) => /^\s+with:/.test(x));
      const withAt = w < 0 ? -1 : i + 1 + w;
      const withKeys = withAt > 0 && indent(lines[withAt]) === indent(l) ? childKeys(block(lines, withAt)) : [];
      calls.push({ workflow: m[1], with: withKeys });
    });
    return { file: f, name, calls };
  });
}
const reusableDir = join(ROOT, ".github/workflows");
function checkCallers(dir, label) {
  const list = callers(dir);
  for (const c of list) {
    for (const call of c.calls) {
      const target = join(reusableDir, call.workflow);
      if (!existsSync(target)) { fail(`${label}/${c.file}`, `calls ${call.workflow}, which doesn't exist`); continue; }
      const inputs = reusableInputs(target);
      if (!inputs) { fail(`${label}/${c.file}`, `${call.workflow} is not a reusable workflow`); continue; }
      for (const k of call.with) if (!inputs.all.includes(k)) fail(`${label}/${c.file}`, `passes "${k}", which ${call.workflow} doesn't declare`);
      for (const k of inputs.required) if (!call.with.includes(k)) fail(`${label}/${c.file}`, `doesn't pass "${k}", which ${call.workflow} requires`);
    }
  }
  return list;
}
const template = checkCallers(join(ROOT, "ops/ops-repo"), "ops/ops-repo");
if (OPS) {
  const ops = checkCallers(OPS, "ops");
  for (const t of template) if (!ops.some((o) => o.name === t.name)) fail("ops", `has no "${t.name}" workflow (the template has ${t.file})`);
}
const workflowNames = new Set(template.map((t) => t.name));
for (const f of readdirSync(reusableDir)) {
  if (!reusableInputs(join(reusableDir, f))) continue;
  if (!template.some((t) => t.calls.some((c) => c.workflow === f))) fail("ops/ops-repo", `no caller for the reusable workflow ${f}`);
}

// --- Markdown ---------------------------------------------------------------------------------------------------
const npmScripts = (dir) => {
  try { return Object.keys(JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).scripts || {}); } catch { return []; }
};
const FILEISH = /^(\.{0,2}\/)?([\w@.-]+\/)*[\w@.-]+\.(m?js|json|jsonc|md|ya?ml|sql|astro|ts|gs|css|sh|py)$|^([\w@.-]+\/)+$|^(\.?[\w-]+\/)+[\w.-]+$/;
for (const md of mdFiles) {
  const text = readFileSync(join(ROOT, md), "utf8").replace(/```[\s\S]*?```/g, (b) => b.replace(/`/g, ""));
  const here = dirname(md);
  const isSiteDoc = md.startsWith("starter/");
  const bases = ["", here === "." ? "" : here, "starter"];
  const existsIn = (b, p) => trackedExists(b ? `${b}/${p}` : p);
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  for (const span of spans) {
    // 1. paths
    const first = span.split(/\s+/)[0];
    if (span === first && FILEISH.test(span) && !/[<>{}$]/.test(span) && !span.startsWith("/") && !span.startsWith("@") && !/^(build|framework|feat|fix|docs)\/[\w-]+$/.test(span) && !/^[\w-]+\.(com|dev|workers\.dev)/.test(span)) {
      const p = span.replace(/^\.\//, "");
      const generated = /^(dist|qa-output|design\/(tiles|judge|pairs|critique|drafts|brand|generated)|node_modules|\.wrangler|\.dev\.vars|newsletter|seed|core|design\/sitemap\.md|editing\/static|src\/assets\/images|\.impeccable)\b/.test(p) ||
        /(^|\/)(brief\.json|adopt\.json|ballot\.json|park\.json|intake\.json|pairs\.json|state\.json|framework\.lock\.json|tokens\.css|credits\.json|live\.config\.ts|\.dev\.vars(\.example)?|home\.json)$/.test(p);
      // A bare file name ("editing.mjs") is shorthand for a file somewhere in the repo.
      const ok = generated || (!p.includes("/") && basenames.has(p)) || bases.some((b) => existsIn(b, p.replace(/\*.*$/, "")));
      // Site docs name files that exist only in a site (made by create or by the agent); the list above covers them.
      if (!ok && !(isSiteDoc && /^(src|public|design|scripts)\//.test(p) && trackedExists(`starter/${p.split("/")[0]}`))) fail(md, `\`${span}\` doesn't exist`);
    }
    // 2. scripts
    const node = span.match(/^node (\S+\.m?js)/);
    if (node && !/[<>]/.test(node[1]) && !bases.some((b) => existsIn(b, node[1]))) fail(md, `\`${span}\`: ${node[1]} doesn't exist`);
    const npm = span.match(/^npm run ([\w:-]+)/);
    if (npm) {
      const known = [...npmScripts("starter"), ...npmScripts("packages/core"), ...npmScripts(here), ...npmScripts("ops/backup-worker")];
      if (!known.includes(npm[1])) fail(md, `\`${span}\`: no npm script "${npm[1]}"`);
    }
  }
  // 3. ops workflow names
  for (const m of text.matchAll(/(?:\*\*|`)((?:site|deploy|verify) [a-z][a-z ]*?)(?:\*\*|`)/g)) {
    if (!workflowNames.has(m[1])) fail(md, `names the ops workflow "${m[1]}", which ops/ops-repo doesn't have`);
  }
}

// 5. core version
const coreVersion = readFileSync(join(ROOT, "packages/core/src/index.js"), "utf8").match(/CORE_VERSION\s*=\s*"([\d.]+)"/)?.[1];
const readmeVersion = readFileSync(join(ROOT, "packages/core/README.md"), "utf8").match(/Version `([\d.]+)`/)?.[1];
if (coreVersion !== readmeVersion) fail("packages/core/README.md", `says version ${readmeVersion}, CORE_VERSION is ${coreVersion}`);

if (problems.length) {
  console.error(`docs check: ${problems.length} problem(s)\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`docs check: ${mdFiles.length} Markdown files and ${template.length} ops callers${OPS ? " (and the ops repo)" : ""} are consistent`);
