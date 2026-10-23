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

const block = (slug, label, description, fields) => ({
  slug,
  label,
  description,
  category: "Sections",
  currentVersion: 1,
  versions: [{ version: 1, fields: [...fields, anchor] }],
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
  block("fb_text", "Text", "Plain paragraphs under a headline", [
    { slug: "eyebrow", label: "Small label above the headline", type: "string" },
    { slug: "headline", label: "Headline", type: "string" },
    { slug: "body", label: "Text (leave a blank line between paragraphs)", type: "text", required: true },
  ]),
];

export const SECTION_TYPES = SECTIONS.map((s) => s.slug);
