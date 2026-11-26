// What the QA gate reads from PRODUCT.md (docs/SPEC.md section 12, "truth gate" and the copy lint): the phrases under
// "## Approved claims" that may read as proof, and the owner's own phrases under "## Owner's wording" that the copy
// lint skips. A section starts at its heading (level 2 or deeper; text after the name, such as a date, is allowed) and
// runs to the next heading of the same level or higher, so its own subheadings stay in it; comments (the template's
// notes) never count.
const section = (md, heading) => {
  const lines = String(md || "").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const level = (line) => line.match(/^(#{1,6})\s/)?.[1].length || 0;
  const start = lines.findIndex((l) => level(l) >= 2 && new RegExp(`^#{2,6}\\s+${heading}\\b`, "i").test(l));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && level(l) && level(l) <= level(lines[start]));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
};

// The approved claims as one lowercase text: a page's proof-like phrase passes when this text contains it.
export const approvedClaims = (md) => section(md, "Approved claims").toLowerCase();

// The owner's phrases, one per "- " line (quotes optional).
export const ownerWording = (md) => section(md, "Owner's wording").split("\n").map((l) => l.match(/^\s*-\s+"?(.+?)"?\s*$/)?.[1]).filter(Boolean);
