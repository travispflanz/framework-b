#!/usr/bin/env node
// Style tiles (design phase P2.6, docs/SPEC.md section 12): renders each DESIGN.md draft on the site's real
// content, so the owner, or the autopilot judge, compares looks rather than descriptions.
//
//   node scripts/design-tiles.mjs design/drafts/a.md design/drafts/b.md design/drafts/c.md [--out design/tiles]
//
// For each draft, in this site (built into a scratch folder; the site's own files are restored afterwards):
//   1. the draft becomes DESIGN.md and scripts/design-tokens.mjs runs: the same lint, token contract and WCAG AA
//      contrast checks as the real thing. A draft that fails is reported and gets no tile.
//   2. the tile page (scripts/design-tile/tile.astro) is added and the site is built into a scratch folder;
//   3. the tile is screenshotted at 1280 and 390 px, full page.
// It builds in place because a copy of the site can't share node_modules: Astro mis-resolves EmDash's own .astro
// files through a symlink (seen in CI, 2026-10-26). DESIGN.md, tokens.css and the Cloudflare adapter's
// .wrangler/deploy/config.json are saved first and restored at the end, on Ctrl-C, and on the next run if the
// process was killed (.design-tiles-restore.json).
// Output: <out>/<draft>/tile-1280.png, tile-390.png, and <out>/index.html side by side, with each draft's
// colours and fonts. Fonts a draft names must be installed in the site first (npm i @fontsource-variable/<family>).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse } from "yaml";
import { launchBrowser } from "./lib/local-site.mjs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = resolve(outIdx >= 0 ? args.splice(outIdx, 2)[1] : "design/tiles");
const drafts = args.map((a) => resolve(a));
if (drafts.length < 2) throw new Error("give two or three DESIGN.md drafts: node scripts/design-tiles.mjs a.md b.md [c.md]");
for (const d of drafts) if (!existsSync(d)) throw new Error(`no such draft: ${d}`);
const SITE = process.cwd();
const RESTORE = join(SITE, ".design-tiles-restore.json");
const TOUCHED = ["DESIGN.md", "src/styles/tokens.css", ".wrangler/deploy/config.json", "src/pages/design-tile.astro"];
const restore = (saved) => {
  for (const [p, text] of Object.entries(saved)) {
    if (text === null) rmSync(join(SITE, p), { force: true });
    else {
      mkdirSync(dirname(join(SITE, p)), { recursive: true });
      writeFileSync(join(SITE, p), text);
    }
  }
  rmSync(RESTORE, { force: true });
};
if (existsSync(RESTORE)) {
  restore(JSON.parse(readFileSync(RESTORE, "utf8")));
  console.log("Restored the site's files from an interrupted earlier run.");
}
const saved = Object.fromEntries(TOUCHED.map((p) => [p, existsSync(join(SITE, p)) ? readFileSync(join(SITE, p), "utf8") : null]));
writeFileSync(RESTORE, JSON.stringify(saved));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (restore(saved), process.exit(130)));

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon" };
function serve(dir) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(dir, p);
    if (existsSync(join(file, "index.html"))) file = join(file, "index.html");
    else if (!extname(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!file.startsWith(dir) || !existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// The useful part of a failed command's output: lines that name an error, not the stack under them.
const plain = (e) => `${e.stdout || ""}${e.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
const why = (e) => {
  const lines = plain(e).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("at ") && !/^Node\.js v/.test(l) && !/^Build failed in/.test(l.replace(/^.*\] /, "")));
  const errs = lines.filter((l) => /error|fail|missing|contrast|not installed|cannot/i.test(l));
  return [...new Set(errs.length ? errs : lines)].slice(-4).join(" | ").slice(0, 600);
};
const results = [];
const scratch = mkdtempSync(join(tmpdir(), "fb-tiles-"));
const run = (cmd, a, env = {}) => execFileSync(cmd, a, { cwd: SITE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
let browser;
try {
  browser = await launchBrowser();
  cpSync(join(SITE, "scripts/design-tile/tile.astro"), join(SITE, "src/pages/design-tile.astro"));
  for (const draft of drafts) {
    const name = basename(draft, extname(draft)).replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const front = parse(readFileSync(draft, "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] || "") || {};
    cpSync(draft, join(SITE, "DESIGN.md"));
    try {
      run("node", ["scripts/design-tokens.mjs"]);
    } catch (e) {
      results.push({ name, ok: false, why: why(e), front });
      console.log(`✗ ${name}: the draft fails the design checks: ${results.at(-1).why}`);
      continue;
    }
    const outDir = join(scratch, name);
    try {
      run("npx", ["astro", "build", "--outDir", outDir], { TILE_NAME: name });
    } catch (e) {
      mkdirSync(join(OUT, name), { recursive: true });
      writeFileSync(join(OUT, name, "build.log"), plain(e));
      results.push({ name, ok: false, why: `build failed (log in ${name}/build.log): ${why(e)}`, front });
      console.log(`✗ ${name}: ${results.at(-1).why}`);
      continue;
    }
    const dist = existsSync(join(outDir, "client")) ? join(outDir, "client") : outDir;
    const { server, base } = await serve(dist);
    mkdirSync(join(OUT, name), { recursive: true });
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${base}/design-tile`, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(OUT, name, `tile-${width}.png`), fullPage: true });
      await page.close();
    }
    server.closeAllConnections();
    server.close();
    results.push({ name, ok: true, front });
    console.log(`✓ ${name}`);
  }
} finally {
  await browser?.close();
  restore(saved);
  rmSync(scratch, { recursive: true, force: true });
}

// Side-by-side page. The tiles are screenshots, so this page loads no site code.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fonts = (f) => [...new Set(Object.values(f.typography || {}).map((t) => t?.fontFamily).filter(Boolean))].join(", ");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Style tiles</title><style>
body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1d1d1b;background:#f4f3ef}main{padding:24px}h1{font-size:20px;margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(${results.length},minmax(0,1fr));gap:20px;align-items:start}
.tile{background:#fff;border:1px solid #d9d6cf;border-radius:8px;padding:12px}.tile h2{font-size:16px;margin:0 0 4px}
.meta{font-size:13px;color:#555;margin:0 0 8px}.sw{display:inline-block;width:14px;height:14px;border:1px solid #0002;vertical-align:middle;margin-right:2px}
img{width:100%;height:auto;border:1px solid #eee;display:block}.phone{max-width:200px;margin-top:8px}.bad{color:#9b1c1c}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
</style></head><body><main><h1>Style tiles</h1><div class="grid">
${results.map((r) => `<section class="tile"><h2>${esc(r.name)}</h2>
<p class="meta">${Object.values(r.front.colors || {}).slice(0, 8).map((c) => `<span class="sw" style="background:${esc(c)}"></span>`).join("")} ${esc(fonts(r.front))}</p>
${r.ok ? `<img src="${esc(r.name)}/tile-1280.png" alt="${esc(r.name)} at 1280 px"><img class="phone" src="${esc(r.name)}/tile-390.png" alt="${esc(r.name)} at 390 px">` : `<p class="bad">No tile: ${esc(r.why)}</p>`}
</section>`).join("\n")}
</div></main></body></html>`;
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "index.html"), html);
writeFileSync(join(OUT, "tiles.json"), JSON.stringify(results.map(({ name, ok, why }) => ({ name, ok, why: why || "" })), null, 2));
console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} tiles in ${OUT}`);
process.exit(results.some((r) => r.ok) ? 0 : 1);
