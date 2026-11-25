// What the QA gate reads from PRODUCT.md (docs/SPEC.md section 12, "truth gate" and the copy lint): the phrases under
// "## Approved claims" that may read as proof, and the owner's own phrases under "## Owner's wording" that the copy
// lint skips. Each section runs to the next level-2 heading; comments (the template's notes) never count.
const section = (md, heading) => {
  const text = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const at = text.search(new RegExp(`^##\\s+${heading}\\s*$`, "im"));
  return at < 0 ? "" : text.slice(at).split("\n").slice(1).join("\n").split(/\n##\s/)[0];
};

// The approved claims as one lowercase text: a page's proof-like phrase passes when this text contains it.
export const approvedClaims = (md) => section(md, "Approved claims").toLowerCase();

// The owner's phrases, one per "- " line (quotes optional).
export const ownerWording = (md) => section(md, "Owner's wording").split("\n").map((l) => l.match(/^\s*-\s+"?(.+?)"?\s*$/)?.[1]).filter(Boolean);
