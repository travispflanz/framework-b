// Tests for scripts/site/update.mjs on throwaway git repos: a tiny framework with two versions, and a site
// copied from the first. Run: node --test scripts/site/test/
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const UPDATE = join(dirname(fileURLToPath(import.meta.url)), "../update.mjs");
const write = (root, files) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    if (text === null) rmSync(join(root, p), { force: true });
    else writeFileSync(join(root, p), text);
  }
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const lines = (...l) => l.join("\n") + "\n";

function setup({ editing = false } = {}) {
  const fw = mkdtempSync(join(tmpdir(), "fw-"));
  git(fw, "init", "-q", "-b", "main");
  git(fw, "config", "user.email", "t@example.com");
  git(fw, "config", "user.name", "t");
  const v1 = {
    "starter/package.json": JSON.stringify({ name: "s", dependencies: { astro: "1.0.0" }, devDependencies: { tool: "1.0.0" }, scripts: { build: "astro build" } }),
    "starter/site.config.json": JSON.stringify({ site: { name: "Example Co" } }),
    "starter/src/content/home.json": "{}",
    "starter/scripts/a.mjs": lines("// a", "one", "two", "three", "four", "five", "six"),
    "starter/scripts/b.mjs": lines("// b", "same line"),
    "starter/scripts/c.mjs": lines("// c"),
    "starter/src/pages/index.astro": lines("---", "// static home", "---", "<p>home</p>"),
    "starter/src/pages/thanks.astro": lines("---", "// thanks", "---", "<p>thanks</p>"),
    "starter/src/pages/privacy.astro": lines("---", "// privacy", "---", "<p>privacy</p>"),
    "starter/editing/src/pages/index.astro": lines("---", "// editing home", "---", "<p>home</p>"),
    "starter/editing/packages.json": JSON.stringify({ dependencies: { emdash: "1.0.0" } }),
    "packages/core/package.json": JSON.stringify({ version: "0.1.0" }),
    "packages/core/src/index.js": "export const v = 1;\n",
    "packages/core/README.md": "core\n",
  };
  write(fw, v1);
  git(fw, "add", "-A");
  git(fw, "commit", "-q", "-m", "v1");
  const c1 = git(fw, "rev-parse", "HEAD");

  // The site: starter v1 as installed, with core vendored.
  const site = mkdtempSync(join(tmpdir(), "site-"));
  for (const [p, text] of Object.entries(v1)) {
    if (p.startsWith("starter/")) write(site, { [p.slice(8)]: text });
  }
  write(site, { "core/src/index.js": v1["packages/core/src/index.js"], "core/README.md": "core\n", "core/VERSION": "0.1.0\n" });
  if (editing) {
    write(site, {
      "src/pages/index.astro": v1["starter/editing/src/pages/index.astro"],
      "src/pages/thanks.astro": lines("---", "export const prerender = true;", "// thanks", "---", "<p>thanks</p>"),
      "src/pages/privacy.astro": lines("---", "export const prerender = true;", "// privacy", "---", "<p>privacy</p>"),
      "site.config.json": JSON.stringify({ site: { name: "Example Co" }, editing: { enabled: true } }),
      "package.json": JSON.stringify({ name: "s", dependencies: { astro: "1.0.0", emdash: "1.0.0" }, devDependencies: { tool: "1.0.0" }, scripts: { build: "astro build" }, emdash: { seed: "seed/seed.json" } }),
    });
  }
  write(site, { "framework.lock.json": JSON.stringify({ framework: { commit: c1 } }) });
  return { fw, site, v1 };
}

function release(fw, files) {
  write(fw, files);
  git(fw, "add", "-A");
  git(fw, "commit", "-q", "-m", "v2");
}

const update = (fw, site) => {
  try {
    return { code: 0, out: execFileSync("node", [UPDATE, "--site", site, "--framework", fw, "--no-install"], { encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status, out: e.stdout };
  }
};

test("three-way update of a static site", () => {
  const { fw, site, v1 } = setup();
  // The site's own changes.
  write(site, {
    "scripts/a.mjs": lines("// a, edited by the site", "one", "two", "three", "four", "five", "six"),
    "scripts/b.mjs": lines("// b", "site's line"),
    "src/pages/thanks.astro": null,
    "src/content/home.json": '{"mine":true}',
    "package.json": JSON.stringify({ name: "s", dependencies: { astro: "1.0.0", extra: "2.0.0" }, devDependencies: { tool: "1.0.0" }, scripts: { build: "astro build", mine: "x" } }),
    "core/src/index.js": "export const v = 1; // hacked\n",
  });
  release(fw, {
    "starter/scripts/a.mjs": lines("// a", "one", "two", "three", "four", "five", "six, improved"),
    "starter/scripts/b.mjs": lines("// b", "framework's line"),
    "starter/scripts/c.mjs": null,
    "starter/scripts/new.mjs": "// new\n",
    "starter/src/pages/index.astro": lines("---", "// static home v2", "---", "<p>home</p>"),
    "starter/src/pages/thanks.astro": lines("---", "// thanks v2", "---", "<p>thanks</p>"),
    "starter/src/content/home.json": '{"framework":2}',
    "starter/package.json": JSON.stringify({ name: "s", dependencies: { astro: "2.0.0" }, devDependencies: { tool: "1.0.0", lint: "1.0.0" }, scripts: { build: "astro build", test: "t" } }),
    "packages/core/package.json": JSON.stringify({ version: "0.2.0" }),
    "packages/core/src/index.js": "export const v = 2;\n",
  });
  const { code, out } = update(fw, site);
  const read = (p) => (existsSync(join(site, p)) ? readFileSync(join(site, p), "utf8") : null);
  assert.equal(code, 2, out); // one conflict
  assert.equal(read("scripts/a.mjs"), lines("// a, edited by the site", "one", "two", "three", "four", "five", "six, improved"), "non-overlapping changes merge");
  assert.equal(read("scripts/b.mjs"), lines("// b", "site's line"), "overlapping change keeps the site's file");
  assert.equal(read("scripts/b.mjs.framework-new"), lines("// b", "framework's line"));
  assert.equal(read("scripts/c.mjs"), null, "removed by the framework, untouched by the site");
  assert.equal(read("scripts/new.mjs"), "// new\n", "new framework file added");
  assert.match(read("src/pages/index.astro"), /static home v2/);
  assert.equal(read("src/pages/thanks.astro"), null, "deleted by the site stays deleted");
  assert.equal(read("src/content/home.json"), '{"mine":true}', "site-owned content untouched");
  assert.equal(read("core/src/index.js"), "export const v = 2;\n", "core always replaced");
  assert.equal(read("core/VERSION"), "0.2.0\n");
  const pkg = JSON.parse(read("package.json"));
  assert.deepEqual(pkg.dependencies, { astro: "2.0.0", extra: "2.0.0" });
  assert.deepEqual(pkg.devDependencies, { tool: "1.0.0", lint: "1.0.0" });
  assert.deepEqual(pkg.scripts, { build: "astro build", mine: "x", test: "t" });
  assert.equal(JSON.parse(read("framework.lock.json")).framework.commit, git(fw, "rev-parse", "HEAD"));
  assert.match(out, /replaced a local edit/);
  assert.match(out, /kept deleted/);
  // Running again is a no-op.
  assert.match(update(fw, site).out, /Already on framework/);
});

test("an editing site gets the overlay and prerendered pages", () => {
  const { fw, site } = setup({ editing: true });
  release(fw, {
    "starter/editing/src/pages/index.astro": lines("---", "// editing home v2", "---", "<p>home</p>"),
    "starter/src/pages/index.astro": lines("---", "// static home v2", "---", "<p>home</p>"),
    "starter/src/pages/thanks.astro": lines("---", "// thanks v2", "---", "<p>thanks</p>"),
    "starter/editing/packages.json": JSON.stringify({ dependencies: { emdash: "1.1.0" } }),
  });
  const { code, out } = update(fw, site);
  const read = (p) => readFileSync(join(site, p), "utf8");
  assert.equal(code, 0, out);
  assert.match(read("src/pages/index.astro"), /editing home v2/, "home comes from the editing overlay");
  assert.equal(read("src/pages/thanks.astro"), lines("---", "export const prerender = true;", "// thanks v2", "---", "<p>thanks</p>"));
  assert.equal(JSON.parse(read("package.json")).dependencies.emdash, "1.1.0");
});

test("an editing site switched on before `editing.mjs off` existed gets the static files it needs", () => {
  const { fw, site } = setup({ editing: true });
  release(fw, { "starter/scripts/lib/editing-off.mjs": "// off\n", "starter/src/pages/index.astro": lines("---", "// static home v2", "---", "<p>home</p>") });
  const { code, out } = update(fw, site);
  const read = (p) => readFileSync(join(site, p), "utf8");
  assert.equal(code, 0, out);
  assert.equal(read("editing/static/src/pages/index.astro"), lines("---", "// static home v2", "---", "<p>home</p>"));
  assert.match(read("src/pages/index.astro"), /editing home/, "the live page stays the overlay");
  assert.equal(read("scripts/lib/editing-off.mjs"), "// off\n");

  const plain = setup();
  release(plain.fw, { "starter/scripts/lib/editing-off.mjs": "// off\n" });
  assert.equal(update(plain.fw, plain.site).code, 0);
  assert.equal(existsSync(join(plain.site, "editing/static")), false, "a static site gets no editing/static");
});

test("a file the site took from a later framework version is updated, not treated as a local edit", () => {
  const { fw, site } = setup();
  release(fw, { "starter/scripts/a.mjs": lines("// a v2", "one") });
  write(site, { "scripts/a.mjs": lines("// a v2", "one") }); // copied by hand from v2
  release(fw, { "starter/scripts/a.mjs": lines("// a v3", "one") });
  const { code, out } = update(fw, site);
  assert.equal(code, 0, out);
  assert.equal(readFileSync(join(site, "scripts/a.mjs"), "utf8"), lines("// a v3", "one"));
  assert.doesNotMatch(out, /conflict \|/);
});

test("a seeded file is added once when missing, then left to the site", () => {
  const { fw, site } = setup();
  const seed = JSON.stringify({ images: [{ file: "public/favicon.svg", source: "framework", alt: "" }] });
  release(fw, { "starter/design/credits.json": seed });
  let r = update(fw, site);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(site, "design/credits.json"), "utf8"), seed, "added when the site had none");
  assert.match(r.out, /design\/credits\.json.*added.*seeded/);

  // The site edits its ledger; a later framework change to the seed must not touch it.
  const mine = JSON.stringify({ images: [{ file: "public/logo.svg", source: "owner", alt: "Logo" }] });
  write(site, { "design/credits.json": mine });
  release(fw, { "starter/design/credits.json": JSON.stringify({ images: [] }) });
  r = update(fw, site);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(site, "design/credits.json"), "utf8"), mine, "the site's ledger is untouched");
  assert.doesNotMatch(r.out, /design\/credits\.json/);
});
