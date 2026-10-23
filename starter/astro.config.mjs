// Static Astro build served as Workers static assets. The Worker (src/worker.js) handles only
// /api/*, /admin and /u. EmDash, when switched on, adds the Cloudflare adapter (see AGENTS.md).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import config from "./site.config.json" with { type: "json" };
import { buildHeadersFile } from "./core/src/headers.js";

// Writes dist/_headers from site.config.json, so indexing rules never drift from the config.
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
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [...(config.site.indexing ? [sitemap()] : []), headersFile],
  vite: { plugins: [tailwindcss()] },
});
