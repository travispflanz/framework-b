#!/usr/bin/env node
// CI check of the style guide and the Website assets page (/credits), with client editing on or off. Run it in a
// starter with the full-site fixture's /about page (and, for editing, `editing.mjs on` and fill-test-placeholders).
// 1. Credits a spot-coloured picture and puts the spot-colour script and prompt in public/tools, builds, starts the
//    local Worker and checks /credits links both (an editing build prerenders the page inside the Workers runtime,
//    where node:fs finds no files, so the page bundles them at build time).
// 2. Editing on: makes an editor's change in the local content database: a new home headline, and a picture from
//    the media library in place of the /about hero's credited file. Both pages show it; /credits is byte for byte
//    what it was, still saying the old picture is at the top of the About page and not listing the new one: it is
//    built from design/credits.json and src/content. (`editing.mjs off` brings the picture in as a credited file.)
// 3. Renders the style guide: it builds from the files (the static site, with editing on), has the first screen of
//    every indexable page, and leaves every site file as it was.
// Everything it changes is put back at the end, also after a failure. Local files only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { startLocalSite } from "../lib/local-site.mjs";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const tmp = mkdtempSync(join(tmpdir(), "guide-assets-"));
const editing = JSON.parse(readFileSync("site.config.json", "utf8")).editing?.enabled === true;
assert.ok(existsSync("src/content/about.json"), "run scripts/test/fixture-full-site.mjs first");
const creditsBefore = readFileSync("design/credits.json", "utf8");
const toolsExisted = existsSync("public/tools");
const restore = () => {
  writeFileSync("design/credits.json", creditsBefore);
  if (!toolsExisted) rmSync("public/tools", { recursive: true, force: true });
};
process.on("SIGINT", () => (restore(), process.exit(130)));

// The local SQLite file behind CMS_DB: the one holding EmDash's tables (as scripts/e2e.mjs finds it).
function cmsDatabase(state) {
  const dir = join(state, "v3/d1/miniflare-D1DatabaseObject");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite")) {
    const db = new DatabaseSync(join(dir, f), { readOnly: true });
    const hit = db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_emdash_fields'").get();
    db.close();
    if (hit) return join(dir, f);
  }
  return null;
}

let local;
try {
  // 1. A spot-coloured picture and the tools the Website assets page offers for it.
  const credits = JSON.parse(creditsBefore);
  const spotted = credits.images.find((c) => c.file.endsWith("fixture-b.jpg"));
  spotted.spot = { what: "a test object", colour: "#9a3b16", chosenBy: "Example Model", segmenter: "test", method: "test", date: "2026-11-17" };
  writeFileSync("design/credits.json", JSON.stringify(credits, null, 2) + "\n");
  mkdirSync("public/tools", { recursive: true });
  writeFileSync("public/tools/spot-colour.mjs", "// test script\n");
  writeFileSync("public/tools/spot-colour-prompt.md", "A test prompt for the Website assets page.\n");
  run("npm", ["run", "build"]);
  local = await startLocalSite({ name: "assets", port: 8797 });
  const get = async (path) => {
    const r = await fetch(`${local.base}${path}`);
    assert.equal(r.status, 200, `${path} answers`);
    return r.text();
  };
  const assetsBefore = await get("/credits");
  assert.match(assetsBefore, /href="\/tools\/spot-colour\.mjs"/, "/credits links the spot-colour script");
  assert.match(assetsBefore, /href="\/tools\/spot-colour-prompt\.md"/, "/credits links the spot-colour prompt");
  assert.ok(assetsBefore.includes("A test prompt for the Website assets page."), "/credits shows the prompt");
  assert.match(assetsBefore, /the top of the About page/, "/credits places the fixture's picture at the top of /about");

  // 2. An editor's change in EmDash: the pages come in as the setup wizard's sample content would bring them, then
  // the home headline is rewritten and the /about hero's picture is replaced with one from the media library.
  if (editing) {
    await get("/"); // EmDash makes its tables on the first request
    const cms = cmsDatabase(local.state);
    assert.ok(cms, "EmDash made its tables in the local content database");
    run("npx", ["emdash", "seed", "-d", cms, "seed/seed.json", "--skip-media", "--on-conflict", "update"]);
    const picture = join(tmp, "01EDITOR.jpg");
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#5b7f95" } }).jpeg().toFile(picture);
    execFileSync("npx", ["wrangler", "r2", "object", "put", "assets-media/01EDITOR.jpg", "--file", picture, "--content-type", "image/jpeg", "--local", "--persist-to", local.state, "--config", "dist/server/.assets.wrangler.json"], { stdio: "ignore" });
    const db = new DatabaseSync(cms);
    const sectionsOf = (slug) => JSON.parse(db.prepare("select sections from ec_pages where slug = ?").get(slug).sections);
    const home = sectionsOf("home");
    home[0].headline = "Edited by an editor in EmDash";
    db.prepare("update ec_pages set sections = ? where slug = 'home'").run(JSON.stringify(home));
    const about = sectionsOf("about");
    about[0].image = { provider: "local", id: "01EDITOR", src: "/_emdash/api/media/file/01EDITOR.jpg", alt: "A picture an editor added", width: 1200, height: 800 };
    db.prepare("update ec_pages set sections = ? where slug = 'about'").run(JSON.stringify(about));
    db.prepare("insert into media (id, filename, mime_type, storage_key, alt) values (?, ?, ?, ?, ?)").run("01EDITOR", "editor.jpg", "image/jpeg", "01EDITOR.jpg", "A picture an editor added");
    db.close();

    assert.ok((await get("/")).includes("Edited by an editor in EmDash"), "the home page shows the editor's headline");
    const aboutPage = await get("/about");
    assert.ok(aboutPage.includes('src="/_emdash/api/media/file/01EDITOR.jpg"') && aboutPage.includes("A picture an editor added"), "/about shows the editor's picture");
    assert.equal((await fetch(`${local.base}/_emdash/api/media/file/01EDITOR.jpg`)).status, 200, "the editor's picture is served from the media bucket");
    const assetsAfter = await get("/credits");
    assert.equal(assetsAfter, assetsBefore, "/credits is the page built from the files, unchanged by the editor's work");
    assert.ok(!assetsAfter.includes("A picture an editor added"), "the editor's picture is not on /credits");
    console.log("Editing: the editor's headline and picture are on the pages; /credits still lists design/credits.json and the files' places.");
  }
  local.stop();
  local = undefined;

  // 3. The style guide, from the files.
  const hashOf = (f) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null);
  const watched = ["astro.config.mjs", "src/worker.js", "src/live.config.ts", "src/lib/page-content.js", "src/pages/index.astro", "src/pages/[page].astro", "src/pages/fb-sync-pages.js", "design/credits.json", "site.config.json"];
  const before = Object.fromEntries(watched.map((f) => [f, hashOf(f)]));
  const out = join(tmp, "guide");
  run("node", ["scripts/style-guide.mjs", "--out", out]);
  for (const f of ["style-guide.pdf", "style-guide.png", "stamp.json"]) assert.ok(existsSync(join(out, f)), `the guide wrote ${f}`);
  const indexable = readdirSync("src/content").filter((f) => f.endsWith(".json") && f !== "not-found.json" && !JSON.parse(readFileSync(join("src/content", f), "utf8")).noindex).length;
  assert.equal(JSON.parse(readFileSync(join(out, "stamp.json"), "utf8")).pages, indexable, "the guide has the first screen of every indexable page");
  assert.deepEqual(Object.fromEntries(watched.map((f) => [f, hashOf(f)])), before, "the guide left the site's files as they were");
  for (const gone of ["src/pages/style-guide.astro", ".style-guide-restore.json"]) assert.ok(!existsSync(gone), `${gone} is removed`);
  console.log(`Style guide${editing ? " with editing on" : ""}: built from the files, ${indexable} page(s) with their first screens.`);
} finally {
  local?.stop();
  restore();
  rmSync(tmp, { recursive: true, force: true });
}
console.log("Style guide and Website assets checks passed.");
