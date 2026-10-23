#!/usr/bin/env node
// Switches client editing (EmDash) on for this site: `node scripts/editing.mjs on`.
//
// What it changes:
// - copies editing/ over the site (astro.config.mjs, src/worker.js, src/live.config.ts, src/pages/index.astro);
// - marks every other page prerendered, so only EmDash-driven pages run on request;
// - writes seed/seed.json (the content model, plus the current copy as the first content);
// - adds the EmDash packages (exact versions below) and runs npm install;
// - adds the bindings EmDash needs to wrangler.jsonc (CMS_DB, MEDIA, SESSION, the hourly cron);
// - sets "editing" in site.config.json.
// Placeholders in <angle brackets> are filled by scripts/site/create.mjs (or by hand) before deploy.
// Switching back off (exporting content to files) is not built yet.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripJsonc } from "./lib/jsonc.mjs";

export const EMDASH_PACKAGES = {
  emdash: "1.3.1",
  "@emdash-cms/cloudflare": "1.3.1",
  "@astrojs/cloudflare": "14.4.2",
  "@astrojs/react": "7.1.1",
  react: "19.3.1",
  "react-dom": "19.3.1",
};
export const EMDASH_CRON = "17 * * * *";

const [mode] = process.argv.slice(2);
if (mode !== "on") {
  console.error("usage: node scripts/editing.mjs on");
  process.exit(1);
}
const site = JSON.parse(readFileSync("site.config.json", "utf8"));
if (site.editing?.enabled) {
  console.log("Client editing is already on.");
  process.exit(0);
}
const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));

// 1. Overlay.
cpSync("editing", ".", { recursive: true });

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

// 3. Seed: the content model and the site's current copy. EmDash applies the model on first request; the
// owner brings the copy in by choosing the sample content in the setup wizard.
mkdirSync("seed", { recursive: true });
writeFileSync("seed/seed.json", JSON.stringify({
  $schema: "https://emdashcms.com/seed.schema.json",
  version: "1",
  meta: { name: site.site.name, description: "Pages an editor can change", author: "Framework B" },
  settings: { title: site.site.name, tagline: site.site.tagline },
  collections: [{
    slug: "pages",
    label: "Pages",
    labelSingular: "Page",
    urlPattern: "/{slug}",
    supports: ["drafts", "revisions", "preview", "seo"],
    fields: [
      { slug: "title", label: "Title", type: "string", required: true },
      { slug: "headline", label: "Headline", type: "string" },
      { slug: "intro", label: "Intro", type: "text" },
      { slug: "content", label: "Content", type: "portableText" },
    ],
  }],
  content: {
    pages: [{ id: "home", slug: "home", status: "published", data: { title: "Home", headline: site.site.name, intro: site.site.tagline } }],
  },
}, null, 2) + "\n");

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
