// Client editing (EmDash) on. Written by `node scripts/editing.mjs on`.
// Server output on the Cloudflare adapter. Pages that read EmDash content are rendered on request and cached
// in Workers Cache (the Free plan allows 10 ms CPU a request); every other page stays prerendered.
// Editors sign in through Cloudflare Access on /_emdash/* (no passkeys or email needed).
import { writeFileSync } from "node:fs";
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
import { sitemapFilter } from "./scripts/lib/sitemap.mjs";

// Writes _headers from site.config.json, so indexing rules never drift from the config.
const headersFile = {
  name: "framework-b-headers",
  hooks: {
    "astro:build:done": ({ dir }) => {
      writeFileSync(fileURLToPath(new URL("_headers", dir)), buildHeadersFile(config));
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
  // EmDash invalidates the "pages" tag when an editor publishes; maxAge bounds staleness if that fails.
  routeRules: {
    "/": { maxAge: 300, swr: 86400, tags: ["pages", "all"] },
  },
  integrations: [
    react(), // EmDash's admin is a React app
    ...(config.site.indexing ? [sitemap({ filter: sitemapFilter(import.meta.url) })] : []),
    emdash({
      database: d1({ binding: "CMS_DB" }),
      storage: r2({ binding: "MEDIA" }),
      auth: access({ teamDomain: config.editing.accessTeamDomain, audienceEnvVar: "CF_ACCESS_AUDIENCE" }),
    }),
    headersFile,
  ],
  vite: { plugins: [tailwindcss()] },
});
