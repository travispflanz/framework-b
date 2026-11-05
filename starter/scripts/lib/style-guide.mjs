// The site's style guide (docs/SPEC.md section 12, "Style guide"): STYLE-GUIDE.md holds what a person writes (who
// the brand is for, how the logo, colour, type, photographs, layout, components and words are used, and how the brand
// goes beyond the website); scripts/style-guide.mjs renders it together with the site's real tokens, components and
// pages into design/style-guide/style-guide.pdf. This module has the parts both of them and the checks share; it
// imports nothing, because the guide page imports it and an editing site prerenders inside the Workers runtime.

// Every guide has these sections, in this order (level-2 headings in STYLE-GUIDE.md).
export const REQUIRED = ["Brand", "Logo", "Colour", "Type", "Photography", "Layout and page flow", "Components", "Voice", "Beyond the website", "Do and don't"];

// The text the starter's template leaves under each heading until the guide is written.
export const PLACEHOLDER = "To be written once the design is chosen.";

const stripComments = (md) => String(md || "").replace(/<!--[\s\S]*?-->/g, "");

// { title, sections: [{ heading, body }] }: level-2 sections, comments removed.
export function parseGuide(md) {
  const text = stripComments(md).replace(/\r\n/g, "\n");
  const title = text.match(/^#\s+(.+)$/m)?.[1].trim() || "Style guide";
  const parts = text.split(/^##\s+/m).slice(1);
  return { title, sections: parts.map((p) => { const [first, ...rest] = p.split("\n"); return { heading: first.trim(), body: rest.join("\n").trim() }; }) };
}

export function missingSections(md) {
  const have = new Set(parseGuide(md).sections.map((s) => s.heading));
  return REQUIRED.filter((h) => !have.has(h));
}

// Sections still holding the template's placeholder (or nothing).
export function unwritten(md) {
  return parseGuide(md).sections.filter((s) => REQUIRED.includes(s.heading) && (!s.body || s.body === PLACEHOLDER)).map((s) => s.heading);
}

// A small, safe subset of Markdown for the guide's prose: paragraphs, "- " lists, "### " subheadings and the inline
// formatting the site's text fields use (**bold**, *italic*, [label](link)), plus `code`. `inline` is the site's own
// (src/sections/text.js), passed in so this module has no site imports. Returns HTML.
export function renderProse(md, rawInline) {
  // `code` spans (file names, commands) are kept as written; everything else goes through the site's inline format.
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (t) => String(t).split(/`([^`]+)`/).map((part, i) => (i % 2 ? `<code>${esc(part)}</code>` : rawInline(part))).join("");
  const blocks = String(md || "").split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => {
    if (b.startsWith("### ")) return `<h3>${inline(b.slice(4))}</h3>`;
    // A block may start with a sentence and go on into a list ("They choose from three heroes:" then "- ..." lines).
    const out = [];
    let para = [], list = [];
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
    const flushList = () => { if (list.length) out.push(`<ul>${list.map((r) => `<li>${inline(r)}</li>`).join("")}</ul>`); list = []; };
    for (const row of b.split("\n")) {
      if (/^-\s+/.test(row)) { flushPara(); list.push(row.replace(/^-\s+/, "")); }
      else { flushList(); para.push(row); }
    }
    flushPara();
    flushList();
    return out.join("");
  }).join("\n");
}

// Beyond the website: sizes and print settings from the platforms' and a printer's own pages. Each one says where it
// comes from and when it was checked; platforms change these, so check again before a big job.
export const SPECS = [
  { use: "Share image (link previews)", spec: "1200 × 630 px or larger", source: "Meta for Developers, Images in Link Shares", url: "https://developers.facebook.com/docs/sharing/webmasters/images", checked: "2026-11-04" },
  { use: "Instagram post", spec: "1080 px wide, from 1.91:1 to 3:4 (1080 × 566 to 1080 × 1440 px)", source: "Instagram Help Center, Image resolution of photos you share on Instagram", url: "https://help.instagram.com/1631821640426723", checked: "2026-11-04" },
  { use: "Stories and Reels (Instagram, Facebook)", spec: "9:16, the whole phone screen (1080 × 1920 px at Instagram's 1080 px width)", source: "Meta Business Help Center, Best practices for aspect ratios", url: "https://www.facebook.com/business/help/103816146375741", checked: "2026-11-04" },
  { use: "Facebook Page profile picture", spec: "320 × 320 px, cropped to a circle", source: "Facebook Help Center, Facebook Page profile picture and cover photo dimensions", url: "https://www.facebook.com/help/125379114252045", checked: "2026-11-04" },
  { use: "Facebook Page cover", spec: "851 × 315 px sRGB JPG under 100 KB (at least 400 × 150 px); the profile picture covers part of the left side", source: "Facebook Help Center, Facebook Page profile picture and cover photo dimensions", url: "https://www.facebook.com/help/125379114252045", checked: "2026-11-04" },
  { use: "LinkedIn Page logo and cover", spec: "Logo 400 × 400 px (at least 268 × 268); cover 1512 × 256 px", source: "LinkedIn Help, Image specifications for your LinkedIn Pages and Career Pages", url: "https://www.linkedin.com/help/linkedin/answer/a563309", checked: "2026-11-04" },
  { use: "X profile and header", spec: "Profile 400 × 400 px under 2 MB; header 1500 × 500 px (about 60 px at the top and bottom may be cropped)", source: "X Help Center, Help with uploading a profile photo", url: "https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo", checked: "2026-11-04" },
  { use: "YouTube channel banner", spec: "2560 × 1440 px (at least 2048 × 1152, 16:9); text and logos inside the middle 1235 × 338 px; 6 MB or less", source: "YouTube Help, Manage your channel branding", url: "https://support.google.com/youtube/answer/10456525", checked: "2026-11-04" },
  { use: "Business card (US)", spec: "Trim 3.5 × 2 in; Vistaprint's full bleed 3.61 × 2.11 in and safe area 3.36 × 1.86 in; images 300 DPI at printed size; text 8 pt or larger; CMYK with the printer's profile; print-ready PDF", source: "Vistaprint, Business Card Design Rules", url: "https://www.vistaprint.com/hub/business-card-design-rules", checked: "2026-11-04" },
  { use: "Flyer", spec: "Backgrounds 0.125 in past the trim on each side; text, logos and QR codes 0.25 in inside it; 300 DPI images; CMYK; print-ready PDF with the fonts embedded", source: "Vistaprint, How to Design a Flyer That Works", url: "https://www.vistaprint.com/hub/how-to-design-a-flyer", checked: "2026-11-04" },
];
