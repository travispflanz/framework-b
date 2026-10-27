#!/usr/bin/env node
// Open-licensed photos from Openverse (https://api.openverse.org/v1/, no key needed), with credits written for you.
// Owner photos come first; this is for the rest. Never use it for people presented as customers, staff or work
// samples: a stock photo is never the business's own work.
//
//   node scripts/images.mjs search "<query>" [--count 20] [--any-size]   (default: at least 1000 px on the long side)
//       → design/image-candidates/<query>.json and a contact sheet <query>.png (numbered thumbnails) to look at
//   node scripts/images.mjs add <openverse id> --as <file name> --alt "<what it shows>" [--allow-small]
//       → src/assets/images/<file name>.jpg (at most 2000 px wide, metadata stripped) + its design/credits.json entry
//
// Only licences that allow commercial use and resizing: CC0, Public Domain Mark, CC BY, CC BY-SA. CC BY and BY-SA
// need attribution: the site's /credits page lists every credited image and the footer links to it.
// Wikimedia and Flickr want a descriptive User-Agent; Wikimedia rate-limits busy addresses with Retry-After
// (seen 2026-10-27: 429, retry after 600 s). The download waits once for Retry-After, up to 10 minutes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { launchBrowser } from "./lib/local-site.mjs";

for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => (console.error(`error: ${e?.message || e}`), process.exit(1)));
const API = "https://api.openverse.org/v1/images";
const UA = "FrameworkB-images/1.0 (website build tool; https://github.com/travispflanz/framework-b)";
const LICENSES = ["cc0", "pdm", "by", "by-sa"];
const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true;
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Anonymous Openverse use: at most 20 results a page (more is a 401) and about one request a second
// (make.wordpress.org/openverse, 2022-06-17, checked 2026-10-27). Thumbnails count too, so all its calls are paced.
let lastOpenverse = 0;
async function get(url, { json = false, waited = false, timeout = json ? 90_000 : 30_000 } = {}) {
  if (new URL(url).host === "api.openverse.org") {
    const gap = Date.now() - lastOpenverse;
    if (gap < 1100) await sleep(1100 - gap);
    lastOpenverse = Date.now();
  }
  // A request that never answers would hang the script, so each one gives up: 30 s for a thumbnail, 90 s for the
  // API (a single-image lookup took 29 s on 2026-10-27) and 120 s for an original.
  const res = await fetch(url, { headers: { "user-agent": UA, accept: json ? "application/json" : "*/*" }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  // Openverse answers a burst over its anonymous throttle with 403; one paced retry is enough.
  if (res.status === 403 && new URL(url).host === "api.openverse.org" && !waited) {
    await sleep(5000);
    return get(url, { json, waited: true, timeout });
  }
  if (res.status === 429 && !waited) {
    const wait = Math.min(Number(res.headers.get("retry-after")) || 60, 600);
    console.log(`  ${new URL(url).host} is rate-limiting this machine; waiting ${wait} s as it asks…`);
    await sleep(wait * 1000);
    return get(url, { json, waited: true, timeout });
  }
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}${res.status === 429 ? " (still rate-limited: try again later, or pick a result from another source)" : ""}`);
  return json ? res.json() : Buffer.from(await res.arrayBuffer());
}

const licenseName = (r) => (r.license === "cc0" ? "CC0 1.0" : r.license === "pdm" ? "Public Domain Mark 1.0" : `CC ${r.license.toUpperCase()} ${r.license_version || ""}`.trim());

if (cmd === "search" && arg) {
  const count = Number(opt("count")) || 20;
  // Openverse's own "large" filter returns almost only Wikimedia originals, so the width filter is applied here.
  const pool = [];
  let data = {};
  for (let page = 1; page <= 3 && pool.length < count; page++) {
    const q = new URLSearchParams({ q: arg, license: LICENSES.join(","), page_size: "20", page: String(page), mature: "false" });
    data = await get(`${API}/?${q}`, { json: true });
    pool.push(...(data.results || []).filter((r) => opt("any-size") || Math.max(r.width || 0, r.height || 0) >= 1000));
    if (!data.page_count || page >= data.page_count) break;
  }
  const wide = pool.slice(0, count);
  const results = wide.map((r, i) => ({
    n: i + 1, id: r.id, title: r.title, creator: r.creator, license: licenseName(r), source: r.source,
    width: r.width, height: r.height, landing: r.foreign_landing_url, thumbnail: r.thumbnail,
  }));
  const dir = "design/image-candidates";
  mkdirSync(dir, { recursive: true });
  const name = slug(arg);
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ query: arg, results }, null, 2) + "\n");
  // Contact sheet: numbered thumbnails, so the agent (or the owner) looks before choosing.
  const thumbs = [];
  for (const r of results) {
    try {
      thumbs.push(`data:image/jpeg;base64,${(await get(r.thumbnail)).toString("base64")}`);
    } catch {
      thumbs.push("");
    }
  }
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 400 } });
  await page.setContent(`<!doctype html><html><body style="margin:0;padding:16px;background:#fff;font:14px system-ui">
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">${results.map((r, i) => `<figure style="margin:0">
      <div style="aspect-ratio:4/3;background:#eee url(${thumbs[i]}) center/cover"></div>
      <figcaption><b>#${r.n}</b> ${String(r.title || "").slice(0, 40).replace(/</g, "&lt;")}<br>${r.width}×${r.height} · ${r.license} · ${r.source}</figcaption></figure>`).join("")}</div></body></html>`);
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  await browser.close();
  for (const r of results) console.log(`#${String(r.n).padStart(2)} ${r.id}  ${r.width}×${r.height}  ${r.license.padEnd(14)} ${r.source.padEnd(10)} ${String(r.title || "").slice(0, 50)}`);
  console.log(`\n${results.length} of ${data.result_count} results. Look at ${dir}/${name}.png, then: node scripts/images.mjs add <id> --as <name> --alt "<what it shows>"`);
} else if (cmd === "add" && arg) {
  const as = opt("as");
  const alt = opt("alt");
  if (!as || as === true || !/^[a-z0-9][a-z0-9-]*$/.test(as)) throw new Error("--as <file name>: lowercase letters, digits and dashes, no extension");
  if (!alt || alt === true) throw new Error('--alt "<what the image shows>" is required');
  const r = await get(`${API}/${arg}/`, { json: true });
  if (!LICENSES.includes(r.license)) throw new Error(`licence "${r.license}" isn't allowed (allowed: ${LICENSES.join(", ")})`);
  // Flickr serves small copies by default; its _b size is 1024 px on the long side, when the owner allows it.
  const urls = r.provider === "flickr" || /staticflickr\.com/.test(r.url) ? [r.url.replace(/(_[a-z])?\.jpg$/, "_b.jpg"), r.url] : [r.url];
  let buf;
  let lastErr;
  for (const u of urls) {
    try {
      buf = await get(u, { timeout: 120_000 });
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!buf) throw lastErr;
  const meta = await sharp(buf).metadata();
  if (Math.max(meta.width, meta.height) < 1000 && !opt("allow-small")) throw new Error(`the image is only ${meta.width}×${meta.height} px; pick a larger one, or pass --allow-small for a small slot`);
  mkdirSync("src/assets/images", { recursive: true });
  const file = `src/assets/images/${as}.jpg`;
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const out = await sharp(buf).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  writeFileSync(file, out);
  const ledgerPath = "design/credits.json";
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { images: [] };
  ledger.images = (ledger.images || []).filter((c) => c.file !== file);
  ledger.images.push({
    file, source: "openverse", title: r.title || "", creator: r.creator || "unknown", creator_url: r.creator_url || "",
    license: licenseName(r), license_url: r.license_url || "", url: r.foreign_landing_url, openverse_id: r.id,
    alt, changes: "Resized and compressed.",
  });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  const final = await sharp(out).metadata();
  console.log(`${file}: ${final.width}×${final.height}, ${Math.round(out.length / 1024)} KB, ${licenseName(r)} by ${r.creator || "unknown"}. Use it as { "src": "${as}.jpg", "alt": "${alt}" }.`);
} else {
  console.error('usage: images.mjs search "<query>" [--count 20] [--any-size] | add <id> --as <name> --alt "<text>" [--allow-small]');
  process.exit(2);
}
