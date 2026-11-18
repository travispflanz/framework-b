// Which layout a page's hero takes (composition.heroes in DESIGN.md). Used by Hero.astro, the style guide and the
// style tiles, so all three agree. No imports beyond the schema: scripts run it under plain Node too.
import { VARIANTS } from "./schema.js";

// The home page takes heroes.home; every other page takes the first of heroes.page, unless its hero names its own
// variant. A hero with no picture is a statement, in the same title treatment (bento keeps its tiles).
export function heroLayout(value, { home = false, heroes } = {}) {
  const route = heroes ? (home ? heroes.home : [].concat(heroes.page)[0]) : undefined;
  const chosen = VARIANTS.fb_hero.includes(value?.variant) ? value.variant : route || VARIANTS.fb_hero[0];
  return value?.image?.src ? chosen : chosen === "bento" ? "bento" : "statement";
}

// Whether a page's URL is the home page's. With build.format "file" (astro.config.mjs) a static build renders the
// home page as "/index.html", so a test for "/" alone gave the home page the inner pages' hero (found 2026-11-18).
// Pages pass `home` to Sections instead; this is the fallback for a page that doesn't.
export const isHomePath = (pathname) => /^\/?(index(\.html)?)?$/.test(String(pathname || "").replace(/\/$/, ""));
