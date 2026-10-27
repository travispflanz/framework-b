#!/usr/bin/env node
// CI fixture: turns the starter into a small full site with images, so the build, e2e and QA gate cover extra
// pages (src/pages/[page].astro), the hero image, the text-and-image and gallery sections, optimized images and
// the credits page. Images are generated abstract gradients (credited as such), so no network is needed.
// Never run it in a real site.
//   node scripts/test/fixture-full-site.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const hue = (h) => `hsl(${h} 45% 55%)`;
mkdirSync("src/assets/images", { recursive: true });
const credits = JSON.parse(readFileSync("design/credits.json", "utf8"));
for (const [i, name] of ["fixture-a", "fixture-b", "fixture-c"].entries()) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${hue(30 + i * 90)}"/><stop offset="1" stop-color="${hue(120 + i * 90)}"/></linearGradient></defs>
    <rect width="1600" height="1200" fill="url(#g)"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(`src/assets/images/${name}.jpg`);
  credits.images.push({ file: `src/assets/images/${name}.jpg`, source: "generated", abstract: true, alt: "Abstract colour gradient", note: "CI fixture" });
}
// One stock-style credit, so the footer link and the credits page render (points at an existing fixture file).
credits.images.find((c) => c.file.endsWith("fixture-c.jpg")).source = "stock";
Object.assign(credits.images.find((c) => c.file.endsWith("fixture-c.jpg")), { creator: "Example Photographer", license: "CC BY 2.0", license_url: "https://creativecommons.org/licenses/by/2.0/", url: "https://example.com/photo" });
writeFileSync("design/credits.json", JSON.stringify(credits, null, 2) + "\n");

const img = (src, alt) => ({ src, alt });
writeFileSync("src/content/about.json", JSON.stringify({
  title: "About",
  description: "About Example Co.",
  sections: [
    { _type: "fb_hero", _key: "hero", headline: "About Example Co.", subheadline: "A second page built from the section library.", image: img("fixture-a.jpg", "Abstract colour gradient") },
    { _type: "fb_split", _key: "story", headline: "How we work", body: "First paragraph.\n\nSecond paragraph.", image: img("fixture-b.jpg", "Abstract colour gradient"), image_side: "left", cta_label: "Contact us", cta_url: "/contact" },
    { _type: "fb_gallery", _key: "gallery", headline: "Gallery", items: [
      { image: img("fixture-a.jpg", "Abstract colour gradient"), caption: "First" },
      { image: img("fixture-b.jpg", "Abstract colour gradient"), caption: "Second" },
      { image: img("fixture-c.jpg", "Abstract colour gradient") },
    ] },
  ],
}, null, 2) + "\n");
const site = JSON.parse(readFileSync("site.config.json", "utf8"));
site.nav.splice(Math.max(0, site.nav.length - 1), 0, { label: "About", href: "/about" });
writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");
console.log("Full-site fixture: /about with hero image, text and image, gallery; 3 credited images");
