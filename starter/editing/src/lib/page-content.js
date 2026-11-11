// A page's content with client editing on (installed from editing/ by scripts/editing.mjs over the static version).
// EmDash's published page of the same slug comes first (its title, its sections, and the description and noindex an
// editor set in its SEO panel); a page EmDash doesn't have yet, or one an editor emptied, is the file
// src/content/<slug>.json. Pages that call pageContent() are rendered on request and cached (astro.config.mjs).
import { getEmDashEntry } from "emdash";
import { getContentSeo } from "emdash/seo";

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

/**
 * The page's content: EmDash's published page "<slug>" (a preview link shows its draft), else the file, else null.
 * Pass Astro, so the page carries EmDash's cache tags and is purged when an editor publishes.
 */
export async function pageContent(slug, astro) {
  const file = fileContent(slug);
  const { entry, error, cacheHint } = await getEmDashEntry("pages", slug);
  if (astro?.cache?.enabled && cacheHint) astro.cache.set(cacheHint);
  if (error) console.error(`EmDash page "${slug}": ${error.message}; showing the file instead`);
  if (!entry?.data?.sections?.length) return file;
  const seo = getContentSeo(entry);
  // The home page's title "Home" is EmDash's label for it, not a <title>: the file's title stays until an editor
  // writes another one.
  const title = entry.data.title && !(slug === "home" && entry.data.title === "Home") ? entry.data.title : file?.title;
  return {
    ...(file || {}),
    title,
    description: seo?.description || file?.description,
    noindex: seo?.noIndex === true || file?.noindex === true,
    sections: entry.data.sections,
  };
}
