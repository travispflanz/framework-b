// The site's composition and imagery choices (generated from DESIGN.md into src/styles/design.json by
// scripts/design-tokens.mjs), and helpers that resolve a section's layout variant and phone behaviour.
import design from "../styles/design.json";
import { PHONE_AUTO, VARIANTS } from "./schema.js";

export const composition = design.composition;
export const imagery = design.imagery;

export const variantOf = (type, value) => {
  const options = VARIANTS[type] || [];
  return options.includes(value?.variant) ? value.variant : options[0];
};

export const phoneOf = (type, value) => {
  const v = value?.phone && value.phone !== "auto" ? value.phone : PHONE_AUTO[type] || "stack";
  return v;
};
