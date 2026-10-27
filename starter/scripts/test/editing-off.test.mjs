// Tests for the pure parts of `node scripts/editing.mjs off`. Run: node --test scripts/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsWith, homeFromExport, leftovers, staticPackage, staticPage, staticWrangler } from "../lib/editing-off.mjs";

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
const exported = (sections, extra = {}) => ({ content: { pages: [{ id: "pages:home", slug: "home", status: "published", data: { title: "Home", sections }, ...extra }] } });

test("the published home page becomes home.json, without EmDash's _version", () => {
  const { home, images, notes, changed } = homeFromExport(exported([{ _version: 1, _type: "fb_hero", _key: "hero", headline: "New", points: "a\nb" }]), current);
  assert.deepEqual(home, { title: "Home", description: "Kept", sections: [{ _type: "fb_hero", _key: "hero", headline: "New", points: "a\nb" }] });
  assert.equal(changed, true);
  assert.deepEqual(images, []);
  assert.deepEqual(notes, []);
});

test("no published home page leaves home.json as it is", () => {
  const draft = homeFromExport(exported([{ _type: "fb_hero", headline: "Draft" }], { status: "draft" }), current);
  assert.equal(draft.home, current);
  assert.equal(draft.changed, false);
  assert.match(draft.notes[0], /no published home page/);
  const other = homeFromExport({ content: { pages: [{ slug: "about", status: "published", data: {} }] } }, current);
  assert.equal(other.home, current);
  assert.match(other.notes.join("\n"), /"about" isn't exported/);
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
