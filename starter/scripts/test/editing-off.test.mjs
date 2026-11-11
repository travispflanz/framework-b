// Tests for the pure parts of `node scripts/editing.mjs off`. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsWith, leftovers, pagesFromExport, staticPackage, staticPage, staticWrangler } from "../lib/editing-off.mjs";

const CRON = "17 * * * *";

test("pages lose only the prerender line `on` added", () => {
  assert.equal(staticPage("---\nexport const prerender = true;\nimport X from 'x';\n---\n<p/>\n", "thanks.astro"), "---\nimport X from 'x';\n---\n<p/>\n");
  const own = "---\n// credits\nexport const prerender = true;\n---\n";
  assert.equal(staticPage(own, "credits.astro"), own, "a page that declared prerender itself keeps it");
  assert.equal(staticPage("export const prerender = true;\nexport function GET() {}\n", "robots.txt.js"), "export function GET() {}\n");
});

test("wrangler loses the editing bindings, cron and flag, in production and previews", () => {
  const w = {
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: "./dist", binding: "ASSETS" },
    d1_databases: [{ binding: "DB", database_name: "leads" }, { binding: "CMS_DB", database_name: "example-co-cms" }],
    r2_buckets: [{ binding: "UPLOADS", bucket_name: "up" }, { binding: "MEDIA", bucket_name: "example-co-media" }],
    kv_namespaces: [{ binding: "SESSION", id: "kv1" }],
    triggers: { crons: [CRON] },
    previews: {
      d1_databases: [{ binding: "DB", database_name: "prev" }, { binding: "CMS_DB", database_name: "example-co-cms-preview" }],
      r2_buckets: [{ binding: "UPLOADS", bucket_name: "pu" }, { binding: "MEDIA", bucket_name: "example-co-media-preview" }],
      kv_namespaces: [{ binding: "SESSION", id: "kv2" }],
    },
  };
  const out = staticWrangler(w, CRON);
  assert.deepEqual(out.d1_databases, [{ binding: "DB", database_name: "leads" }]);
  assert.deepEqual(out.r2_buckets, [{ binding: "UPLOADS", bucket_name: "up" }]);
  assert.equal(out.kv_namespaces, undefined);
  assert.equal(out.triggers, undefined);
  assert.equal(out.compatibility_flags, undefined);
  assert.equal(out.assets.not_found_handling, "404-page");
  assert.deepEqual(out.previews, { d1_databases: [{ binding: "DB", database_name: "prev" }], r2_buckets: [{ binding: "UPLOADS", bucket_name: "pu" }] });
  assert.equal(w.d1_databases.length, 2, "the input is not changed");
  assert.deepEqual(staticWrangler({ triggers: { crons: [CRON, "0 3 * * *"] } }, CRON).triggers, { crons: ["0 3 * * *"] }, "other crons stay");
  assert.deepEqual(leftovers(w), ["D1 database example-co-cms", "R2 bucket example-co-media", "KV namespace kv1", "D1 database example-co-cms-preview", "R2 bucket example-co-media-preview", "KV namespace kv2"]);
});

test("package.json loses the EmDash packages and key", () => {
  const pkg = { dependencies: { astro: "7.0.0", emdash: "1.3.1", react: "19.3.1" }, emdash: { seed: "seed/seed.json" } };
  assert.deepEqual(staticPackage(pkg, { emdash: "1.3.1", react: "19.3.1" }), { dependencies: { astro: "7.0.0" } });
});

const current = { title: "Home", description: "Kept", sections: [{ _type: "fb_hero", _key: "hero", headline: "Old" }] };
const about = { title: "About", description: "About us", sections: [{ _type: "fb_hero", _key: "hero", headline: "About" }] };
const thanks = { title: "Thanks", noindex: true, sections: [{ _type: "fb_hero", _key: "hero", headline: "Thanks" }] };
const site = { home: current, about, thanks };
const exported = (sections, extra = {}, more = []) => ({ content: { pages: [{ id: "pages:home", slug: "home", status: "published", data: { title: "Home", sections }, ...extra }, ...more] } });
// The home page as the old single-page export saw it.
const homeFromExport = (seed, home, media, taken) => {
  const r = pagesFromExport(seed, { home }, media, taken);
  return { home: r.pages.home, images: r.images, notes: r.notes, changed: r.changed.includes("home") };
};

test("the published home page becomes home.json, without EmDash's _version", () => {
  const { home, images, notes, changed } = homeFromExport(exported([{ _version: 1, _type: "fb_hero", _key: "hero", headline: "New", points: "a\nb" }]), current);
  assert.deepEqual(home, { title: "Home", description: "Kept", sections: [{ _type: "fb_hero", _key: "hero", headline: "New", points: "a\nb" }] });
  assert.equal(changed, true);
  assert.deepEqual(images, []);
  assert.deepEqual(notes, []);
});

test("no published home page leaves home.json as it is", () => {
  const draft = homeFromExport(exported([{ _type: "fb_hero", headline: "Draft" }], { status: "draft" }), current);
  assert.deepEqual(draft.home, current);
  assert.equal(draft.changed, false);
  assert.match(draft.notes[0], /no published home page/);
});

test("every published page comes back: edits to its file, its description and noindex kept, a new page as a new file", () => {
  const more = [
    { slug: "about", status: "published", data: { title: "About the team", sections: [{ _version: 1, _type: "fb_hero", _key: "hero", headline: "Edited about" }] } },
    { slug: "thanks", status: "published", data: { title: "Thanks", sections: thanks.sections } },
    { slug: "events", status: "published", data: { title: "Events", sections: [{ _type: "fb_hero", _key: "hero", headline: "Made in the editor" }] } },
    { slug: "draft-only", status: "draft", data: { title: "Not yet", sections: [] } },
  ];
  const { pages, changed, notes } = pagesFromExport(exported(current.sections, {}, more), site);
  assert.deepEqual(pages.about, { title: "About the team", description: "About us", sections: [{ _type: "fb_hero", _key: "hero", headline: "Edited about" }] });
  assert.deepEqual(pages.thanks, thanks, "an unchanged page stays as it is, noindex and all");
  assert.deepEqual(pages.events, { title: "Events", sections: [{ _type: "fb_hero", _key: "hero", headline: "Made in the editor" }] });
  assert.equal(pages["draft-only"], undefined, "a draft is never written");
  assert.deepEqual(changed.sort(), ["about", "events"], "the home page and thanks are unchanged, so not rewritten");
  assert.match(notes.join("\n"), /\/events is a page an editor created/);
  assert.deepEqual(site.about, about, "the input is not changed");
});

test("an image used on two pages is copied once", () => {
  const media = [{ id: "m1", filename: "Crew.jpg", mime_type: "image/jpeg", alt: "", storage_key: "01C.jpg" }];
  const pic = { provider: "local", id: "m1", src: "/_emdash/api/media/file/01C.jpg", alt: "The crew" };
  const more = [{ slug: "about", status: "published", data: { title: "About", sections: [{ _type: "fb_split", _key: "s", image: pic }] } }];
  const { pages, images } = pagesFromExport(exported([{ _type: "fb_hero", _key: "hero", image: pic }], {}, more), site, media, []);
  assert.equal(images.length, 1);
  assert.deepEqual(pages.home.sections[0].image, { src: "crew.jpg", alt: "The crew" });
  assert.deepEqual(pages.about.sections[0].image, { src: "crew.jpg", alt: "The crew" });
});

test("media-library images become files with credits; external ones keep their URL", () => {
  const media = [{ id: "m1", filename: "Front Porch.JPG", mime_type: "image/jpeg", alt: "Library alt", storage_key: "01ABC.jpg" }];
  const sections = [
    { _type: "fb_hero", _key: "hero", headline: "H", image: { provider: "local", id: "m1", src: "/_emdash/api/media/file/01ABC.jpg", alt: "The porch", width: 800 } },
    { _type: "fb_gallery", _key: "g", images: [{ image: { id: "m1", mimeType: "image/jpeg" } }, { image: { provider: "unsplash", id: "u9", src: "https://images.example.com/u9.jpg", alt: "Field" } }] },
    { _type: "fb_split", _key: "s", image: { provider: "local", id: "gone" } },
  ];
  const { home, images, notes } = homeFromExport(exported(sections), current, media, ["front-porch.jpg"]);
  assert.deepEqual(images, [{ id: "m1", storageKey: "01ABC.jpg", file: "front-porch-2.jpg", alt: "The porch" }], "one file per media item, never overwriting");
  assert.deepEqual(home.sections[0].image, { src: "front-porch-2.jpg", alt: "The porch" });
  assert.deepEqual(home.sections[1].images[0].image, { src: "front-porch-2.jpg", alt: "Library alt" });
  assert.deepEqual(home.sections[1].images[1].image, { src: "https://images.example.com/u9.jpg", alt: "Field" });
  assert.equal(home.sections[2].image, undefined);
  assert.equal(notes.length, 2);

  const credits = creditsWith({ about: "x", images: [{ file: "public/favicon.svg", source: "framework", alt: "" }] }, images);
  assert.equal(credits.images.length, 2);
  assert.deepEqual(credits.images[1].file, "src/assets/images/front-porch-2.jpg");
  assert.equal(credits.images[1].source, "owner");
  assert.equal(creditsWith(credits, images).images.length, 2, "no duplicate entries");
});

test("the site's own files, seeded as external media values, come back as files with their focal points", () => {
  const sections = [
    { _type: "fb_hero", _key: "hero", headline: "H", image: { provider: "external", id: "local:hero.jpg", src: "/media/hero.jpg", filename: "hero.jpg", alt: "The crew", focalX: 0.6, focalY: 0.2 } },
    { _type: "fb_split", _key: "s", image: { provider: "local", id: "m1", src: "/_emdash/api/media/file/01ABC.jpg", alt: "Chosen in the editor", focalY: 0.3 } },
  ];
  const media = [{ id: "m1", filename: "Porch.jpg", mime_type: "image/jpeg", alt: "", storage_key: "01ABC.jpg" }];
  const { home, images, notes } = homeFromExport(exported(sections), current, media, []);
  assert.deepEqual(home.sections[0].image, { src: "hero.jpg", alt: "The crew", focalX: 0.6, focalY: 0.2 });
  assert.deepEqual(home.sections[1].image, { src: "porch.jpg", alt: "Chosen in the editor", focalY: 0.3 });
  assert.equal(images.length, 1, "only the media-library image is copied; the site's own file is already there");
  assert.deepEqual(notes, []);
});
