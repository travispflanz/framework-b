#!/usr/bin/env node
// CI round trip for client editing: run in a starter that `editing.mjs on` switched on. It builds an EmDash content
// database from seed/seed.json with EmDash's own CLI, edits the home page there the way an editor would (a new
// headline and a media-library image on the hero), then runs `editing.mjs off --database` and checks the result:
// the edit is in src/content/home.json, the image is a credited file, and every file `on` changed is back. A picture
// that is the site's own file goes into the seed as an external media value and comes back as the same file, with its
// focal point.
// The caller then builds and runs the e2e test and QA gate on the static site. Local files only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
const tmp = mkdtempSync(join(tmpdir(), "round-trip-"));
const file = join(tmp, "cms.sqlite");
const mediaDir = join(tmp, "media");
mkdirSync(mediaDir);

// The site's own picture: a file in src/assets/images on a split section, seeded again so the seed carries it.
const own = "round-trip-own.jpg";
mkdirSync("src/assets/images", { recursive: true });
await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#7f5b95" } }).jpeg().toFile(join("src/assets/images", own));
const creditsBefore = readFileSync("design/credits.json", "utf8");
const credits = JSON.parse(creditsBefore);
credits.images.push({ file: `src/assets/images/${own}`, source: "owner", alt: "A plain purple test image", test: true });
writeFileSync("design/credits.json", JSON.stringify(credits, null, 2) + "\n");
const homeBefore = JSON.parse(readFileSync("src/content/home.json", "utf8"));
const split = { _type: "fb_split", _key: "own", headline: "The site's own picture", body: "Text beside it.", image: { src: own, alt: "A plain purple test image", focalX: 0.4 } };
writeFileSync("src/content/home.json", JSON.stringify({ ...homeBefore, sections: [...homeBefore.sections.slice(0, -1), split, homeBefore.sections.at(-1)] }, null, 2) + "\n");
run("node", ["scripts/editing.mjs", "seed"]);
const seeded = JSON.parse(readFileSync("seed/seed.json", "utf8")).content.pages[0].data.sections.find((x) => x._key === "own").image;
assert.deepEqual(seeded, { provider: "external", id: `local:${own}`, src: `/media/${own}`, filename: own, alt: "A plain purple test image", focalX: 0.4 });

run("npx", ["emdash", "seed", "seed/seed.json", "--database", file]);
await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#5b7f95" } }).jpeg().toFile(join(mediaDir, "01ROUNDTRIP.jpg"));
const db = new DatabaseSync(file);
const sections = JSON.parse(db.prepare("select sections from ec_pages where slug = 'home'").get().sections);
sections[0].headline = "Edited in the content editor";
sections[0].image = { provider: "local", id: "01MEDIA", src: "/_emdash/api/media/file/01ROUNDTRIP.jpg", alt: "A plain blue test image", width: 1200, height: 800 };
db.prepare("update ec_pages set sections = ? where slug = 'home'").run(JSON.stringify(sections));
db.prepare("insert into media (id, filename, mime_type, storage_key, alt) values (?, ?, ?, ?, ?)").run("01MEDIA", "Test Image.jpg", "image/jpeg", "01ROUNDTRIP.jpg", "");
db.close();

run("node", ["scripts/editing.mjs", "off", "--database", file, "--media-dir", mediaDir]);

const home = JSON.parse(readFileSync("src/content/home.json", "utf8"));
assert.equal(home.sections[0].headline, "Edited in the content editor");
assert.deepEqual(home.sections[0].image, { src: "test-image.jpg", alt: "A plain blue test image" });
assert.ok(existsSync("src/assets/images/test-image.jpg"));
assert.ok(JSON.parse(readFileSync("design/credits.json", "utf8")).images.some((c) => c.file === "src/assets/images/test-image.jpg"));
assert.deepEqual(home.sections.find((x) => x._key === "own").image, { src: own, alt: "A plain purple test image", focalX: 0.4 });
// The extra section and its picture were only for this check; the static site is tested as the starter has it.
writeFileSync("src/content/home.json", JSON.stringify({ ...home, sections: home.sections.filter((x) => x._key !== "own") }, null, 2) + "\n");
const after = JSON.parse(readFileSync("design/credits.json", "utf8"));
writeFileSync("design/credits.json", JSON.stringify({ ...after, images: after.images.filter((c) => c.file !== `src/assets/images/${own}`) }, null, 2) + "\n");
rmSync(join("src/assets/images", own));
for (const gone of ["src/live.config.ts", "seed", "editing/static"]) assert.ok(!existsSync(gone), `${gone} is removed`);
assert.equal(JSON.parse(readFileSync("site.config.json", "utf8")).editing, undefined);
// Every framework file `on` changed is exactly as it was (the starter is a git checkout in CI).
run("git", ["diff", "--exit-code", "--", "astro.config.mjs", "src/worker.js", "src/pages", "package.json"]);
console.log("Round trip passed: the edit and its image came back as files, and the static site's files are restored.");
