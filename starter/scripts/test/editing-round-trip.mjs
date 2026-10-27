#!/usr/bin/env node
// CI round trip for client editing: run in a starter that `editing.mjs on` switched on. It builds an EmDash content
// database from seed/seed.json with EmDash's own CLI, edits the home page there the way an editor would (a new
// headline and a media-library image on the hero), then runs `editing.mjs off --database` and checks the result:
// the edit is in src/content/home.json, the image is a credited file, and every file `on` changed is back.
// The caller then builds and runs the e2e test and QA gate on the static site. Local files only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
for (const gone of ["src/live.config.ts", "seed", "editing/static"]) assert.ok(!existsSync(gone), `${gone} is removed`);
assert.equal(JSON.parse(readFileSync("site.config.json", "utf8")).editing, undefined);
// Every framework file `on` changed is exactly as it was (the starter is a git checkout in CI).
run("git", ["diff", "--exit-code", "--", "astro.config.mjs", "src/worker.js", "src/pages", "package.json"]);
console.log("Round trip passed: the edit and its image came back as files, and the static site's files are restored.");
