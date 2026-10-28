// Which pages go in the sitemap (astro.config.mjs, static and editing): not the ones that ask search engines to
// stay away, which are content pages with "noindex": true and the built-in pages that always carry noindex.
import { existsSync, readFileSync, readdirSync } from "node:fs";

export function sitemapFilter(root) {
  const contentDir = new URL("./src/content/", root);
  const noindex = new Set(["/thanks", "/credits", "/404"]);
  if (existsSync(contentDir)) {
    for (const f of readdirSync(contentDir).filter((n) => n.endsWith(".json") && n !== "home.json")) {
      if (JSON.parse(readFileSync(new URL(f, contentDir), "utf8")).noindex === true) noindex.add(`/${f.replace(/\.json$/, "")}`);
    }
  }
  return (page) => !noindex.has(new URL(page).pathname.replace(/\/$/, "") || "/");
}
