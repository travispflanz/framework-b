// Builds the static-assets `_headers` file for a site. Static assets are served without running the
// Worker, so indexing rules for them must live here, not in Worker code.
// Format and host matching: https://developers.cloudflare.com/workers/static-assets/headers/ (checked 2026-10-22).
// workers.dev Preview URLs get X-Robots-Tag: noindex from Cloudflare automatically (same source).

import { loadConfig } from "./config.js";

export function buildHeadersFile(rawConfig) {
  const config = loadConfig(rawConfig);
  const blocks = [
    [
      "/*",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      "  X-Frame-Options: DENY",
      "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    ],
  ];
  if (!config.site.indexing) {
    blocks[0].push("  X-Robots-Tag: noindex");
  } else if (!config.site.canonicalHost.endsWith(".workers.dev")) {
    // Indexed launch site: keep its workers.dev twin out of search results. An indexed idea site lives on
    // workers.dev, so there the workers.dev host is the canonical one and stays indexable.
    blocks.push(["https://:worker.:subdomain.workers.dev/*", "  X-Robots-Tag: noindex"]);
  }
  return blocks.map((b) => b.join("\n")).join("\n\n") + "\n";
}
