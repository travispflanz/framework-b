// Logo concepts (docs/SPEC.md section 12, "Logo"): the file format the agent draws in, the rules a concept must
// keep, and how one concept becomes every version of the logo. scripts/logo.mjs does the fonts, rendering and files;
// this module only works on text, so the unit tests (scripts/test/logo.test.mjs) need no browser or network.
//
// A concept is one SVG file, design/brand/concepts/<id>.svg:
//
//   <svg xmlns="http://www.w3.org/2000/svg" data-type="combination" data-idea="..." data-from="...">
//     <symbol id="mark" viewBox="auto"> ... </symbol>      the symbol on its own: favicon, app icon, avatar (square)
//     <symbol id="lockup" viewBox="auto"> ... </symbol>    the logo as the header shows it (often <use href="#mark">)
//     <symbol id="stacked" viewBox="auto"> ... </symbol>   optional: a taller arrangement for square spaces
//   </svg>
//
// - data-type: one of TYPES. data-idea: the idea in a sentence. data-from: the fact in PRODUCT.md (or the brief)
//   the idea comes from. A concept without both is a style, not an idea. data-trend: the current design move it uses
//   (from the brief's "Current design", with its source) or why it is timeless. data-look: how it belongs to the
//   site's own look (its photographs, type and colour). These are the four lenses of SPEC section 12: the business,
//   the field (the brief's sea of sameness), current design and the site's own look. data-template="true" marks a
//   template (the name in a font), which needs neither of the last two.
// - Two colours only, named by role: fill/stroke "ink" (the letters and main shapes) and "accent" (at most a detail),
//   or "none". Each version of the logo maps the roles to real colours (VARIANT_NAMES), so the one-colour and reversed
//   versions are exact and nothing is redrawn.
// - Counters, cut-outs and knockouts are holes: fill-rule="evenodd", or a <mask> (white keeps, black cuts). Never a
//   shape filled with the background colour: on another background it would show.
// - Words are <fb-text font="display|body" size x y [center-y] [anchor] [tracking] [weight] [family] fill>TEXT</fb-text>;
//   scripts/logo.mjs sets them in the font and converts them to outlines. center-y puts the capitals' middle there.
//   arc="top" or "bottom" with r, cx, cy (and at, the angle in degrees from the top) sets them along a circle, for
//   a seal. A <g transform="..."> around words or shapes may rotate, skew or move them.
// - viewBox="auto" fits the box to what is drawn (the mark's is made square). <use href="#mark" x y width height>
//   places another symbol.
// - Not allowed: <text>, <image>, <foreignObject>, <script>, <style>, style="", filters, gradients, patterns, links
//   to other files. A logo is flat shapes that print in one colour.

export const TYPES = ["wordmark", "lettermark", "pictorial", "abstract", "combination", "emblem", "mascot"];

// The logo brief (design/brand/brief.md): written before any concept is drawn, from PRODUCT.md, the design and a
// look at what similar businesses use. Level-2 headings, in this order.
export const BRIEF = [
  ["The business", "What it does, what it is trying to achieve (the one action a visitor should take, how it earns, where it is going), what it promises and refuses, and its name as it must appear. From PRODUCT.md and design/research.md."],
  ["Who it must reach", "Who sees the logo, and where they first meet it (a printed card, a search result, a phone)."],
  ["Feel", "Three words the logo should feel like, and three it must not."],
  ["The site's own look", "The route in DESIGN.md, the photographs (their era, subjects and texture), the type and the colour: the logo has to belong on these pages and photos. If the look is nostalgic, say exactly for whom and for what."],
  ["Current design", "What logo and brand design is doing now, outside this field too, from dated trend reports and galleries of the last 12 months: the currents that fit this business and why, the ones to avoid and why, and how the logo stays current without dating fast."],
  ["Sea of sameness", "What similar businesses' logos do, with where you looked and the date. The concepts must not look like these."],
  ["Clichés to avoid", "The symbols every logo in this field reaches for, and any that would mislead (a promise the business doesn't make)."],
  ["Ideas from the brand's own world", "Things only this business has: its story, its customers' world, its site's own look. One line each, with the fact it comes from."],
  ["Where it must work", "Every place it will be used, smallest first: favicon (16 px), header, phone, social avatar (circle), print in one colour."],
  ["Keep", "What carries over from the current identity, if anything (colours, the name's styling, a symbol people already know)."],
];
export const BRIEF_PLACEHOLDER = "To be written.";

// Headings of the brief that are missing or unwritten.
export function briefProblems(md) {
  const text = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const parts = Object.fromEntries(text.split(/^##\s+/m).slice(1).map((p) => { const [h, ...rest] = p.split("\n"); return [h.trim(), rest.join("\n").trim()]; }));
  return BRIEF.map(([h]) => h).filter((h) => !parts[h] || parts[h] === BRIEF_PLACEHOLDER).map((h) => (parts[h] === undefined ? `"${h}" is missing` : `"${h}" isn't written`));
}

export function briefTemplate(name) {
  return `# Logo brief: ${name}\n\n<!-- Written before any concept is drawn (docs/BUILD.md step 3, "Logo"). Each section: what it asks for is in the
comment under its heading. Check it with \`node scripts/logo.mjs check\`. -->\n\n${BRIEF.map(([h, ask]) => `## ${h}\n\n<!-- ${ask} -->\n${BRIEF_PLACEHOLDER}\n`).join("\n")}`;
}
export const ROLES = ["ink", "accent"];
export const VARIANT_NAMES = ["on-dark", "on-light", "black", "white"];
const BANNED = ["text", "image", "foreignObject", "script", "style", "filter", "linearGradient", "radialGradient", "pattern", "a", "iframe", "animate", "animateTransform", "set"];
// Lines and shapes that must be seen hold 3:1 against what they sit on (WCAG 2.2 SC 1.4.11). Logos are exempt, but the
// header logo is also the home link, and W3C's advice for a logo that is a control is a version that meets it.
export const LOGO_CONTRAST = 3;

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`))?.[1];
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
export const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// { meta, symbols: { id: { viewBox, body } }, problems } from a concept file's text.
export function parseConcept(text) {
  const src = String(text || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/, "").trim();
  const root = src.match(/^<svg\b[^>]*>/)?.[0];
  const meta = root ? {
    type: attr(root, "data-type") || "", idea: decode(attr(root, "data-idea") || ""), from: decode(attr(root, "data-from") || ""),
    trend: decode(attr(root, "data-trend") || ""), look: decode(attr(root, "data-look") || ""), name: decode(attr(root, "data-name") || ""),
    template: attr(root, "data-template") === "true",
  } : {};
  const symbols = {};
  for (const m of src.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const id = attr(` ${m[1]}`, "id");
    if (id) symbols[id] = { viewBox: attr(` ${m[1]}`, "viewBox") || "", body: m[2].trim() };
  }
  return { meta, symbols, root: !!root, src };
}

// Everything wrong with a concept, as sentences (an empty list means it can be built).
export function lintConcept(concept) {
  const out = [];
  const { meta, symbols, src } = concept;
  if (!concept.root) return ["the file doesn't start with <svg>"];
  if (!TYPES.includes(meta.type)) out.push(`data-type is "${meta.type}"; use one of ${TYPES.join(", ")}`);
  if (meta.idea.trim().length < 12) out.push("data-idea is missing: say the idea in a sentence");
  if (meta.from.trim().length < 6) out.push("data-from is missing: name the fact in PRODUCT.md or the brief the idea comes from");
  // The four lenses (SPEC section 12): the business (data-from), the field (the brief's sea of sameness), current
  // design (data-trend) and the site's own look (data-look). Templates are the name in a font and skip the last two.
  if (!meta.template) {
    if (meta.trend.trim().length < 6) out.push("data-trend is missing: name the current design move it uses, from the brief's Current design, or why it is timeless");
    if (meta.look.trim().length < 6) out.push("data-look is missing: say how it belongs to the site's own look (its photographs, type and colour)");
  }
  for (const id of ["mark", "lockup"]) if (!symbols[id]) out.push(`no <symbol id="${id}">`);
  for (const [id, s] of Object.entries(symbols)) {
    if (s.viewBox !== "auto" && !/^-?[\d.]+\s+-?[\d.]+\s+[\d.]+\s+[\d.]+$/.test(s.viewBox.trim())) out.push(`symbol "${id}": viewBox "${s.viewBox}" (four numbers, or "auto")`);
    if (id === "mark" && s.viewBox !== "auto") {
      const [, , w, h] = s.viewBox.trim().split(/\s+/).map(Number);
      if (Math.abs(w - h) > 0.01 * Math.max(w, h)) out.push(`symbol "mark" isn't square (${w} × ${h}); use viewBox="auto" or a square box`);
    }
  }
  for (const tag of BANNED) if (new RegExp(`<${tag}[\\s>/]`, "i").test(src)) out.push(`<${tag}> isn't allowed in a logo`);
  if (/\sstyle\s*=/.test(src)) out.push('style="" isn\'t allowed: use fill and stroke with "ink" or "accent"');
  for (const m of src.matchAll(/\s(?:xlink:)?href\s*=\s*"([^"]*)"/g)) if (!m[1].startsWith("#")) out.push(`a link to "${m[1]}": a logo can only refer to its own symbols`);
  for (const m of src.matchAll(/<use\b[^>]*>/g)) {
    const ref = attr(m[0], "href") || attr(m[0], "xlink:href");
    if (ref?.startsWith("#") && !symbols[ref.slice(1)] && !new RegExp(`id="${ref.slice(1)}"`).test(src)) out.push(`<use> refers to "${ref}", which isn't in the file`);
  }
  // Colours: roles outside masks, white or black inside them.
  const masks = [...src.matchAll(/<mask\b[\s\S]*?<\/mask>/g)].map((m) => [m.index, m.index + m[0].length]);
  const inMask = (i) => masks.some(([a, b]) => i > a && i < b);
  for (const m of src.matchAll(/\s(fill|stroke)\s*=\s*"([^"]*)"/g)) {
    const v = m[2].trim();
    if (v === "none" || ROLES.includes(v)) {
      if (ROLES.includes(v) && inMask(m.index)) out.push(`${m[1]}="${v}" inside a <mask>: a mask uses white (keep) and black (cut)`);
      continue;
    }
    if (inMask(m.index) && /^(white|black|#fff|#ffffff|#000|#000000)$/i.test(v)) continue;
    if (/^url\(#[^)]+\)$/.test(v)) { out.push(`${m[1]}="${v}": gradients and patterns aren't allowed`); continue; }
    out.push(`${m[1]}="${v}": use "ink" or "accent" (white and black only inside a <mask>)`);
  }
  if (!/fill="ink"|stroke="ink"|<fb-text\b(?![^>]*fill=)/.test(src) && !/fill="accent"|stroke="accent"/.test(src)) out.push('nothing is drawn in "ink" or "accent"');
  const texts = [...src.matchAll(/<fb-text\b([^>]*)>([\s\S]*?)<\/fb-text>/g)];
  if (/<fb-text\b[^>]*\/>/.test(src)) out.push("<fb-text/> needs its words between the tags");
  for (const t of texts) {
    const a = ` ${t[1]}`;
    if (!["display", "body", undefined].includes(attr(a, "font"))) out.push(`<fb-text font="${attr(a, "font")}">: use "display" or "body" (or family="<Fontsource family>")`);
    if (!(Number(attr(a, "size")) > 0)) out.push(`<fb-text> "${t[2].trim()}" needs size`);
    if (!decode(t[2]).trim()) out.push("an empty <fb-text>");
  }
  return out;
}

// The colours of each version: { ink, accent, paper, notes }. `colors` is DESIGN.md's colours. The dark and light
// papers come from the design (its page colour and its inverse band), so the logo matches the site on both.
export function variantPalettes(colors) {
  const C = colors || {};
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v).toLowerCase() : null);
  const pageDark = luminance(hex(C.bg) || "#ffffff") < 0.18;
  const pageSet = { paper: hex(C.bg) || "#ffffff", ink: hex(C.ink) || (pageDark ? "#ffffff" : "#000000"), accent: hex(C.accent) || hex(C.ink) };
  const inverseSet = hex(C["inverse-bg"]) ? { paper: hex(C["inverse-bg"]), ink: hex(C["inverse-ink"]) || (pageDark ? "#000000" : "#ffffff"), accent: hex(C["inverse-accent"]) || hex(C.accent) } : null;
  const fallbackDark = { paper: "#000000", ink: "#ffffff", accent: hex(C.accent) || "#ffffff" };
  const fallbackLight = { paper: "#ffffff", ink: "#000000", accent: hex(C.accent) || "#000000" };
  const dark = pageDark ? pageSet : inverseSet && luminance(inverseSet.paper) < 0.18 ? inverseSet : fallbackDark;
  const light = !pageDark ? pageSet : inverseSet && luminance(inverseSet.paper) >= 0.18 ? inverseSet : fallbackLight;
  const out = {
    "on-dark": { ...dark, notes: [] },
    "on-light": { ...light, notes: [] },
    black: { paper: "#ffffff", ink: "#000000", accent: "#000000", notes: [] },
    white: { paper: "#000000", ink: "#ffffff", accent: "#ffffff", notes: [] },
  };
  for (const [name, v] of Object.entries(out)) {
    const inkRatio = ratio(v.ink, v.paper);
    if (inkRatio < LOGO_CONTRAST) v.notes.push(`ink ${v.ink} is ${inkRatio.toFixed(2)}:1 on ${v.paper}`);
    const accentRatio = ratio(v.accent, v.paper);
    if (accentRatio < LOGO_CONTRAST) {
      v.notes.push(`the accent ${v.accent} is ${accentRatio.toFixed(2)}:1 on ${v.paper}, under ${LOGO_CONTRAST}:1, so the ${name} version draws the accent in ink`);
      v.accent = v.ink;
    }
  }
  out.pageVariant = pageDark ? "on-dark" : "on-light";
  return out;
}

export function luminance(h) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Ids inside a symbol, prefixed so two symbols placed in one file can't collide.
function scopeIds(body, prefix) {
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  let out = body;
  for (const id of ids) {
    out = out.replace(new RegExp(`\\sid="${id}"`, "g"), ` id="${prefix}-${id}"`).replace(new RegExp(`url\\(#${id}\\)`, "g"), `url(#${prefix}-${id})`).replace(new RegExp(`href="#${id}"`, "g"), `href="#${prefix}-${id}"`);
  }
  return out;
}

// One symbol as SVG content in the symbol's own units, with words set and other symbols placed:
//   text(attrs, words) -> { d, ... } sets an <fb-text> (scripts/logo.mjs passes the font code in).
//   boxes: { id: "x y w h" } for symbols whose viewBox was "auto" (measured by scripts/logo.mjs).
export function expandSymbol(concept, id, { text, boxes = {} }, depth = 0) {
  const s = concept.symbols[id];
  if (!s) throw new Error(`no symbol "${id}"`);
  if (depth > 3) throw new Error(`symbol "${id}" places itself`);
  let body = s.body.replace(/<fb-text\b([^>]*)>([\s\S]*?)<\/fb-text>/g, (_, a, words) => {
    const attrs = Object.fromEntries([...` ${a}`.matchAll(/\s([\w-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const { d } = text(attrs, decode(words).trim());
    return `<path fill="${attrs.fill || "ink"}" d="${d}"/>`;
  });
  body = body.replace(/<use\b([^>]*?)\/?>(?:<\/use>)?/g, (whole, a) => {
    const ref = (attr(` ${a}`, "href") || attr(` ${a}`, "xlink:href") || "").replace(/^#/, "");
    if (!concept.symbols[ref]) return whole;
    const box = boxOf(concept, ref, boxes);
    const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => attr(` ${a}`, k));
    const inner = expandSymbol(concept, ref, { text, boxes }, depth + 1);
    return `<svg x="${x || 0}" y="${y || 0}" width="${w || box[2]}" height="${h || box[3]}" viewBox="${box.join(" ")}" overflow="visible">${scopeIds(inner, `${ref}${depth}`)}</svg>`;
  });
  return body;
}

export function boxOf(concept, id, boxes = {}) {
  const v = concept.symbols[id]?.viewBox;
  if (v && v !== "auto") return v.trim().split(/\s+/).map(Number);
  if (boxes[id]) return boxes[id];
  throw new Error(`symbol "${id}" has viewBox="auto" and hasn't been measured`);
}

// The roles replaced with one version's colours.
export function paint(content, palette) {
  return content.replace(/(\s(?:fill|stroke)\s*=\s*")(ink|accent)(")/g, (_, a, role, b) => `${a}${palette[role]}${b}`);
}

// A finished, standalone SVG file.
export function svgFile(content, box, { label = "", height } = {}) {
  const [x, y, w, h] = box;
  const H = height || h;
  const W = (w / h) * H;
  const r = (n) => Number(n.toFixed(2));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(x)} ${r(y)} ${r(w)} ${r(h)}" width="${r(W)}" height="${r(H)}"${label ? ` role="img" aria-label="${escapeXml(label)}"` : ' aria-hidden="true"'}>${content}</svg>`;
}

// Square box around a measured one (the mark's), centred.
export function squareBox([x, y, w, h]) {
  const s = Math.max(w, h);
  return [x - (s - w) / 2, y - (s - h) / 2, s, s];
}

// The sizes the logo sheet shows the logo at; the smallest of them are the logo's minimum sizes (nothing smaller
// has been looked at). The header shows the lockup 36 px tall (src/layouts/Base.astro, h-9).
export const SHEET_SIZES = { headerPx: 36, lockupPx: [24, 36, 72], markPx: [16, 32, 48], card: { widthIn: 3.5, heightIn: 2, lockupHeightIn: 0.25 } };

// What a person reads in logo.json and the style guide: the space to keep clear and the smallest sizes, in the
// logo's own terms. Clear space is a share of the lockup's height (data-clear on the concept, default a quarter).
export function usage(box, { clear = 0.25 } = {}) {
  const [, , w, h] = box;
  const pct = Math.round(clear * 100);
  return {
    aspect: Number((w / h).toFixed(3)),
    clearSpace: { share: clear, rule: `Keep clear space of ${pct}% of the logo's height on every side.` },
    minimum: {
      lockupPx: Math.min(...SHEET_SIZES.lockupPx),
      markPx: Math.min(...SHEET_SIZES.markPx),
      lockupHeightMm: Math.ceil(SHEET_SIZES.card.lockupHeightIn * 25.4 * 10) / 10,
      rule: "The smallest sizes the logo sheet checks it at: on screens, the logo 24 px tall and the mark 16 px; in print, the logo 6.4 mm tall (as on the business card). Below these, use the mark.",
    },
    headerWidthPx: Math.round(SHEET_SIZES.headerPx * (w / h)),
  };
}
