// Helpers for plain-text fields: paragraphs are separated by a blank line; lists have one item per line.
export const paragraphs = (text) => String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
export const lines = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);

// Inline formatting in any text field: **bold**, *italic*, ==accent== (a word or two in the accent colour) and
// [label](link), where the link starts with /, #, https://, mailto: or tel:. Everything else is escaped, so a field
// can never inject markup. Returns HTML. ==...== is the Markdown "mark" convention (markdown-it-mark, Obsidian); the
// site uses it to set a key word in the accent colour, sparingly: a word or a short phrase, never a whole sentence
// (docs/SPEC.md section 12, "Accent words").
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const ACCENT = /==([^=\n]+)==/g;
export const accentWords = (html) => html.replace(ACCENT, '<span class="accent-word">$1</span>');
// A headline: escaped, with ==accent== words and nothing else.
export const accent = (text) => accentWords(esc(String(text || "")));
export function inline(text) {
  return accentWords(esc(String(text || "")))
    .replace(/\[([^\]\n]+)\]\(((?:\/|#|https:\/\/|mailto:|tel:)[^\s)]*)\)/g, (_, label, href) =>
      `<a href="${href}" class="underline underline-offset-2"${href.startsWith("https://") ? ' rel="noopener"' : ""}>${label}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>");
}
// The same text with the formatting removed (for meta descriptions, aria labels and plain-text email).
export const plain = (text) => String(text || "").replace(ACCENT, "$1").replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, "$1").replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1$2");
