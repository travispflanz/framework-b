// A page's content, by slug: src/content/<slug>.json ({ title, description?, noindex?, sections }), or null.
// Pages that call pageContent() (the home page, the content pages, and privacy, contact and 404 when the site has
// its own wording for them) read their sections through here. With client editing on, editing/src/lib/page-content.js
// replaces this file: it reads EmDash's page of the same slug first and falls back to the file, and those pages are
// rendered on request instead of prerendered (scripts/editing.mjs and scripts/site/lib/framework-files.mjs leave
// any page that imports this module without a prerender line).

const files = import.meta.glob("../content/*.json", { eager: true });

/** The slugs that have their own route, so they never become /<slug> through src/pages/[page].astro. */
export const OWN_ROUTE = ["home", "privacy", "not-found", "contact"];

/** The page in src/content/<slug>.json, or null. */
export function fileContent(slug) {
  return files[`../content/${slug}.json`]?.default ?? null;
}

/** Every src/content/*.json slug. */
export function fileSlugs() {
  return Object.keys(files).map((path) => path.split("/").pop().replace(/\.json$/, ""));
}

/** The page's content (the file; with editing on, the editors' published page first). `astro` is unused here. */
export async function pageContent(slug, astro) {
  return fileContent(slug);
}
