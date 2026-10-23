// What the framework owns in a site, and what each framework-owned file should contain for that site at a given
// framework commit. Used by scripts/site/update.mjs to bring a site up to a newer framework version.
//
// A site is a copy of starter/ plus a vendored copy of packages/core (in core/). Files fall into four groups:
//   site-owned   never touched by an update: brand, content, design contract, records, Cloudflare bindings
//   generated    rebuilt after an update from site-owned inputs: tokens.css, seed/, package-lock.json
//   package.json merged key by key (dependencies, devDependencies, scripts, emdash)
//   framework    everything else from starter/, plus core/: updated with a three-way merge
// With client editing on, a few framework files come from starter/editing/ instead, and the other pages get the
// `export const prerender = true;` line, exactly as scripts/editing.mjs installs them.
import { execFileSync } from "node:child_process";

export const SITE_OWNED = [
  /^site\.config\.json$/,
  /^wrangler\.jsonc$/,
  /^(DESIGN|PRODUCT|DECISIONS|HANDOFF|SECRETS|README)\.md$/,
  /^src\/content\//,
  /^public\//,
  /^\.githooks\//,
  /^framework\.lock\.json$/,
];
export const GENERATED = [/^src\/styles\/tokens\.css$/, /^seed\//, /^package-lock\.json$/];
const IGNORED = [/(^|\/)(node_modules|dist|\.astro|\.wrangler|qa-output)\//, /^core\//, /^\.dev\.vars$/];
// The overlay targets: with editing on, these come from starter/editing/<path>.
const OVERLAY = ["astro.config.mjs", "src/worker.js", "src/live.config.ts", "src/pages/index.astro"];

const isIn = (rules, path) => rules.some((re) => re.test(path));
export const classify = (path) =>
  isIn(SITE_OWNED, path) ? "site" : isIn(GENERATED, path) ? "generated" : path === "package.json" ? "package" : path.startsWith("core/") ? "core" : "framework";

export function framework(dir) {
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const show = (commit, path) => {
    try {
      return execFileSync("git", ["-C", dir, "show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const list = (commit, prefix) => git("ls-tree", "-r", "--name-only", commit, prefix).split("\n").filter(Boolean);
  const resolve = (ref) => git("rev-parse", ref).trim();

  // EmDash package pins at a commit: editing/packages.json, or (older commits) the constant in editing.mjs.
  function emdashPackages(commit) {
    const json = show(commit, "starter/editing/packages.json");
    if (json) return JSON.parse(json).dependencies;
    const src = show(commit, "starter/scripts/editing.mjs") || "";
    const block = src.match(/EMDASH_PACKAGES = \{([\s\S]*?)\};/)?.[1];
    if (!block) return {};
    return Object.fromEntries([...block.matchAll(/"?([@\w/.-]+)"?\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
  }

  // The framework-owned paths at a commit, as site paths, with how to render each.
  const cache = new Map();
  function paths(commit, editing) {
    const key = `${commit}:${editing}`;
    if (cache.has(key)) return cache.get(key);
    const out = new Map();
    cache.set(key, out);
    for (const p of list(commit, "starter/")) {
      const rel = p.slice("starter/".length);
      if (isIn(IGNORED, rel)) continue;
      if (classify(rel) !== "framework") continue;
      out.set(rel, { from: p });
    }
    if (editing) {
      for (const target of OVERLAY) {
        const src = `starter/editing/${target}`;
        if (show(commit, src) !== null) out.set(target, { from: src });
      }
    }
    for (const p of list(commit, "packages/core/")) {
      const rel = p.slice("packages/core/".length);
      if (/^(src|migrations)\//.test(rel) || rel === "README.md") out.set(`core/${rel}`, { from: p });
    }
    out.set("core/VERSION", { version: true });
    return out;
  }

  // The content a framework-owned file should have in this site at this commit (null when it doesn't exist).
  function render(commit, path, editing) {
    const entry = paths(commit, editing).get(path);
    if (!entry) return null;
    if (entry.version) return `${JSON.parse(show(commit, "packages/core/package.json")).version}\n`;
    let text = show(commit, entry.from);
    if (text === null) return null;
    const isOtherPage = path.startsWith("src/pages/") && !OVERLAY.includes(path);
    if (editing && isOtherPage && !/export const prerender/.test(text)) {
      if (path.endsWith(".astro")) text = text.replace(/^---\n/, "---\nexport const prerender = true;\n");
      else if (/\.(js|ts)$/.test(path)) text = `export const prerender = true;\n${text}`;
    }
    return text;
  }

  // package.json keys the framework manages, at a commit.
  function packageView(commit, editing) {
    const pkg = JSON.parse(show(commit, "starter/package.json"));
    const view = { dependencies: { ...(pkg.dependencies || {}) }, devDependencies: { ...(pkg.devDependencies || {}) }, scripts: { ...(pkg.scripts || {}) } };
    if (editing) {
      Object.assign(view.dependencies, emdashPackages(commit));
      view.emdash = { seed: "seed/seed.json" };
    }
    return view;
  }

  return { resolve, show, list, paths, render, packageView, emdashPackages };
}
