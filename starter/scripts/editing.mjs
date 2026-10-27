#!/usr/bin/env node
// Switches client editing (EmDash) on or off for this site.
//   node scripts/editing.mjs on     switches it on
//   node scripts/editing.mjs seed   rewrites seed/seed.json only, after the section library or src/content changes
//   node scripts/editing.mjs off --remote | --local | --database <file.sqlite> [--media-dir <dir>]
//                                   switches it off, bringing the editors' published home page back into files
//
// What `on` changes:
// - keeps the static versions of the files it replaces in editing/static/ (for `off`);
// - copies editing/ over the site (astro.config.mjs, src/worker.js, src/live.config.ts, src/pages/index.astro);
// - marks every other page prerendered, so only EmDash-driven pages run on request;
// - writes seed/seed.json (the section library as EmDash block types, plus src/content/home.json as the first content);
// - adds the EmDash packages (exact versions in editing/packages.json) and runs npm install;
// - adds the bindings EmDash needs to wrangler.jsonc (CMS_DB, MEDIA, SESSION, the hourly cron);
// - sets "editing" in site.config.json.
// Placeholders in <angle brackets> are filled by scripts/site/create.mjs (or by hand) before deploy.
//
// What `off` changes (the reverse, after exporting the content):
// - reads the content database: --remote exports the deployed CMS_DB with wrangler (needs CLOUDFLARE_API_TOKEN and
//   CLOUDFLARE_ACCOUNT_ID), --local exports wrangler dev's copy, --database reads a SQLite file you already have;
// - writes EmDash's published home page to src/content/home.json, and copies each media-library image it uses into
//   src/assets/images (from the MEDIA bucket, or --media-dir) with an entry in design/credits.json;
// - puts back the files in editing/static/, removes src/live.config.ts, the prerender lines, the EmDash packages,
//   the bindings and the cron, seed/ and "editing" in site.config.json, then checks the content.
// Nothing in Cloudflare is deleted: the content database, media bucket, session namespace and the editor Access
// application stay until the owner removes them (the script lists them).
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripJsonc } from "./lib/jsonc.mjs";
import { creditsWith, homeFromExport, leftovers, staticPackage, staticPage, staticWrangler } from "./lib/editing-off.mjs";

// Exact package versions live in editing/packages.json, so the site update script can read them too.
export const EMDASH_PACKAGES = JSON.parse(readFileSync("editing/packages.json", "utf8")).dependencies;
export const EMDASH_CRON = "17 * * * *";
// The files editing/ puts over the site (everything in it except packages.json and static/).
const OVERLAY = ["astro.config.mjs", "src/worker.js", "src/live.config.ts", "src/pages/index.astro"].filter((f) => existsSync(join("editing", f)));

const [mode] = process.argv.slice(2);
if (!["on", "seed", "off"].includes(mode)) {
  console.error("usage: node scripts/editing.mjs on | seed | off --remote | --local | --database <file.sqlite> [--media-dir <dir>]");
  process.exit(1);
}
const site = JSON.parse(readFileSync("site.config.json", "utf8"));
if (mode === "seed" && !site.editing?.enabled) throw new Error("Client editing is off; run `node scripts/editing.mjs on` first");
if (mode === "on" && site.editing?.enabled) {
  console.log("Client editing is already on.");
  process.exit(0);
}
const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));

if (mode === "off") {
  try {
    await switchOff();
  } catch (e) {
    console.error(`editing off: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "on") {
  // 1. Overlay, keeping the static versions of the files it replaces for `off`.
  for (const target of OVERLAY) {
    if (!existsSync(target)) continue;
    mkdirSync(dirname(join("editing/static", target)), { recursive: true });
    copyFileSync(target, join("editing/static", target));
  }
  cpSync("editing", ".", { recursive: true, filter: (src) => !src.endsWith("packages.json") && !/^editing[\\/]static([\\/]|$)/.test(src) });

  // 2. Everything except the EmDash-driven pages stays static.
  const overlayPages = new Set(readdirSync("editing/src/pages"));
  for (const name of readdirSync("src/pages")) {
    if (overlayPages.has(name)) continue;
    const path = join("src/pages", name);
    const text = readFileSync(path, "utf8");
    if (/export const prerender/.test(text)) continue;
    if (name.endsWith(".astro")) writeFileSync(path, text.replace(/^---\n/, "---\nexport const prerender = true;\n"));
    else if (/\.(js|ts)$/.test(name)) writeFileSync(path, `export const prerender = true;\n${text}`);
  }
}

// 3. Seed: the content model (the section library's block types) and the site's current page content.
// EmDash applies the model on first request; the owner brings the content in by choosing the sample content in
// the setup wizard.
const { SECTIONS, SECTION_TYPES } = await import(pathToFileURL(join(process.cwd(), "src/sections/schema.js")).href);
const home = JSON.parse(readFileSync("src/content/home.json", "utf8"));
// EmDash image fields hold media-library entries ({ id, src, ... }); a static site's images are files in
// src/assets/images. Those can't be seeded as media, so they're left out of the seed: editors add images in the
// admin's media library instead. (Untested: carrying local images into EmDash media.)
const isLocalImage = (v) => v && typeof v === "object" && typeof v.src === "string" && !v.id && !/^(https?:)?\/\//.test(v.src);
let droppedImages = 0;
function withoutLocalImages(value) {
  if (Array.isArray(value)) return value.map(withoutLocalImages);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isLocalImage(v)) droppedImages++;
    else out[k] = withoutLocalImages(v);
  }
  return out;
}
mkdirSync("seed", { recursive: true });
writeFileSync("seed/seed.json", JSON.stringify({
  $schema: "https://emdashcms.com/seed.schema.json",
  version: "1",
  meta: { name: site.site.name, description: "Pages an editor can change, built from the section library", author: "Framework B" },
  settings: { title: site.site.name, tagline: site.site.tagline },
  blockTypes: SECTIONS,
  collections: [{
    slug: "pages",
    label: "Pages",
    labelSingular: "Page",
    urlPattern: "/{slug}",
    supports: ["drafts", "revisions", "preview", "seo"],
    fields: [
      { slug: "title", label: "Title", type: "string", required: true },
      { slug: "sections", label: "Sections", type: "blocks", validation: { allowedTypes: SECTION_TYPES, maxItems: 20 } },
    ],
  }],
  content: {
    pages: [{
      id: "home",
      slug: "home",
      status: "published",
      data: { title: home.title || "Home", sections: home.sections.map((section) => ({ _version: 1, ...withoutLocalImages(section) })) },
    }],
  },
}, null, 2) + "\n");
if (droppedImages) console.log(`! ${droppedImages} image(s) from src/content/home.json were left out of the seed; add them in the EmDash media library after setup.`);

if (mode === "seed") {
  console.log("Wrote seed/seed.json. A deployed site keeps the model it already has: see EmDash's guide to evolving a deployed site.");
  process.exit(0);
}

// 4. Packages.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
pkg.dependencies = { ...pkg.dependencies, ...EMDASH_PACKAGES };
pkg.emdash = { seed: "seed/seed.json" };
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
execFileSync("npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit" });

// 5. Bindings. The Astro/EmDash handler serves pages, so the asset 404 page must not answer first.
wrangler.compatibility_flags = [...new Set([...(wrangler.compatibility_flags || []), "nodejs_compat"])];
delete wrangler.assets.not_found_handling;
wrangler.d1_databases = [
  ...wrangler.d1_databases.filter((d) => d.binding !== "CMS_DB"),
  { binding: "CMS_DB", database_name: "<cms-d1-name>", database_id: "<cms-d1-id>" },
];
wrangler.r2_buckets = [...wrangler.r2_buckets.filter((b) => b.binding !== "MEDIA"), { binding: "MEDIA", bucket_name: "<media-bucket>" }];
wrangler.kv_namespaces = [...(wrangler.kv_namespaces || []).filter((k) => k.binding !== "SESSION"), { binding: "SESSION", id: "<session-kv-id>" }];
wrangler.triggers = { crons: [EMDASH_CRON] };
writeFileSync("wrangler.jsonc", "// Client editing on (scripts/editing.mjs). Secrets: also CF_ACCESS_AUDIENCE and EMDASH_ENCRYPTION_KEY.\n" + JSON.stringify(wrangler, null, 2) + "\n");

// 6. Config.
site.editing = { enabled: true, accessTeamDomain: wrangler.vars?.ACCESS_TEAM_DOMAIN || "<team>.cloudflareaccess.com" };
writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");

console.log(`Client editing is on. Editors use /_emdash/admin behind Cloudflare Access.
Next: fill the <placeholders> in wrangler.jsonc, set the CF_ACCESS_AUDIENCE and EMDASH_ENCRYPTION_KEY
secrets, then build and deploy.`);

// ---------- off ----------
async function switchOff() {
  if (!site.editing?.enabled) {
    console.log("Client editing is already off.");
    return;
  }
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const where = process.argv.includes("--remote") ? "--remote" : process.argv.includes("--local") ? "--local" : null;
  const given = arg("database");
  const mediaDir = arg("media-dir");
  if (!where && !given) throw new Error("off needs --remote (the deployed content), --local (wrangler dev's copy) or --database <file.sqlite>");
  if (!existsSync("editing/static")) {
    throw new Error('editing/static/ is missing: this site switched editing on before `off` existed. Run the ops repo\'s "Site update" workflow first; it adds the static files.');
  }
  const binding = (list, name) => (list || []).find((x) => x.binding === name);
  const cms = binding(wrangler.d1_databases, "CMS_DB");
  const bucket = binding(wrangler.r2_buckets, "MEDIA")?.bucket_name;
  const { DatabaseSync } = await import("node:sqlite");
  const tmp = mkdtempSync(join(tmpdir(), "editing-off-"));
  try {
    // 1. The content database as a SQLite file.
    let file = given;
    if (!file) {
      const sql = join(tmp, "cms.sql");
      execFileSync("npx", ["wrangler", "d1", "export", cms.database_name, where, "--output", sql], { stdio: ["ignore", "ignore", "inherit"] });
      file = join(tmp, "cms.sqlite");
      const db = new DatabaseSync(file);
      db.exec(readFileSync(sql, "utf8"));
      db.close();
    }
    const exported = JSON.parse(execFileSync("npx", ["emdash", "export-seed", "--database", file, "--with-content", "pages"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    const db = new DatabaseSync(file, { readOnly: true });
    const media = db.prepare("select id, filename, mime_type, alt, storage_key from media").all();
    const drafts = db.prepare("select slug from ec_pages where draft_revision_id is not null and deleted_at is null").all().map((r) => r.slug);
    db.close();

    // 2. Content and images.
    const current = JSON.parse(readFileSync("src/content/home.json", "utf8"));
    const taken = existsSync("src/assets/images") ? readdirSync("src/assets/images") : [];
    const { home, images, notes, changed } = homeFromExport(exported, current, media, taken);
    for (const slug of drafts) notes.push(`EmDash page "${slug}" has an unpublished draft; only the published version was exported`);
    if (images.length) {
      if (!mediaDir && !where) throw new Error(`The home page uses ${images.length} media-library image(s): add --media-dir <dir> (files named by storage key), --remote or --local`);
      mkdirSync("src/assets/images", { recursive: true });
      for (const img of images) {
        const dest = join("src/assets/images", img.file);
        if (mediaDir) copyFileSync(join(mediaDir, img.storageKey), dest);
        else execFileSync("npx", ["wrangler", "r2", "object", "get", `${bucket}/${img.storageKey}`, "--file", dest, where], { stdio: ["ignore", "ignore", "inherit"] });
      }
      const credits = existsSync("design/credits.json") ? JSON.parse(readFileSync("design/credits.json", "utf8")) : undefined;
      mkdirSync("design", { recursive: true });
      writeFileSync("design/credits.json", JSON.stringify(creditsWith(credits, images), null, 2) + "\n");
    }
    writeFileSync("src/content/home.json", JSON.stringify(home, null, 2) + "\n");

    // 3. Files back to the static site.
    for (const target of OVERLAY) {
      const saved = join("editing/static", target);
      if (existsSync(saved)) copyFileSync(saved, target);
      else rmSync(target, { force: true });
    }
    rmSync("editing/static", { recursive: true, force: true });
    for (const name of readdirSync("src/pages")) {
      const path = join("src/pages", name);
      if (OVERLAY.includes(path.replaceAll("\\", "/")) || !/\.(astro|js|ts)$/.test(name)) continue;
      const text = readFileSync(path, "utf8");
      const next = staticPage(text, name);
      if (next !== text) writeFileSync(path, next);
    }
    rmSync("seed", { recursive: true, force: true });

    // 4. Packages, bindings, config.
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    writeFileSync("package.json", JSON.stringify(staticPackage(pkg, EMDASH_PACKAGES), null, 2) + "\n");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { stdio: "inherit" });
    const left = leftovers(wrangler);
    writeFileSync("wrangler.jsonc", "// Client editing switched off (scripts/editing.mjs off). Resource IDs are not secrets.\n" + JSON.stringify(staticWrangler(wrangler, EMDASH_CRON), null, 2) + "\n");
    delete site.editing;
    writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");

    console.log(`Client editing is off. ${changed ? "src/content/home.json now holds the editors' published home page" : "src/content/home.json is unchanged"}${images.length ? `, with ${images.length} image(s) in src/assets/images (credited in design/credits.json; confirm each source)` : ""}.`);
    for (const n of notes) console.log(`! ${n}`);
    console.log(`Kept in Cloudflare until the owner deletes them: ${[...left, "the site's editor Access application", "Worker secrets CF_ACCESS_AUDIENCE and EMDASH_ENCRYPTION_KEY"].join("; ")}.`);
    execFileSync("node", ["scripts/check-content.mjs"], { stdio: "inherit" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
