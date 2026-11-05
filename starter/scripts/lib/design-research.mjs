// The site's design research (design/research.md; docs/SPEC.md section 12, "Four lenses"): the business, its field,
// current design and the site's own look, written before the routes and referred to by the logo brief, DESIGN.md
// and the style guide. This module imports nothing, so the content check and the logo tool can both use it.

export const FILE = "design/research.md";
export const LENSES = ["The business", "The field", "Current design", "The site's own look"];
export const PLACEHOLDER = "To be written.";

function sections(md) {
  const text = String(md || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
  return Object.fromEntries(text.split(/^##\s+/m).slice(1).map((p) => {
    const [h, ...rest] = p.split("\n");
    return [h.trim(), rest.join("\n").trim()];
  }));
}

// Lenses whose heading is missing (the content check fails these).
export function missingLenses(md) {
  const have = sections(md);
  return LENSES.filter((h) => have[h] === undefined);
}

// Lenses still holding the placeholder or nothing.
export function unwrittenLenses(md) {
  const have = sections(md);
  return LENSES.filter((h) => have[h] !== undefined && (!have[h] || have[h] === PLACEHOLDER));
}

// A written lens names at least one source with a date (YYYY-MM-DD), except the business, whose source is PRODUCT.md.
export function undatedLenses(md) {
  const have = sections(md);
  return LENSES.filter((h) => h !== "The business" && have[h] && have[h] !== PLACEHOLDER && !/\b20\d\d-\d\d-\d\d\b/.test(have[h]));
}
