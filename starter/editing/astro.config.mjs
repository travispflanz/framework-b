// Client editing (EmDash) on. Written by `node scripts/editing.mjs on`.
// Server output on the Cloudflare adapter. Pages that read EmDash content (the home page, every content page, and
// privacy, contact and 404) are rendered on request and cached in Workers Cache (the Free plan allows 10 ms CPU a
// request); every other page stays prerendered.
// Editors sign in through Cloudflare Access on /_emdash/* (no passkeys or email needed).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import emdash from "emdash/astro";
import { access, d1, r2 } from "@emdash-cms/cloudflare";
import config from "./site.config.json" with { type: "json" };
import { buildHeadersFile } from "./core/src/headers.js";
import { contentPageUrls, sitemapFilter } from "./scripts/lib/sitemap.mjs";

// Writes _headers from site.config.json, so indexing rules never drift from the config.
const headersFile = {
  name: "framework-b-headers",
  hooks: {
    "astro:build:done": ({ dir }) => {
      writeFileSync(fileURLToPath(new URL("_headers", dir)), buildHeadersFile(config));
    },
  },
};

// The site's own pictures in the seed (external media values, id "local:<file>", scripts/editing.mjs) are copied to
// /media/<file>, so EmDash's admin can show them; the pages still serve them through Astro's image pipeline.
const localMedia = {
  name: "framework-b-local-media",
  hooks: {
    "astro:build:done": ({ dir }) => {
      if (!existsSync("seed/seed.json")) return;
      const files = new Set([...readFileSync("seed/seed.json", "utf8").matchAll(/"id":\s*"local:([^"]+)"/g)].map((m) => m[1]));
      if (!files.size) return;
      const out = fileURLToPath(new URL("media/", dir));
      mkdirSync(out, { recursive: true });
      for (const f of files) if (!f.includes("/") && existsSync(`src/assets/images/${f}`)) copyFileSync(`src/assets/images/${f}`, `${out}${f}`);
    },
  },
};

export default defineConfig({
  site: `https://${config.site.canonicalHost}`,
  output: "server",
  adapter: cloudflare(),
  trailingSlash: "never",
  build: { format: "file" },
  cache: { provider: cacheCloudflare() },
  // EmDash invalidates the "pages" tag when an editor publishes; maxAge bounds staleness if that fails. Each public
  // route is listed: a rest route would also match /_emdash (EmDash's route caching guide, checked 2026-11-11).
  routeRules: Object.fromEntries(["/", "/[page]", "/privacy", "/contact", "/404"].map((route) => [route, { maxAge: 300, swr: 86400, tags: ["pages", "all"] }])),
  integrations: [
    react(), // EmDash's admin is a React app
    // Content pages are rendered on request, so the sitemap lists them from src/content (an editor's new page is not
    // in it until it is a file, or the site switches editing off).
    ...(config.site.indexing ? [sitemap({ filter: sitemapFilter(import.meta.url), customPages: contentPageUrls(import.meta.url, `https://${config.site.canonicalHost}`) })] : []),
    emdash({
      database: d1({ binding: "CMS_DB" }),
      storage: r2({ binding: "MEDIA" }),
      auth: access({ teamDomain: config.editing.accessTeamDomain, audienceEnvVar: "CF_ACCESS_AUDIENCE" }),
    }),
    headersFile,
    localMedia,
  ],
  vite: { plugins: [tailwindcss()] },
});
