#!/usr/bin/env node
// The site's style guide (docs/SPEC.md section 12, "Style guide"; docs/BUILD.md step 3): STYLE-GUIDE.md rendered
// with the site's real colours, type scale, components, hero layouts, page flow and the first screen of every page.
//
//   node scripts/style-guide.mjs [--out design/style-guide]
//
// 1. Checks STYLE-GUIDE.md has every section (scripts/lib/style-guide.mjs, REQUIRED) and lists any still unwritten.
// 2. Adds the guide page (scripts/style-guide/guide.astro) to the site and builds into a scratch folder; the site's
//    own files are restored at the end, on Ctrl-C, and on the next run if the process was killed
//    (.style-guide-restore.json), the same way scripts/design-tiles.mjs does it.
// 3. Serves the build, screenshots the first screen of every indexable page at 1280 and 390 px, puts them in the
//    guide, and prints it: <out>/style-guide.pdf (US Letter) and <out>/style-guide.png (the whole guide as one
//    picture, for a quick look).
// 4. Writes <out>/stamp.json with a hash of DESIGN.md and STYLE-GUIDE.md, so the QA gate can tell when the guide is
//    older than either. Commit the three files.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import sharp from "sharp";
import { launchBrowser } from "./lib/local-site.mjs";
import { missingSections, unwritten } from "./lib/style-guide.mjs";
import { hash, readInputs } from "./lib/style-guide-stamp.mjs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = resolve(outIdx >= 0 ? args[outIdx + 1] : "design/style-guide"); // stamp.json there is what the QA gate reads (lib/style-guide-stamp.mjs)
const SITE = process.cwd();

if (!existsSync("STYLE-GUIDE.md")) throw new Error("no STYLE-GUIDE.md: copy the starter's template and write it (docs/BUILD.md step 3, \"Style guide\")");
const missing = missingSections(readFileSync("STYLE-GUIDE.md", "utf8"));
if (missing.length) throw new Error(`STYLE-GUIDE.md is missing sections: ${missing.join(", ")}`);
const todo = unwritten(readFileSync("STYLE-GUIDE.md", "utf8"));
if (todo.length) console.log(`  note  STYLE-GUIDE.md still has unwritten sections: ${todo.join(", ")}`);

const RESTORE = join(SITE, ".style-guide-restore.json");
const TOUCHED = ["src/pages/style-guide.astro", ".wrangler/deploy/config.json"];
const restore = (saved) => {
  for (const [p, text] of Object.entries(saved)) {
    if (text === null) rmSync(join(SITE, p), { force: true });
    else writeFileSync(join(SITE, p), text);
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

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".json": "application/json", ".ico": "image/x-icon" };
function serve(dir) {
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(dir, p);
    if (existsSync(join(file, "index.html"))) file = join(file, "index.html");
    else if (!extname(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!file.startsWith(dir) || !existsSync(file)) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const scratch = mkdtempSync(join(tmpdir(), "fb-guide-"));
let browser, server;
try {
  cpSync(join(SITE, "scripts/style-guide/guide.astro"), join(SITE, "src/pages/style-guide.astro"));
  try {
    execFileSync("npx", ["astro", "build", "--outDir", scratch], { cwd: SITE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const log = `${e.stdout || ""}${e.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    throw new Error(`the build with the guide page failed:\n${log.split("\n").filter((l) => /error|fail/i.test(l)).slice(-8).join("\n")}`);
  }
  const dist = existsSync(join(scratch, "client")) ? join(scratch, "client") : scratch;
  const served = await serve(dist);
  server = served.server;
  const base = served.base;
  browser = await launchBrowser();

  // The first screen of every page the guide lists, at desktop and phone width, as small JPEGs.
  const guidePage = await browser.newPage({ viewport: { width: 816, height: 1056 }, reducedMotion: "reduce" });
  await guidePage.goto(`${base}/style-guide`, { waitUntil: "load" });
  const wanted = await guidePage.evaluate(() => [...document.querySelectorAll("[data-shot]")].map((el) => ({ path: el.dataset.shot, width: Number(el.dataset.width) })));
  const shots = {};
  for (const { path, width } of wanted) {
    const page = await browser.newPage({ viewport: { width, height: width > 500 ? 800 : 844 }, reducedMotion: "reduce", deviceScaleFactor: 1 });
    const res = await page.goto(`${base}${path}`, { waitUntil: "load" });
    if (res?.ok()) {
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((img) => Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])));
      });
      const png = await page.screenshot();
      const jpg = await sharp(png).resize({ width: width > 500 ? 800 : 260 }).jpeg({ quality: 72 }).toBuffer();
      shots[`${path}@${width}`] = `data:image/jpeg;base64,${jpg.toString("base64")}`;
    }
    await page.close();
  }
  await guidePage.evaluate((s) => {
    for (const el of document.querySelectorAll("[data-shot]")) {
      const src = s[`${el.dataset.shot}@${el.dataset.width}`];
      if (src) el.outerHTML = `<img src="${src}" alt="The first screen of ${el.dataset.shot} at ${el.dataset.width} px">`;
    }
  }, shots);
  await guidePage.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])));
  });
  mkdirSync(OUT, { recursive: true });
  await guidePage.pdf({ path: join(OUT, "style-guide.pdf"), format: "Letter", printBackground: true, preferCSSPageSize: true });
  await guidePage.screenshot({ path: join(OUT, "style-guide.png"), fullPage: true });
  const inputs = readInputs();
  writeFileSync(join(OUT, "stamp.json"),
    JSON.stringify({ rendered: new Date().toISOString(), inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, hash(v)])), pages: Object.keys(shots).length / 2, unwritten: todo }, null, 2) + "\n");
  console.log(`Style guide: ${join(OUT, "style-guide.pdf")} (${Math.round(readFileSync(join(OUT, "style-guide.pdf")).length / 1024)} KB, ${Object.keys(shots).length} page screens) and style-guide.png. Commit them with stamp.json.`);
} finally {
  await browser?.close();
  server?.closeAllConnections?.();
  server?.close();
  restore(saved);
  rmSync(scratch, { recursive: true, force: true });
}
