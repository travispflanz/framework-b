// Where the e2e test looks for a form (scripts/e2e.mjs). It once looked only at form sections (fb_form), so a form
// drawn by a section of the site's own failed "the form is on a page" while visitors could send it (follow-up from the
// 2026-11-26 reviews).

// The paths to look for a form on, in order: content pages with a form section for it, content pages where any other
// section names it in a "form" field (at any depth), the home page, the built-in /contact page, then every other
// content page. `read(slug)` returns a content page's JSON (src/content/<slug>.json).
export function formPaths(pages, formId, read) {
  const path = (slug) => (slug === "home" ? "/" : `/${slug}`);
  const names = (v) => !!v && typeof v === "object" && (Array.isArray(v) ? v.some(names) : v.form === formId || Object.values(v).some(names));
  const content = pages.map((slug) => [slug, read(slug)?.sections || []]);
  const withForm = content.filter(([, sections]) => sections.some((s) => s?._type === "fb_form" && s.form === formId));
  const naming = content.filter(([, sections]) => sections.some(names));
  return [...new Set([...withForm, ...naming].map(([slug]) => path(slug)).concat("/", "/contact", pages.map(path)))];
}
