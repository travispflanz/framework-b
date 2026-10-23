import config from "../../site.config.json";
// Crawlers must be allowed in to see the noindex header, so robots.txt never blocks; it only adds the sitemap.
export function GET() {
  const lines = ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /api/"];
  if (config.site.indexing) lines.push(`Sitemap: https://${config.site.canonicalHost}/sitemap-index.xml`);
  return new Response(lines.join("\n") + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
}
