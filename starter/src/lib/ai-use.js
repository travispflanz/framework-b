// How AI was used on the site's images, for the Website assets page (src/pages/credits.astro; docs/SPEC.md section
// 12, "Website assets: how AI was used"). The steps come from design/credits.json, written by the tools that took
// them: "ai" on each image (the steps below) and "aiBy" (which model, named by the agent, as `--by` names it for spot
// colour). Spot colour has its own record ("spot"). Where each image appears comes from the pages' content. Nothing
// is claimed for an image without a record: an image the owner edited by hand says nothing about AI.
// Pure functions, so scripts/test/ai-use.test.mjs checks the wording without a build.

// chose: picked from an archive or library for a place on the site (scripts/images.mjs add)
// cropped: cut down (images.mjs add trims a scan inside its borders; images.mjs crop)
// treated: given the design's imagery treatment (images.mjs add and treat; scripts/lib/treatment.mjs)
// alt: its description for screen readers written by the agent
// drew: drawn by the agent (scripts/logo.mjs pick: the logo and everything made from it)
// generated: made with an image generator (scripts/generate-image.mjs use)
export const STEPS = ["chose", "cropped", "treated", "alt", "drew", "generated"];

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const end = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const fileName = (f) => String(f || "").split("/").pop();

// Where each image is used: file name → [{ page, slug, where, framed }]. `pages` maps a page's slug to its content
// (src/content/<slug>.json). `where` names the spot on the page: the top for the first section's picture, otherwise
// the card or section headline the picture sits under. `framed` is true when the page gives it a focal point.
export function placements(pages) {
  const out = new Map();
  for (const [slug, page] of Object.entries(pages || {})) {
    const title = slug === "home" ? "Home" : page?.title || slug;
    (page?.sections || []).forEach((section, index) => {
      const visit = (value, holder) => {
        if (Array.isArray(value)) return value.forEach((v) => visit(v, holder));
        if (!value || typeof value !== "object") return;
        if (typeof value.src === "string" && !/^https?:/.test(value.src)) {
          const label = holder === section ? (index === 0 ? "top of the page" : section.headline) : holder.title || holder.headline || holder.name;
          const place = { page: title, slug, where: plain(label), framed: value.focalX !== undefined || value.focalY !== undefined };
          out.set(fileName(value.src), [...(out.get(fileName(value.src)) || []), place]);
          return;
        }
        // A card, a person or a door with its own title names the pictures inside it.
        const next = value !== section && (value.title || value.headline || value.name) ? value : holder;
        for (const v of Object.values(value)) visit(v, next);
      };
      visit(section, section);
    });
  }
  return out;
}

// Headline markup (**bold**, *italic*, ==accent==, [label](/path)) as plain words.
function plain(text) {
  return String(text || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|\*|==)/g, "").replace(/\s+/g, " ").trim();
}

// "the top of the Home page; “Your own funding page” on Home and Services": each spot once, with the pages it is on.
export function whereText(places) {
  const byWhere = new Map();
  for (const p of places || []) byWhere.set(p.where || "", [...new Set([...(byWhere.get(p.where || "") || []), p.page])]);
  return [...byWhere].map(([where, pages]) => {
    if (where === "top of the page") return `the top of the ${list(pages)} page${pages.length > 1 ? "s" : ""}`;
    return where ? `“${where}” on ${list(pages)}` : list(pages);
  }).join("; ");
}

// Where an archive photo came from, in words.
function archiveOf(c) {
  if (c.archive) return `the ${c.archive}`.replace(/^the the /i, "the ");
  if (/loc\.gov/.test(c.url || "")) return "the Library of Congress";
  if (c.source === "openverse") return "Openverse";
  return "a photo library";
}

// The site's look in words, from a treatment's record ("Converted to black and white, film grain added.").
function lookOf(c) {
  const t = String(c.treated || c.changes || "").toLowerCase();
  const parts = [/black and white/.test(t) && "black and white", /duotone/.test(t) && "duotone", /tinted/.test(t) && "tinted", /warmed/.test(t) && "warmed", /cooled/.test(t) && "cooled"].filter(Boolean);
  const look = parts.join(", ");
  return /grain/.test(t) ? (look ? `${look} with film grain` : "film grain") : look;
}

// What AI did with one image, as one sentence in the order the work was done ("" when the records name nothing).
// The model is named once, in the summary.
export function aiText(c, { places = [] } = {}) {
  const steps = Array.isArray(c.ai) ? c.ai : [];
  const did = [];
  if (steps.includes("chose")) did.push(`chose it from ${archiveOf(c)}`);
  if (steps.includes("generated")) did.push(`made it with ${c.model || "an image generator"}`);
  if (steps.includes("drew")) did.push("drew it");
  if (steps.includes("cropped")) did.push(`cropped it${/inside the scan's borders/.test(c.changes || "") ? " inside the scan's borders" : ""}`);
  if (places.some((p) => p.framed)) did.push("framed it for each layout (what stays in view where a layout cuts it to fit)");
  if (steps.includes("treated")) did.push(lookOf(c) ? `gave it the site's look (${lookOf(c)})` : "gave it the site's look");
  if (steps.includes("alt")) did.push("wrote its description for screen readers");
  if (c.spot) did.push(`added one spot of colour to ${String(c.spot.what || "one object").replace(/\.$/, "")}`);
  return did.length ? `${cap(list(did))}.` : "";
}

// The page's opening paragraph: who did what, across every image that has a record.
export function aiSummary(images, { by = "an AI model", heroes = false } = {}) {
  const has = (step) => images.some((c) => Array.isArray(c.ai) && c.ai.includes(step));
  const archives = [...new Set(images.filter((c) => Array.isArray(c.ai) && c.ai.includes("chose")).map(archiveOf))];
  const looks = [...new Set(images.filter((c) => Array.isArray(c.ai) && c.ai.includes("treated")).map(lookOf).filter(Boolean))];
  const did = [
    has("chose") && `chose the photographs from ${list(archives)}`,
    (has("cropped") || images.some((c) => c.framed)) && "cropped and framed them",
    has("treated") && (looks.length === 1 ? `gave them one look (${looks[0]})` : "gave them one look"),
    has("alt") && "wrote their descriptions for screen readers",
    images.some((c) => c.spot) && "added a spot of colour to each one it lists below",
    has("drew") && "drew the logo",
    has("generated") && "made the images marked as generated",
  ].filter(Boolean);
  if (!did.length) return "";
  const parts = [`${cap(by)} did this site's picture work: it ${list(did)}. Each picture below says where it appears and what the model did with it.`];
  if (!has("generated") && has("chose")) parts.push("No photograph was made up: each one is a real photograph.");
  if (heroes) parts.push("Where words sit over a photograph at the top of a page, the page lays a dark gradient over it, or fades it into the background, so the words can be read; that is part of the site's design, made the same way, and the image files themselves are unchanged.");
  return parts.join(" ");
}
