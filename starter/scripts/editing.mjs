#!/usr/bin/env node
// Switches client editing (EmDash) on for this site: `node scripts/editing.mjs on`.
// `node scripts/editing.mjs seed` rewrites seed/seed.json only, after the section library or src/content changes.
//
// What it changes:
// - copies editing/ over the site (astro.config.mjs, src/worker.js, src/live.config.ts, src/pages/index.astro);
// - marks every other page prerendered, so only EmDash-driven pages run on request;
// - writes seed/seed.json (the section library as EmDash block types, plus src/content/home.json as the first content);
// - adds the EmDash packages (exact versions in editing/packages.json) and runs npm install;
// - adds the bindings EmDash needs to wrangler.jsonc (CMS_DB, MEDIA, SESSION, the hourly cron);
// - sets "editing" in site.config.json.
// Placeholders in <angle brackets> are filled by scripts/site/create.mjs (or by hand) before deploy.
// Switching back off (exporting content to files) is not built yet.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripJsonc } from "./lib/jsonc.mjs";

// Exact package versions live in editing/packages.json, so the site update script can read them too.
export const EMDASH_PACKAGES = JSON.parse(readFileSync("editing/packages.json", "utf8")).dependencies;
export const EMDASH_CRON = "17 * * * *";

const [mode] = process.argv.slice(2);
if (!["on", "seed"].includes(mode)) {
  console.error("usage: node scripts/editing.mjs on | seed");
  process.exit(1);
}
const site = JSON.parse(readFileSync("site.config.json", "utf8"));
if (mode === "seed" && !site.editing?.enabled) throw new Error("Client editing is off; run `node scripts/editing.mjs on` first");
if (mode === "on" && site.editing?.enabled) {
  console.log("Client editing is already on.");
  process.exit(0);
}
const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));

if (mode === "on") {
  // 1. Overlay.
  cpSync("editing", ".", { recursive: true, filter: (src) => !src.endsWith("packages.json") });

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
      data: { title: home.title || "Home", sections: home.sections.map((section) => ({ _version: 1, ...section })) },
    }],
  },
}, null, 2) + "\n");

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
