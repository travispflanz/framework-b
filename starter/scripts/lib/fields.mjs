// Form fields keep a box's shape (QA gate). Form.astro rounds text fields with --radius-field (DESIGN.md's
// rounded.field, by default the smaller of rounded.control and rounded.card), not the buttons' radius: a pill button
// radius (999px) on the contact form's message box drew an oval (roadmap step 2, 2026-11-18).
// A multi-line field whose corners take more than two thirds of its height reads as an oval, so it fails.
export const OVAL_SHARE = 1 / 3;

// rounded.field when DESIGN.md doesn't name it (scripts/design-tokens.mjs): the smaller of rounded.control and
// rounded.card, written as that token's own value, so the field's radius is always one of DESIGN.md's (Impeccable
// checks every radius against them). A unit this can't compare (a percentage) leaves the choice to the browser.
export function fieldRadius({ control, card }) {
  const size = (v) => {
    const m = String(v).trim().match(/^(-?(?:\d+\.?\d*|\.\d+))(px|rem|em)?$/);
    return m ? Number(m[1]) * (m[2] === "rem" || m[2] === "em" ? 16 : 1) : null;
  };
  const [a, b] = [size(control), size(card)];
  if (a === null || b === null) return "min(var(--radius-control), var(--radius-card))";
  return String(a <= b ? control : card);
}

// { radius, height }: the field's largest vertical corner radius as styled, and its height, in px. The browser
// draws a radius no larger than half the box, so a 999px radius on a 146px field is a 73px one.
export function ovalField({ radius, height }) {
  if (!(height > 0)) return false;
  return Math.min(radius, height / 2) > height * OVAL_SHARE;
}

// The page's multi-line fields as drawn: [{ name, radius, height }].
export function multiLineFields(page) {
  return page.evaluate(() => [...document.querySelectorAll("textarea")].filter((el) => el.getClientRects().length).map((el) => {
    const { height } = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    // A corner radius is "Xpx", "X%" or "Xpx Ypx" (horizontal, vertical); the vertical one decides the shape here.
    const vertical = (v) => {
      const last = String(v).trim().split(/\s+/).pop();
      return last.endsWith("%") ? (parseFloat(last) / 100) * height : parseFloat(last) || 0;
    };
    const radius = Math.max(...["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].map((k) => vertical(style[k])));
    return { name: el.name || el.id || "textarea", radius: Math.round(radius), height: Math.round(height) };
  }));
}
