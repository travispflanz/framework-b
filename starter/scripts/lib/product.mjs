// What the QA gate reads from PRODUCT.md (docs/SPEC.md section 12, "truth gate" and the copy lint): the phrases under
// "## Approved claims" that may read as proof, and the owner's own phrases under "## Owner's wording" that the copy
// lint skips. A section starts at its heading (level 2 or deeper; text after the name, such as a date, is allowed) and
// runs to the next heading of the same level or higher, so its own subheadings stay in it; comments (the template's
// notes) never count. Headings are read as CommonMark reads ATX headings: up to three spaces may come before the #s
// (an indented "  ## Next" once let the claims run on into the next section), and a # line inside a fenced code block
// (``` or ~~~) is code, not a heading (a "# comment" in a code block once cut the section short) (CommonMark 0.31.2,
// sections 4.2 "ATX headings" and 4.5 "Fenced code blocks": https://spec.commonmark.org/0.31.2/, checked 2026-11-27).
// Setext headings (a line underlined with === or ---) are not read; the template uses # headings only.
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const level = (line) => line.match(/^ {0,3}(#{1,6})(?:[ \t]|$)/)?.[1].length || 0;

// Each line's heading level, 0 for a line that isn't a heading (any line inside a fenced code block). A fence closes
// on a line of the same character at least as long as the one that opened it, with nothing after it. A fence that
// never closes runs to the end in CommonMark, but here its opening line is plain text and the lines after it are read
// as usual: a stray ``` in "Approved claims" would otherwise carry the section to the end of the file and approve
// everything after it, so the gate fails closed. A stray fence before a real code block still pairs with that block's
// opening fence, as it does on GitHub; no parser can tell which of the two was the stray one.
const opens = (line) => { const f = line.match(FENCE); return f && !(f[1][0] === "`" && line.slice(f[0].length).includes("`")) ? f : null; };
const closes = (line, fence) => { const f = line.match(FENCE); return !!f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim(); };
export function headingLevels(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const f = opens(lines[i]);
    const end = f ? lines.findIndex((l, j) => j > i && closes(l, f[1])) : -1;
    if (end < 0) { out.push(f ? 0 : level(lines[i])); continue; }
    for (; i <= end; i++) out.push(0);
    i = end;
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const section = (md, heading) => {
  const lines = String(md || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n").split("\n");
  const levels = headingLevels(lines);
  const named = new RegExp(`^ {0,3}#{2,6}[ \\t]+${escapeRe(heading)}\\b`, "i");
  const start = lines.findIndex((l, i) => levels[i] >= 2 && named.test(l));
  if (start < 0) return "";
  const end = levels.findIndex((n, i) => i > start && n && n <= levels[start]);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
};

// The approved claims as one lowercase text: a page's proof-like phrase passes when this text contains it.
export const approvedClaims = (md) => section(md, "Approved claims").toLowerCase();

// The owner's phrases, one per "- " line (quotes optional).
export const ownerWording = (md) => section(md, "Owner's wording").split("\n").map((l) => l.match(/^\s*-\s+"?(.+?)"?\s*$/)?.[1]).filter(Boolean);
