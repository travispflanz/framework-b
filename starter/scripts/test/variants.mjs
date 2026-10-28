#!/usr/bin/env node
// CI check of every section layout variant and the second set of composition options. It adds three temporary
// pages that use each variant at least once (with generated test images), switches DESIGN.md to a composition that
// differs from the starter's on every axis (hairlines, outlined cards, centred, compact, square images, expressive
// motion, a duotone imagery treatment with grain), regenerates the tokens, builds, and runs the full QA gate on every page. Everything it changed is put back
// at the end, also after a failure. Run it from the starter (or a site) after `npm ci`; local files only.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { applyTreatment, readImagery, readPalette } from "../lib/treatment.mjs";

const BACKUP = ["DESIGN.md", "src/styles/tokens.css", "src/styles/fonts.js", "src/styles/design.json", "design/credits.json", "site.config.json"];
const PAGES = ["variants-a", "variants-b", "variants-c", "variants-thanks", "not-found", "privacy"];
const IMAGES = ["variant-1.jpg", "variant-2.jpg", "variant-3.jpg", "variant-4.jpg"];
const saved = new Map(BACKUP.map((f) => [f, existsSync(f) ? readFileSync(f) : null]));
const imageDirExisted = existsSync("src/assets/images");

function restore() {
  for (const [f, data] of saved) if (data) writeFileSync(f, data);
  for (const p of PAGES) rmSync(`src/content/${p}.json`, { force: true });
  for (const i of IMAGES) rmSync(`src/assets/images/${i}`, { force: true });
  if (!imageDirExisted) rmSync("src/assets/images", { recursive: true, force: true });
}
process.on("SIGINT", () => { restore(); process.exit(130); });

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

try {
  // A composition that differs from the starter's on every axis, and an imagery treatment (duotone with grain).
  const design = readFileSync("DESIGN.md", "utf8");
  const composition = "composition:\n  align: center\n  density: compact\n  separation: hairlines\n  cards: outlined\n  imageShape: square\n  motion: expressive\n  phoneBudget: 6\nimagery:\n  style: abstract\n  treatment: duotone\n  grain: true\n";
  writeFileSync("DESIGN.md", design.replace(/^(composition|imagery):\n(  .*\n)+/gm, "").replace(/\ncomponents:\n/, `\n${composition}components:\n`));
  run("node", ["scripts/design-tokens.mjs"]);

  // Test images: plain gradients, given the design's treatment, credited as generated. Two are marked photorealistic
  // to check that no generated image carries a label on the page (full-bleed hero and split).
  mkdirSync("src/assets/images", { recursive: true });
  const tints = [["#24425c", "#7aa0b8"], ["#5c3d24", "#c9a37a"], ["#2f4d3a", "#97c2a4"], ["#3d2f4d", "#b3a2c9"]];
  const imagery = readImagery();
  for (const [i, name] of IMAGES.entries()) {
    const [a, b] = tints[i];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="1200" fill="url(#g)"/></svg>`;
    const { buffer, changes } = await applyTreatment(await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer(), { ...imagery, palette: readPalette() });
    if (!changes.startsWith("Duotone")) throw new Error(`the treatment didn't apply: "${changes}"`);
    writeFileSync(`src/assets/images/${name}`, buffer);
  }
  const credits = JSON.parse(readFileSync("design/credits.json", "utf8"));
  for (const [i, name] of IMAGES.entries()) credits.images.push({ file: `src/assets/images/${name}`, source: "generated", alt: "An abstract colour gradient used to test layouts", illustrative: true, photoreal: i === 0 || i === 2, test: true });
  writeFileSync("design/credits.json", JSON.stringify(credits, null, 2) + "\n");

  // A multi-step form with a radio group and grouped checkboxes, step headings, and a footer with link columns.
  const site = JSON.parse(readFileSync("site.config.json", "utf8"));
  site.forms.survey = {
    title: "Survey", submitLabel: "Send", thanks: "/variants-thanks",
    steps: [{ title: "About you", intro: "Two quick questions." }, { title: "What you could offer", intro: "Tick any that apply." }],
    fields: [
      { name: "name", type: "text", label: "Your name", required: true, step: 1 },
      { name: "email", type: "email", label: "Email", required: true, step: 1 },
      { name: "before", type: "radio", label: "Have you done this before?", required: true, step: 1, options: ["Yes, several times", "Once or twice", "Not yet"] },
      { name: "offer", type: "checkboxes", label: "What could you offer?", required: true, step: 2, options: [
        { value: "money", label: "Money", group: "Money" }, { value: "room", label: "A room", group: "Places" }, { value: "van", label: "A van", group: "Things" }, { value: "camera", label: "A camera", group: "Things" }] },
    ],
  };
  if (!site.nav.some((n) => n.cta)) site.nav.push({ label: "Get in touch", href: "/contact", cta: true });
  site.nav.push({ label: "Try the survey", href: "/variants-c", cta: true }); // a second front door
  site.footer = { note: "One line about the business, with a [link](/variants-b).", columns: [{ title: "Company", links: [{ label: "Layouts A", href: "/variants-a" }] }, { title: "Start", links: [{ label: "Layouts C", href: "/variants-c" }] }], legal: "A legal line, **in bold** where it matters." };
  writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");

  const img = (n, alt = "An abstract colour gradient") => ({ src: `variant-${n}.jpg`, alt });
  const steps = [{ title: "First step", body: "What happens first, in one sentence." }, { title: "Second step", body: "What happens next." }, { title: "Third step", body: "How it ends for the visitor." }];
  const items = ["sparkles", "clock", "shield-check", "map-pin", "heart-handshake", "calendar"].map((icon, i) => ({ icon, title: `Reason ${i + 1}`, body: "One sentence that says why this matters to the visitor." }));
  const gallery = [1, 2, 3, 4].map((n) => ({ image: img(n), caption: `Caption ${n}` }));
  const faq = [{ question: "A common question?", answer: "A short answer." }, { question: "Another question?", answer: "Another short answer." }];
  const pages = {
    "variants-a": [
      { _type: "fb_hero", _key: "hero", variant: "full-bleed", eyebrow: "Layout test", headline: "A full-bleed hero over a photo", subheadline: "Checks the scrim, the type on a dark image and the parallax.", primary_cta_label: "Get in touch", primary_cta_url: "/#contact", points: "First reassurance\nSecond reassurance", image: img(1) },
      { _type: "fb_steps", _key: "steps", variant: "timeline", headline: "A timeline of steps", steps },
      { _type: "fb_features", _key: "features", variant: "bento", headline: "A bento grid of reasons", items, phone: "swipe" },
      { _type: "fb_gallery", _key: "gallery", variant: "masonry", headline: "A masonry gallery", items: gallery },
      { _type: "fb_faq", _key: "faq", variant: "two-column", headline: "Questions beside their answers", items: faq },
      { _type: "fb_cta", _key: "cta", variant: "band", headline: "A full-width call to action", body: "One sentence of encouragement.", cta_label: "Get in touch", cta_url: "/#contact" },
    ],
    "variants-b": [
      { _type: "fb_hero", _key: "hero", variant: "editorial", eyebrow: "Layout test", headline: "An editorial hero", subheadline: "An asymmetric spread with a tall image.", primary_cta_label: "Get in touch", primary_cta_url: "/#contact", image: img(2) },
      { _type: "fb_steps", _key: "steps", variant: "numerals", headline: "Steps as large numerals", steps, phone: "collapse" },
      { _type: "fb_features", _key: "features", variant: "list", headline: "Reasons as a compact list", items },
      { _type: "fb_gallery", _key: "gallery", variant: "strip", headline: "A strip of images", items: gallery },
      { _type: "fb_area", _key: "area", variant: "columns", headline: "Places in columns", places: "North\nSouth\nEast\nWest\nCentre\nRiverside\nHillside\nOld Town" },
      { _type: "fb_split", _key: "split", variant: "overlap", headline: "Text overlapping an image", body: "A paragraph beside the image.", image: img(3), image_side: "left" },
      { _type: "fb_text", _key: "text", variant: "lead", headline: "Text with a lead paragraph", body: "The first paragraph is set larger.\n\nThe rest is ordinary body text, with **bold**, *italic*, an [internal link](/variants-a) and an [outside one](https://example.com)." },
      { _type: "fb_list", _key: "lists", variant: "columns", headline: "Lists side by side", subheadline: "Checks, crosses and numbers.", lists: [{ title: "What we do", items: "One thing\nAnother thing, with **bold**", marker: "check" }, { title: "What we never do", items: "Charge to join\nSell your details", marker: "cross" }, { title: "In order", items: "First\nSecond\nThird", marker: "number" }], note: "A note under the lists.", phone: "collapse" },
      { _type: "fb_people", _key: "people", variant: "grid", headline: "The people behind it", body: "A paragraph before the people.", people: [{ name: "First Person", role: "*on camera*, 2012", image: img(2, "A colour gradient standing in for a photo") }, { name: "Second Person", role: "behind the camera", bio: "Two sentences about them." }], note: "A paragraph after, with a [link](/variants-a)." },
    ],
    "variants-c": [
      { _type: "fb_hero", _key: "hero", variant: "bento", headline: "A bento hero", subheadline: "Tiles for the headline, the image, each reassurance and the action.", primary_cta_label: "Get in touch", primary_cta_url: "/#contact", points: "First reassurance\nSecond reassurance\nThird reassurance", image: img(4) },
      { _type: "fb_features", _key: "features", variant: "cards", headline: "Reasons as cards", items: items.slice(0, 3) },
      { _type: "fb_pricing", _key: "pricing", headline: "Plans that swipe on phones", plans: [{ name: "Small", price: "$10", cta_label: "Choose", cta_url: "/#contact" }, { name: "Large", price: "$20", cta_label: "Choose", cta_url: "/#contact", highlighted: true, badge: "Most chosen" }] },
      { _type: "fb_form", _key: "form", variant: "split", headline: "A form beside its introduction", subheadline: "One sentence about what happens next.", form: Object.keys(JSON.parse(readFileSync("site.config.json", "utf8")).forms)[0] },
      { _type: "fb_form", _key: "survey", variant: "stacked", headline: "A two-step form with choices", form: "survey" },
    ],
    "variants-thanks": [
      { _type: "fb_hero", _key: "hero", variant: "statement", headline: "Thanks, that's arrived", subheadline: "A thanks page kept out of search results." },
      { _type: "fb_form", _key: "again", form: "survey" },
    ],
    "not-found": [
      { _type: "fb_hero", _key: "hero", variant: "statement", eyebrow: "404", headline: "That page isn't here, in the owner's words.", primary_cta_label: "Go home", primary_cta_url: "/" },
    ],
    "privacy": [
      { _type: "fb_hero", _key: "hero", variant: "statement", headline: "Privacy, in the owner's words." },
      { _type: "fb_text", _key: "who", headline: "Who we are", body: "A paragraph with a [contact link](/variants-c)." },
    ],
  };
  for (const [slug, sections] of Object.entries(pages)) {
    writeFileSync(`src/content/${slug}.json`, JSON.stringify({ title: slug, description: "Layout variant test page", ...(slug === "variants-thanks" ? { noindex: true } : {}), sections }, null, 2) + "\n");
  }

  run("node", ["scripts/check-content.mjs"]);
  run("npm", ["run", "build"]);
  run("node", ["scripts/qa.mjs"]);
  const hero = readFileSync("dist/variants-a.html", "utf8");
  if (hero.includes("Generated image")) throw new Error("a generated image carries a label on the page; they are listed on /credits only");
  const b = readFileSync("dist/variants-b.html", "utf8");
  for (const want of ["<strong>bold</strong>", "<em>italic</em>", 'href="/variants-a" class="underline', 'rel="noopener"', "What we never do", "Second Person"]) if (!b.includes(want)) throw new Error(`variants-b is missing ${want}`);
  const c = readFileSync("dist/variants-c.html", "utf8");
  if (!readFileSync("dist/variants-a.html", "utf8").includes(">Try the survey</a>")) throw new Error("the second call to action is missing");
  for (const want of ['type="radio"', 'name="offer" value="camera"', "What you could offer", ">Things<"]) if (!c.includes(want)) throw new Error(`variants-c is missing ${want}`);
  if (!readFileSync("dist/variants-thanks.html", "utf8").includes('content="noindex')) throw new Error("the noindex page has no robots noindex");
  if (!readFileSync("dist/404.html", "utf8").includes("in the owner")) throw new Error("not-found.json didn't replace the 404 page");
  if (!readFileSync("dist/privacy.html", "utf8").includes("Privacy, in the owner")) throw new Error("privacy.json didn't replace the privacy page");
  if (existsSync("dist/not-found.html")) throw new Error("not-found.json was also built as /not-found");
  console.log("\nEvery layout variant passed the QA gate with the second composition");
} finally {
  restore();
}
