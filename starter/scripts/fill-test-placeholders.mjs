#!/usr/bin/env node
// For local tests and CI only: replaces the <placeholders> in wrangler.jsonc and site.config.json with valid
// dummy values, so a site can be built before it has real Cloudflare resources. Never run it on a real site:
// scripts/site/create.mjs fills the real values.
// --turnstile-test also swaps the site's Turnstile site key for Cloudflare's always-pass test key, so a copy of a
// real site can run the browser tests on localhost (a real widget only works on its own hostnames).
import { readFileSync, writeFileSync } from "node:fs";

const DUMMY = {
  "<d1-name>": "local-db",
  "<d1-id>": "00000000-0000-0000-0000-000000000001",
  "<cms-d1-name>": "local-cms",
  "<cms-d1-id>": "00000000-0000-0000-0000-000000000002",
  "<uploads-bucket>": "local-uploads",
  "<media-bucket>": "local-media",
  "<session-kv-id>": "00000000000000000000000000000000",
  "<unique-integer>": "9001",
  "<team>.cloudflareaccess.com": "example.cloudflareaccess.com",
  "<access-application-aud>": "local",
};
for (const file of ["wrangler.jsonc", "site.config.json"]) {
  let text = readFileSync(file, "utf8");
  for (const [from, to] of Object.entries(DUMMY)) text = text.split(from).join(to);
  const left = text.match(/"<[a-z0-9.-]+>"/g);
  if (left) throw new Error(`${file}: unknown placeholders ${left.join(", ")}`);
  writeFileSync(file, text);
}
if (process.argv.includes("--turnstile-test")) {
  const site = JSON.parse(readFileSync("site.config.json", "utf8"));
  site.turnstile = { ...site.turnstile, siteKey: "1x00000000000000000000AA" };
  writeFileSync("site.config.json", JSON.stringify(site, null, 2) + "\n");
}
console.log("Test placeholders filled (local and CI use only).");
