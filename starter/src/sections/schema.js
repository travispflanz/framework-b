// The section library's single source of truth. Each section is described once, in EmDash's block-type
// format, and that one description drives three things:
//   1. the Astro component that renders it (src/sections/<Name>.astro, mapped in Sections.astro);
//   2. the check of static page content (scripts/check-content.mjs);
//   3. the block types an editor sees when client editing is on (scripts/editing.mjs writes them into the seed).
// Sections never hold proof the owner didn't supply: there are deliberately no testimonial, logo-wall or
// statistics sections (docs/SPEC.md section 12, "No invented proof").
import { ICON_NAMES } from "./icons.js";

const anchor = {
  slug: "anchor_id",
  label: "Section ID (lowercase, for links like /#pricing)",
  type: "string",
  validation: { pattern: "^(?:$|[a-z][a-z0-9_-]*)$" },
};
const link = (slug, label, required = false) => ({
  slug,
  label: `${label} (starts with /, https://, mailto:, tel: or #)`,
  type: "string",
  ...(required ? { required: true } : {}),
  validation: { pattern: "^(?:$|/|#|https://|mailto:|tel:)" },
});

// An image, in EmDash's media shape ({ src, alt, ... }). On a static site src is a file in src/assets/images/,
// credited in design/credits.json; alt text is required unless the image is purely decorative.
const image = (slug, label, required = false) => ({ slug, label, type: "image", ...(required ? { required: true } : {}) });

// Layout variants (docs/SPEC.md section 12, "Section variants"): how a section is drawn, chosen per section, so
// two sites with the same content can look structurally different. The first option is the default.
export const VARIANTS = {
  fb_hero: ["split", "full-bleed", "statement", "editorial", "bento"],
  fb_steps: ["cards", "timeline", "numerals"],
  fb_features: ["grid", "bento", "list", "cards"],
  fb_pricing: ["cards"],
  fb_area: ["chips", "columns"],
  fb_faq: ["stack", "two-column"],
  fb_cta: ["card", "band"],
  fb_form: ["stacked", "split"],
  fb_split: ["side", "overlap"],
  fb_gallery: ["grid", "masonry", "strip"],
  fb_text: ["prose", "lead"],
  fb_list: ["columns", "stack"],
  fb_people: ["grid", "row"],
};
// How a section behaves on a phone (under 640 px). "auto" picks the section's own default (PHONE_AUTO).
export const PHONE = ["auto", "stack", "swipe", "collapse", "hide"];
export const PHONE_AUTO = { fb_steps: "swipe", fb_features: "collapse", fb_pricing: "swipe", fb_gallery: "swipe", fb_area: "collapse" };

const block = (slug, label, description, fields) => ({
  slug,
  label,
  description,
  category: "Sections",
  currentVersion: 1,
  versions: [{
    version: 1,
    fields: [
      ...fields,
      ...(VARIANTS[slug]?.length > 1 ? [{ slug: "variant", label: "Layout", type: "select", validation: { options: VARIANTS[slug] } }] : []),
      ...(slug === "fb_hero" ? [] : [{ slug: "phone", label: "On phones", type: "select", validation: { options: PHONE } }]),
      anchor,
    ],
  }],
});

export const SECTIONS = [
  block("fb_hero", "Hero", "The page's opening: headline, one supporting sentence, the main action and a few short reassurances", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting sentence", type: "text" },
    { slug: "primary_cta_label", label: "Main button text", type: "string" },
    link("primary_cta_url", "Main button link"),
    { slug: "secondary_cta_label", label: "Second link text", type: "string" },
    link("secondary_cta_url", "Second link"),
    { slug: "points", label: "Short reassurances (one per line, 2 to 4)", type: "text" },
    image("image", "Image beside the headline (optional)"),
  ]),
  block("fb_steps", "Steps", "How it works, as numbered steps", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting sentence", type: "text" },
    {
      slug: "steps",
      label: "Steps",
      type: "repeater",
      required: true,
      validation: {
        minItems: 2,
        maxItems: 5,
        subFields: [
          { slug: "title", label: "Step", type: "string", required: true },
          { slug: "body", label: "Details", type: "text", required: true },
        ],
      },
    },
  ]),
  block("fb_features", "Features", "Reasons to choose the business, each with an icon", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting sentence", type: "text" },
    {
      slug: "items",
      label: "Features",
      type: "repeater",
      required: true,
      validation: {
        minItems: 2,
        maxItems: 6,
        subFields: [
          { slug: "icon", label: "Icon", type: "select", required: true, options: ICON_NAMES },
          { slug: "title", label: "Title", type: "string", required: true },
          { slug: "body", label: "Details", type: "text", required: true },
        ],
      },
    },
  ]),
  block("fb_pricing", "Pricing", "Up to three plans side by side", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting sentence", type: "text" },
    {
      slug: "plans",
      label: "Plans",
      type: "repeater",
      required: true,
      validation: {
        minItems: 1,
        maxItems: 3,
        subFields: [
          { slug: "name", label: "Plan name", type: "string", required: true },
          { slug: "price", label: "Price, for example $25", type: "string", required: true },
          { slug: "period", label: "Period, for example per clean", type: "string" },
          { slug: "description", label: "One sentence about the plan", type: "text" },
          { slug: "features", label: "What's included (one per line)", type: "text" },
          { slug: "cta_label", label: "Button text", type: "string", required: true },
          link("cta_url", "Button link", true),
          { slug: "highlighted", label: "Highlight this plan", type: "boolean" },
          { slug: "badge", label: "Badge text, for example Most popular", type: "string" },
        ],
      },
    },
    { slug: "note", label: "Small print under the plans", type: "text" },
  ]),
  block("fb_area", "Service area", "Where the business works, as a list of places", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "body", label: "Supporting text", type: "text" },
    { slug: "places", label: "Places (one per line)", type: "text", required: true },
    { slug: "note", label: "Small print, for example how to ask about other areas", type: "text" },
  ]),
  block("fb_faq", "Questions", "Frequently asked questions; each answer opens in place", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting sentence", type: "text" },
    {
      slug: "items",
      label: "Questions",
      type: "repeater",
      required: true,
      validation: {
        minItems: 1,
        maxItems: 12,
        subFields: [
          { slug: "question", label: "Question", type: "string", required: true },
          { slug: "answer", label: "Answer (leave a blank line between paragraphs)", type: "text", required: true },
        ],
      },
    },
  ]),
  block("fb_cta", "Call to action", "A short closing push toward the main action", [
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "body", label: "Supporting text", type: "text" },
    { slug: "cta_label", label: "Button text", type: "string", required: true },
    link("cta_url", "Button link", true),
  ]),
  block("fb_form", "Form", "One of the site's forms (defined in site.config.json), with an introduction", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting text", type: "text" },
    { slug: "form", label: "Form ID from site.config.json, for example contact", type: "string", required: true },
  ]),
  block("fb_split", "Text and image", "A headline and text beside an image", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "body", label: "Text (leave a blank line between paragraphs)", type: "text", required: true },
    image("image", "Image", true),
    // Block-level selects keep their choices in validation.options (EmDash rejects a top-level options here).
    { slug: "image_side", label: "Image on the", type: "select", validation: { options: ["right", "left"] } },
    { slug: "cta_label", label: "Button text", type: "string" },
    link("cta_url", "Button link"),
  ]),
  block("fb_gallery", "Gallery", "A grid of images with optional captions", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting sentence", type: "text" },
    {
      slug: "items",
      label: "Images",
      type: "repeater",
      required: true,
      validation: {
        minItems: 2,
        maxItems: 12,
        subFields: [
          image("image", "Image", true),
          { slug: "caption", label: "Caption", type: "string" },
        ],
      },
    },
    { slug: "note", label: "Small print under the images", type: "text" },
  ]),
  block("fb_text", "Text", "Plain paragraphs under a headline", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string" },
    { slug: "body", label: "Text (leave a blank line between paragraphs)", type: "text", required: true },
  ]),
  block("fb_list", "Lists", "One to three short lists side by side: what's included and what isn't, rules, a checklist", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "subheadline", label: "Supporting text", type: "text" },
    {
      slug: "lists",
      label: "Lists",
      type: "repeater",
      required: true,
      validation: {
        minItems: 1,
        maxItems: 3,
        subFields: [
          { slug: "title", label: "List title", type: "string" },
          { slug: "items", label: "Items (one per line)", type: "text", required: true },
          { slug: "marker", label: "Marker", type: "select", options: ["check", "cross", "number", "dot"] },
        ],
      },
    },
    { slug: "note", label: "Text under the lists", type: "text" },
  ]),
  block("fb_people", "People", "The people behind the business, with the owner's own photos", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string", required: true },
    { slug: "body", label: "Text before the people (leave a blank line between paragraphs)", type: "text" },
    {
      slug: "people",
      label: "People",
      type: "repeater",
      required: true,
      validation: {
        minItems: 1,
        maxItems: 6,
        subFields: [
          image("image", "Photo (the owner's own)"),
          { slug: "name", label: "Name", type: "string", required: true },
          { slug: "role", label: "Role or caption", type: "string" },
          { slug: "bio", label: "A few sentences", type: "text" },
        ],
      },
    },
    { slug: "note", label: "Text after the people (leave a blank line between paragraphs)", type: "text" },
  ]),
];

export const SECTION_TYPES = SECTIONS.map((s) => s.slug);
