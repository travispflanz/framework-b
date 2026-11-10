#!/usr/bin/env node
// Open-licensed photos from Openverse (https://api.openverse.org/v1/, no key needed) and public-domain photographs from
// the Library of Congress (https://www.loc.gov/photos/), with credits written for you. Owner photos come first; this
// is for the rest. Never use it for people presented as customers, staff or work samples: a stock or archive photo is
// never the business's own work.
//
//   node scripts/images.mjs search "<query>" [--source openverse|loc] [--count 20] [--any-size]
//       → design/image-candidates/<query>.json and a contact sheet <query>.png (numbered thumbnails) to look at.
//         Openverse: at least 1000 px on the long side unless --any-size. loc: only records whose rights statement
//         says "No known restrictions on publication".
//   node scripts/images.mjs add <openverse id | loc:<id>> --as <file name> --alt "<what it shows>" [--for "<slot: why>"]
//       [--allow-small] [--crop left,top,right,bottom]
//       → src/assets/images/<file name>.jpg (at most 2000 px wide, metadata stripped) + its design/credits.json entry.
//         `--for` records where the photo goes and why it fits, so the choice can be reviewed. The credit records
//         what AI did ("ai": chose, cropped, treated, alt) for the Website assets page; name the model once as
//         "aiBy" in design/credits.json. A loc: photo comes from
//         its master scan; its mat, frame and edge markings are found and cropped (design/image-candidates/<name>-crop.png
//         shows the box; look at it); `--crop` gives the share to cut from each edge instead (0.05 = 5%).
//   node scripts/images.mjs treat <file in src/assets/images>
//   node scripts/images.mjs crop <file in src/assets/images> --cut left,top,right,bottom [--also <file>]
//       → cuts that share from each edge (0.2 = a fifth), for a frame every layout keeps (a second person half out of
//         frame), where a focal point only moves the crop. The uncropped photo is kept in design/image-candidates/;
//         --also crops another version of it (its colour original) the same way. A photo with spot colour is
//         cropped after `node scripts/spot-colour.mjs undo`, then outlined again.
//       → applies the DESIGN.md imagery treatment to an owner photo (once; the credit records it)
//   node scripts/images.mjs shelve <file> | unshelve <file> | library
//       → the image library, design/library/: photos taken off the pages but kept, credit and all, to use again.
//         `library` lists it and draws design/library/sheet.png.
//
// `add` applies the imagery treatment from DESIGN.md (imagery.treatment and imagery.grain; see scripts/lib/treatment.mjs)
// so stock photos match each other and the generated images. Run design-tokens.mjs first after changing DESIGN.md.
//
// Only licences that allow commercial use and resizing: CC0, Public Domain Mark, CC BY, CC BY-SA. CC BY and BY-SA
// need attribution: the site's /credits page lists every credited image and the footer links to it.
// Wikimedia and Flickr want a descriptive User-Agent; Wikimedia rate-limits busy addresses with Retry-After
// (seen 2026-10-27: 429, retry after 600 s). The download waits once for Retry-After, up to 10 minutes.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { launchBrowser } from "./lib/local-site.mjs";
import { applyTreatment, readImagery, readPalette } from "./lib/treatment.mjs";
import { candidate, isFree, locId, LOC_API_GAP_MS, LOC_FILE_GAP_MS, pickFile, rightsOf } from "./lib/loc.mjs";
import { scanBorders } from "./lib/scan-borders.mjs";

for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => (console.error(`error: ${e?.message || e}`), process.exit(1)));
const API = "https://api.openverse.org/v1/images";
const UA = "FrameworkB-images/1.0 (website build tool; https://github.com/travispflanz/framework-b)";
const LICENSES = ["cc0", "pdm", "by", "by-sa"];
const [cmd, arg, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : true;
};
// The steps AI took with an image, for the Website assets page (src/lib/ai-use.js): each recorded once.
const step = (entry, ...names) => (entry.ai = [...new Set([...(entry.ai || []), ...names])]);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Anonymous Openverse use: at most 20 results a page (more is a 401) and about one request a second
// (make.wordpress.org/openverse, 2022-06-17, checked 2026-10-27). Thumbnails count too, so all its calls are paced.
let lastOpenverse = 0;
const lastLoc = { api: 0, file: 0 };
async function get(url, { json = false, waited = false, timeout = json ? 90_000 : 30_000 } = {}) {
  const host = new URL(url).host;
  if (host === "api.openverse.org") {
    const gap = Date.now() - lastOpenverse;
    if (gap < 1100) await sleep(1100 - gap);
    lastOpenverse = Date.now();
  }
  // loc.gov: 20 API requests a minute, 150 image requests (lib/loc.mjs); going over blocks the address for an hour.
  if (/(^|\.)loc\.gov$/.test(host)) {
    const kind = host === "www.loc.gov" ? "api" : "file";
    const wait = (kind === "api" ? LOC_API_GAP_MS : LOC_FILE_GAP_MS) - (Date.now() - lastLoc[kind]);
    if (wait > 0) await sleep(wait);
    lastLoc[kind] = Date.now();
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

const LEDGER = "design/credits.json";
const LIBRARY = "design/library";
const readLedger = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { images: [] });
const writeLedger = (path, ledger) => writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");

// Draws numbered thumbnails (data: URLs or ""), with a caption each, into a PNG.
async function contactSheet(path, items) {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1600, height: 400 } });
  await page.setContent(`<!doctype html><html><body style="margin:0;padding:16px;background:#fff;font:14px system-ui">
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">${items.map((it) => `<figure style="margin:0">
      <div style="aspect-ratio:4/3;background:#eee url(${it.thumb}) center/cover"></div>
      <figcaption>${it.caption.replace(/</g, "&lt;")}</figcaption></figure>`).join("")}</div></body></html>`);
  await page.screenshot({ path, fullPage: true });
  await browser.close();
}

const licenseName = (r) => (r.license === "cc0" ? "CC0 1.0" : r.license === "pdm" ? "Public Domain Mark 1.0" : `CC ${r.license.toUpperCase()} ${r.license_version || ""}`.trim());

if (cmd === "search" && arg && opt("source") === "loc") {
  const count = Math.min(Number(opt("count")) || 20, 40);
  const results = [];
  for (let sp = 1; sp <= 3 && results.length < count; sp++) {
    const q = new URLSearchParams({ q: arg, fo: "json", at: "results,pagination", c: "40", sp: String(sp) });
    const data = await get(`https://www.loc.gov/photos/?${q}`, { json: true });
    for (const x of data.results || []) { const c = candidate(x); if (c && !results.some((r) => r.id === c.id)) results.push(c); }
    if (!data.pagination?.next) break;
  }
  const list = results.slice(0, count).map((r, i) => ({ n: i + 1, ...r }));
  const dir = "design/image-candidates";
  mkdirSync(dir, { recursive: true });
  const name = `loc-${slug(arg)}`;
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ query: arg, source: "loc", results: list }, null, 2) + "\n");
  const items = [];
  for (const r of list) {
    let thumb = "";
    try { thumb = `data:image/jpeg;base64,${(await get(r.thumbnail)).toString("base64")}`; } catch {}
    items.push({ thumb, caption: `#${r.n} ${r.title.slice(0, 48)} · ${r.date || "undated"}` });
  }
  await contactSheet(join(dir, `${name}.png`), items);
  for (const r of list) console.log(`#${String(r.n).padStart(2)} ${r.id.padEnd(20)} ${String(r.date).slice(0, 10).padEnd(11)} ${r.title.slice(0, 70)}`);
  console.log(`\n${list.length} photos with no known restrictions. Look at ${dir}/${name}.png, then: node scripts/images.mjs add loc:<id> --as <name> --alt "<what it shows>" --for "<slot: why>"`);
} else if (cmd === "search" && arg) {
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
} else if (cmd === "add" && arg && arg.startsWith("loc:")) {
  const as = opt("as");
  const alt = opt("alt");
  const forSlot = typeof opt("for") === "string" ? opt("for") : "";
  if (!as || as === true || !/^[a-z0-9][a-z0-9-]*$/.test(as)) throw new Error("--as <file name>: lowercase letters, digits and dashes, no extension");
  if (!alt || alt === true) throw new Error('--alt "<what the image shows>" is required');
  const file = `src/assets/images/${as}.jpg`;
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const id = locId(arg);
  const rec = await get(`https://www.loc.gov/item/${id}/?fo=json&at=item,resources`, { json: true });
  const item = rec.item || {};
  const rights = rightsOf(item);
  if (!isFree(rights)) throw new Error(`loc:${id}: the record's rights statement isn't "No known restrictions on publication" (${rights.slice(0, 120) || "none"}); pick another photo`);
  const pick = pickFile(rec.resources);
  if (!pick) throw new Error(`loc:${id} has no downloadable image`);
  console.log(`  downloading ${pick.master ? "the master scan" : "the largest copy"} (${pick.url.split("/").pop()})…`);
  const buf = await get(pick.url, { timeout: 900_000 });
  const big = { limitInputPixels: false };
  const meta = await sharp(buf, big).metadata();
  if (Math.max(meta.width, meta.height) < 1000 && !opt("allow-small")) throw new Error(`the image is only ${meta.width}×${meta.height} px; pick a larger one, or pass --allow-small for a small slot`);
  // Find the picture inside the scan on a reduced 8-bit copy, then cut the same share from the full scan.
  const small = await sharp(await sharp(buf, big).resize({ width: 1600, height: 1600, fit: "inside" }).toColourspace("srgb").jpeg().toBuffer()).greyscale().raw().toBuffer({ resolveWithObject: true });
  const manual = typeof opt("crop") === "string" ? opt("crop").split(",").map(Number) : null;
  if (manual && (manual.length !== 4 || manual.some((v) => !(v >= 0 && v < 0.45)))) throw new Error("--crop left,top,right,bottom: four shares from 0 to 0.45, such as 0.03,0.06,0.03,0.02");
  const b = manual ? { left: manual[0] * small.info.width, top: manual[1] * small.info.height, right: manual[2] * small.info.width, bottom: manual[3] * small.info.height }
    : scanBorders(small.data, small.info.width, small.info.height);
  const sx = meta.width / small.info.width, sy = meta.height / small.info.height;
  const region = { left: Math.round(b.left * sx), top: Math.round(b.top * sy), width: Math.round(meta.width - (b.left + b.right) * sx), height: Math.round(meta.height - (b.top + b.bottom) * sy) };
  const cropped = await sharp(buf, big).extract(region).resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const imagery = readImagery();
  const { buffer: out, changes } = await applyTreatment(cropped, { ...imagery, palette: imagery.treatment === "none" ? undefined : readPalette() });
  mkdirSync("src/assets/images", { recursive: true });
  writeFileSync(file, out);
  // A check image: the reduced scan with the crop drawn on it.
  mkdirSync("design/image-candidates", { recursive: true });
  const preview = await sharp(small.data, { raw: small.info }).jpeg().toBuffer();
  const pct = (v, total) => `${((v / total) * 100).toFixed(2)}%`;
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: small.info.width, height: small.info.height } });
  await page.setContent(`<body style="margin:0"><div style="position:relative;width:${small.info.width}px;height:${small.info.height}px;background:url(data:image/jpeg;base64,${preview.toString("base64")})">
    <div style="position:absolute;left:${pct(b.left, small.info.width)};top:${pct(b.top, small.info.height)};right:${pct(b.right, small.info.width)};bottom:${pct(b.bottom, small.info.height)};outline:4px solid #f00"></div></div></body>`);
  await page.screenshot({ path: `design/image-candidates/${as}-crop.png` });
  await browser.close();
  const people = [].concat(item.contributor_names || item.contributors || []).filter(Boolean);
  const ledger = readLedger(LEDGER);
  ledger.images = (ledger.images || []).filter((c) => c.file !== file);
  ledger.images.push({
    file, source: "stock", archive: "Library of Congress", loc_id: id, title: item.title || "", date: [].concat(item.date || item.created_published || "")[0] || "",
    creator: [...people.slice(0, 2), "Library of Congress, Prints & Photographs Division"].join(" / "),
    license: "No known restrictions on publication", rights, url: `https://www.loc.gov/item/${id}/`, alt, ...(forSlot ? { for: forSlot } : {}),
    changes: [`Cropped inside the scan's borders${manual ? " (by hand)" : ""}, resized and compressed.`, changes].filter(Boolean).join(" "),
    ai: ["chose", "cropped", ...(changes ? ["treated"] : []), "alt"],
    ...(changes ? { treated: changes } : {}),
  });
  writeLedger(LEDGER, ledger);
  const final = await sharp(out).metadata();
  console.log(`${file}: ${final.width}×${final.height}, ${Math.round(out.length / 1024)} KB, from loc:${id}. Look at design/image-candidates/${as}-crop.png (the red box is what's kept). Use it as { "src": "${as}.jpg", "alt": "${alt}" }.`);
} else if (cmd === "add" && arg) {
  const as = opt("as");
  const alt = opt("alt");
  const forSlot = typeof opt("for") === "string" ? opt("for") : "";
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
  const resized = await sharp(buf).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  const imagery = readImagery();
  const { buffer: out, changes } = await applyTreatment(resized, { ...imagery, palette: imagery.treatment === "none" ? undefined : readPalette() });
  writeFileSync(file, out);
  const ledgerPath = "design/credits.json";
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { images: [] };
  ledger.images = (ledger.images || []).filter((c) => c.file !== file);
  ledger.images.push({
    file, source: "openverse", title: r.title || "", creator: r.creator || "unknown", creator_url: r.creator_url || "",
    license: licenseName(r), license_url: r.license_url || "", url: r.foreign_landing_url, openverse_id: r.id,
    alt, ...(forSlot ? { for: forSlot } : {}), changes: ["Resized and compressed.", changes].filter(Boolean).join(" "),
    ai: ["chose", ...(changes ? ["treated"] : []), "alt"], ...(changes ? { treated: changes } : {}),
  });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  const final = await sharp(out).metadata();
  console.log(`${file}: ${final.width}×${final.height}, ${Math.round(out.length / 1024)} KB, ${licenseName(r)} by ${r.creator || "unknown"}. Use it as { "src": "${as}.jpg", "alt": "${alt}" }.`);
} else if (cmd === "treat" && arg) {
  const file = arg.startsWith("src/") ? arg : `src/assets/images/${arg}`;
  if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
  if (!/\.jpe?g$/i.test(file)) throw new Error("treat works on JPEG files; convert the photo to .jpg first");
  const ledgerPath = "design/credits.json";
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { images: [] };
  const entry = (ledger.images || []).find((c) => c.file === file);
  if (!entry) throw new Error(`${file} has no entry in ${ledgerPath}; credit it first`);
  if (entry.treated) throw new Error(`${file} was already treated (${entry.treated}); start again from the original`);
  const imagery = readImagery();
  if (imagery.treatment === "none" && !imagery.grain) throw new Error("DESIGN.md sets no imagery treatment");
  const { buffer, changes } = await applyTreatment(readFileSync(file), { ...imagery, palette: readPalette() });
  writeFileSync(file, buffer);
  entry.treated = changes;
  entry.changes = [entry.changes, changes].filter(Boolean).join(" ");
  step(entry, "treated");
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`${file}: ${changes}`);
} else if (cmd === "crop" && arg) {
  const file = arg.startsWith("src/") ? arg : `src/assets/images/${arg}`;
  if (!existsSync(file)) throw new Error(`${file} doesn't exist`);
  const name = file.split("/").pop().replace(/\.[a-z]+$/i, "");
  if (existsSync(`design/spot/${name}`)) throw new Error(`${file} carries spot colour: node scripts/spot-colour.mjs undo ${name}, crop, then outline and apply again`);
  const cut = String(opt("cut") || "").split(",").map(Number);
  if (cut.length !== 4 || cut.some((v) => !(v >= 0 && v < 0.5))) throw new Error("--cut left,top,right,bottom: the share to cut from each edge, each under 0.5");
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  const entry = (ledger.images || []).find((c) => c.file === file);
  if (!entry) throw new Error(`${file} has no entry in ${LEDGER}; credit it first`);
  // A photo cropped before is cropped again from the kept uncropped copy, the two cuts made into one, so it is
  // compressed once and the credit records the whole cut.
  const kept = `design/image-candidates/${file.split("/").pop().replace(/(\.[a-z]+)$/i, "-uncropped$1")}`;
  const again = Array.isArray(entry.cropped) && existsSync(kept);
  const [l0, t0, r0, b0] = again ? entry.cropped : [0, 0, 0, 0];
  const total = again ? [l0 + cut[0] * (1 - l0 - r0), t0 + cut[1] * (1 - t0 - b0), r0 + cut[2] * (1 - l0 - r0), b0 + cut[3] * (1 - t0 - b0)].map((v) => Math.round(v * 1e4) / 1e4) : cut;
  const cropOne = async (from, to, by, keep) => {
    const buf = readFileSync(from), m = await sharp(buf).metadata();
    const left = Math.round(by[0] * m.width), top = Math.round(by[1] * m.height);
    const width = Math.round(m.width * (1 - by[0] - by[2])), height = Math.round(m.height * (1 - by[1] - by[3]));
    if (keep) { mkdirSync("design/image-candidates", { recursive: true }); writeFileSync(kept, buf); }
    const out = sharp(buf).extract({ left, top, width, height });
    writeFileSync(to, await (m.format === "png" ? out.png() : out.jpeg({ quality: 90, mozjpeg: true })).toBuffer());
    return `${m.width}x${m.height} to ${width}x${height}`;
  };
  const size = again ? await cropOne(kept, file, total, false) : await cropOne(file, file, cut, true);
  // Another version of the same photo (a colour original kept for outlining) takes this cut from where it stands.
  if (typeof opt("also") === "string") await cropOne(opt("also"), opt("also"), cut, false);
  entry.cropped = total;
  step(entry, "cropped");
  if (!again) entry.changes = [entry.changes, "Cropped."].filter(Boolean).join(" ");
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`${file}: cropped ${size}; the uncropped photo is in design/image-candidates/.`);
} else if ((cmd === "shelve" || cmd === "unshelve") && arg) {
  // The library keeps a photo and its credit together, off the pages: shelve moves both out of src/ and
  // design/credits.json into design/library/; unshelve brings them back.
  const name = arg.split("/").pop();
  const [fromDir, toDir, fromLedger, toLedger] = cmd === "shelve"
    ? ["src/assets/images", LIBRARY, LEDGER, `${LIBRARY}/credits.json`]
    : [LIBRARY, "src/assets/images", `${LIBRARY}/credits.json`, LEDGER];
  const from = `${fromDir}/${name}`, to = `${toDir}/${name}`;
  if (!existsSync(from)) throw new Error(`${from} doesn't exist`);
  if (existsSync(to)) throw new Error(`${to} already exists`);
  if (cmd === "shelve") {
    const used = existsSync("src/content") ? readdirSync("src/content").filter((f) => f.endsWith(".json") && readFileSync(`src/content/${f}`, "utf8").includes(`"${name}"`)) : [];
    if (used.length) throw new Error(`${name} is still used in src/content/${used.join(", src/content/")}; take it off the page first`);
  }
  const a = readLedger(fromLedger), z = readLedger(toLedger);
  const entry = (a.images || []).find((c) => c.file === from);
  if (!entry) throw new Error(`${from} has no entry in ${fromLedger}`);
  mkdirSync(toDir, { recursive: true });
  renameSync(from, to);
  a.images = a.images.filter((c) => c !== entry);
  z.images = [...(z.images || []).filter((c) => c.file !== to), { ...entry, file: to }];
  writeLedger(fromLedger, a);
  writeLedger(toLedger, z);
  console.log(cmd === "shelve" ? `${name} is in the library (${to}), credit and all. Bring it back with: node scripts/images.mjs unshelve ${name}` : `${name} is back in ${to}. Use it as { "src": "${name}", "alt": "${entry.alt}" }.`);
} else if (cmd === "library") {
  const shelf = readLedger(`${LIBRARY}/credits.json`).images || [];
  if (!shelf.length) { console.log("The library (design/library/) is empty."); process.exit(0); }
  const items = [];
  for (const c of shelf) {
    const thumb = existsSync(c.file) ? `data:image/jpeg;base64,${(await sharp(c.file).resize({ width: 480 }).jpeg().toBuffer()).toString("base64")}` : "";
    items.push({ thumb, caption: `${c.file.split("/").pop()} · ${c.source}${c.for ? ` · was: ${c.for}` : ""} · ${c.alt}` });
    console.log(`${c.file.split("/").pop().padEnd(32)} ${String(c.source).padEnd(10)} ${c.alt}`);
  }
  await contactSheet(`${LIBRARY}/sheet.png`, items);
  console.log(`\n${shelf.length} in the library. Contact sheet: ${LIBRARY}/sheet.png. Use one with: node scripts/images.mjs unshelve <file>`);
} else {
  console.error('usage: images.mjs search "<query>" [--source loc] [--count 20] [--any-size] | add <openverse id|loc:<id>> --as <name> --alt "<text>" [--for "<slot: why>"] [--allow-small] [--crop l,t,r,b] | treat <file> | shelve <file> | unshelve <file> | library');
  process.exit(2);
}
