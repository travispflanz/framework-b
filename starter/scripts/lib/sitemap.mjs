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

// With client editing on, content pages are rendered on request through the dynamic route src/pages/[page].astro,
// so the sitemap integration can't list them (it still lists /, /privacy and /contact, which have their own routes):
// their URLs come from src/content, without home, privacy, not-found and contact. The filter drops the noindex ones.
export function contentPageUrls(root, origin) {
  const contentDir = new URL("./src/content/", root);
  const slugs = existsSync(contentDir) ? readdirSync(contentDir).filter((n) => n.endsWith(".json")).map((n) => n.replace(/\.json$/, "")) : [];
  return slugs.filter((s) => !["home", "privacy", "not-found", "contact"].includes(s)).map((s) => `${origin}/${s}`);
}
