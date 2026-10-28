#!/usr/bin/env node
// Generated images in the site's imagery style, from Cloudflare Workers AI (FLUX.2 [klein] 4B, Apache 2.0).
// For illustrations, textures and scenes that set a mood: never the business's own people, premises, products,
// work or results, which only the owner's photos may show. Every generated image is credited as generated and listed
// on /credits; none carries a label on the page (owner's decision, docs/DECISIONS.md 2026-10-28).
//
//   node scripts/generate-image.mjs draft "<subject>" --as <name> [--aspect 3:2] [--count 4] [--style <style>] [--seed <n>] [--account <id>] [--dry-run]
//       → design/generated/<name>/1.jpg … and sheet.png (numbered) + prompt.json. Look at the sheet before choosing.
//   node scripts/generate-image.mjs use <name> <number> --alt "<what it shows>"
//       → src/assets/images/<name>.jpg with the DESIGN.md imagery treatment, and its design/credits.json entry
//
// The style and art direction come from DESIGN.md (imagery.style, imagery.prompt) via src/styles/design.json; the
// palette comes from tokens.css. --style overrides the style for one image (for example imagery.secondary).
// Needs CLOUDFLARE_ACCOUNT_ID (or --account) and a token with Workers AI Read and Edit (docs/TOKENS.md section 5):
// WORKERS_AI_TOKEN, CLOUDFLARE_API_TOKEN when that token has those permissions, or none at all when the agent's
// environment adds it on the way out (a Claude cloud environment's network secret for api.cloudflare.com, which
// keeps the token out of the agent's reach). The token is sent only to api.cloudflare.com and never printed.
//
// Model facts (developers.cloudflare.com/workers-ai, checked 2026-10-28): multipart form input; width and height
// 256-1920 (multiples of 16 here); steps fixed at 4; output JSON { result: { image: <base64> } }. Price 26.05 neurons per
// output 512×512 tile; the Free plan includes 10,000 neurons a day (a 1536×1024 image is about 156, so roughly 60 a
// day). Licence: Apache 2.0 (help.bfl.ai "How does FLUX licensing work?", checked 2026-10-28).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { applyTreatment, readImagery, readPalette } from "./lib/treatment.mjs";

for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => (console.error(`error: ${e?.message || e}`), process.exit(1)));
const MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const MODEL_NAME = "FLUX.2 [klein] 4B (Black Forest Labs) on Cloudflare Workers AI";
const NEURONS_PER_TILE = 26.05;
const ASPECTS = { "1:1": [1024, 1024], "3:2": [1536, 1024], "4:3": [1472, 1104], "4:5": [1024, 1280], "2:3": [1024, 1536], "16:9": [1920, 1088], "21:9": [1920, 816] };

// One line per imagery style: what the picture should look like. Owner photos and documentary stock are never
// generated; icon-led sites use the icon set instead.
const STYLE_PROMPTS = {
  "photoreal-generated": "Editorial documentary photograph, natural light, real textures, shallow depth of field, candid and unposed, not glossy, no visible faces (people only as distant figures, hands or silhouettes)",
  "line-art": "Minimal continuous line drawing, single weight ink line on a plain background, generous empty space",
  "flat-illustration": "Flat vector illustration, simple geometric shapes, limited palette, no gradients, no outlines, editorial magazine style",
  "watercolor": "Loose watercolour painting on textured paper, soft washes, visible brush edges, light and airy",
  "3d": "Soft 3D render, matte clay materials, gentle studio lighting, rounded forms, simple composition",
  "isometric": "Isometric illustration, clean 30-degree angles, simple shapes, limited palette, light shadows",
  "collage": "Cut-paper collage, torn edges, layered paper textures, halftone photo fragments, bold composition",
  "cartoon": "Friendly hand-drawn cartoon illustration, thick confident lines, warm and simple, no text",
  "abstract": "Abstract composition of shapes, light and texture, no objects or people, calm and balanced",
};
const NOT_GENERATED = ["owner-photo", "documentary-stock", "icon-led"];

const [cmd, ...args] = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const next = args[i + 1];
    flags[args[i].slice(2)] = next === undefined || next.startsWith("--") ? true : (i++, next);
  } else positional.push(args[i]);
}
const accountId = () => {
  const a = (flags.account && flags.account !== true ? flags.account : process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (!/^[0-9a-f]{32}$/.test(a)) throw new Error("set CLOUDFLARE_ACCOUNT_ID or pass --account <32-character account id>");
  return a;
};
const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

function buildPrompt(subject, style, imagery) {
  const palette = readPalette();
  return [
    STYLE_PROMPTS[style] + ".",
    `Subject: ${subject}.`,
    imagery.prompt ? `Art direction: ${imagery.prompt}.` : "",
    `Colour palette close to ${hex(palette.ink)}, ${hex(palette.accent)}, ${hex(palette.highlight)} and ${hex(palette.bg)}.`,
    "No text, letters, numbers, logos, signs, watermarks or brand marks.",
  ].filter(Boolean).join(" ");
}

async function generate({ prompt, width, height, seed }) {
  const account = accountId();
  const token = process.env.WORKERS_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(width));
  form.append("height", String(height));
  form.append("seed", String(seed));
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`, {
    method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form, signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.result?.image) {
    const why = (body?.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    const hint = res.status === 401 || res.status === 403 ? token ? " The token needs Workers AI Read and Edit." : " No token was sent: set WORKERS_AI_TOKEN, or add a network secret for api.cloudflare.com." : "";
    throw new Error(`Workers AI refused the request (${why}).${hint}`);
  }
  return Buffer.from(body.result.image, "base64");
}

async function contactSheet(files, out) {
  const thumbs = await Promise.all(files.map(async (f, i) => {
    const img = await sharp(f).resize({ width: 480, height: 360, fit: "cover" }).toBuffer();
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect x="8" y="8" width="44" height="34" rx="6" fill="#000" opacity=".75"/><text x="30" y="33" font-family="sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${i + 1}</text></svg>`);
    return sharp(img).composite([{ input: label }]).toBuffer();
  }));
  const cols = Math.min(thumbs.length, 3);
  const rows = Math.ceil(thumbs.length / cols);
  await sharp({ create: { width: cols * 488 + 8, height: rows * 368 + 8, channels: 3, background: "#ffffff" } })
    .composite(thumbs.map((input, i) => ({ input, left: 8 + (i % cols) * 488, top: 8 + Math.floor(i / cols) * 368 })))
    .png().toFile(out);
}

if (cmd === "draft") {
  const [subject] = positional;
  const name = flags.as;
  if (!subject) throw new Error('draft "<subject>": describe what the image shows');
  if (!name || name === true || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("--as <name>: lowercase letters, digits and dashes, no extension");
  const imagery = readImagery();
  // The primary style, or the secondary one when the primary isn't generated (owner photos plus illustrations).
  const style = flags.style && flags.style !== true ? flags.style : NOT_GENERATED.includes(imagery.style) && imagery.secondary ? imagery.secondary : imagery.style;
  if (NOT_GENERATED.includes(style)) throw new Error(`the imagery style is "${style}", which isn't generated; set imagery.style or imagery.secondary in DESIGN.md to a generated style, or pass --style (${Object.keys(STYLE_PROMPTS).join(", ")})`);
  if (!STYLE_PROMPTS[style]) throw new Error(`unknown style "${style}" (${Object.keys(STYLE_PROMPTS).join(", ")})`);
  const aspect = flags.aspect && flags.aspect !== true ? flags.aspect : "3:2";
  if (!ASPECTS[aspect]) throw new Error(`--aspect must be one of ${Object.keys(ASPECTS).join(", ")}`);
  const [width, height] = ASPECTS[aspect];
  const count = Math.min(Math.max(Number(flags.count) || 4, 1), 8);
  const firstSeed = Number.isInteger(Number(flags.seed)) && flags.seed !== true ? Number(flags.seed) : Math.floor(Math.random() * 2 ** 31);
  const prompt = buildPrompt(subject, style, imagery);
  const neurons = Math.ceil((width * height) / (512 * 512)) * NEURONS_PER_TILE * count;
  console.log(`${count} × ${width}×${height} ${style}, about ${Math.round(neurons)} neurons (Free plan: 10,000 a day)\nPrompt: ${prompt}`);
  if (flags["dry-run"]) process.exit(0);
  accountId();
  const dir = `design/generated/${name}`;
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < count; i++) {
    const buf = await generate({ prompt, width, height, seed: firstSeed + i });
    const file = `${dir}/${i + 1}.jpg`;
    writeFileSync(file, await sharp(buf).jpeg({ quality: 90 }).toBuffer());
    files.push(file);
    console.log(`  ${file}`);
  }
  await contactSheet(files, `${dir}/sheet.png`);
  writeFileSync(`${dir}/prompt.json`, JSON.stringify({ subject, style, aspect, width, height, prompt, model: MODEL, seeds: files.map((_, i) => firstSeed + i), created: new Date().toISOString().slice(0, 10) }, null, 2) + "\n");
  console.log(`Look at ${dir}/sheet.png, then: node scripts/generate-image.mjs use ${name} <number> --alt "<what it shows>"`);
} else if (cmd === "use") {
  const [name, number] = positional;
  const alt = flags.alt;
  const dir = `design/generated/${name}`;
  if (!name || !existsSync(`${dir}/prompt.json`)) throw new Error(`use <name> <number>: no drafts in ${dir}; run draft first`);
  const src = `${dir}/${number}.jpg`;
  if (!existsSync(src)) throw new Error(`${src} doesn't exist`);
  if (!alt || alt === true) throw new Error('--alt "<what the image shows>" is required ("" only for a decorative image)');
  const meta = JSON.parse(readFileSync(`${dir}/prompt.json`, "utf8"));
  const file = `src/assets/images/${name}.jpg`;
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const imagery = readImagery();
  const { buffer, changes } = await applyTreatment(readFileSync(src), { ...imagery, palette: readPalette() });
  mkdirSync("src/assets/images", { recursive: true });
  writeFileSync(file, await sharp(buffer).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
  const ledgerPath = "design/credits.json";
  const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { images: [] };
  ledger.images = (ledger.images || []).filter((c) => c.file !== file);
  ledger.images.push({
    file, source: "generated", illustrative: true, style: meta.style, photoreal: meta.style === "photoreal-generated",
    model: MODEL_NAME, license: "Apache-2.0", prompt: meta.prompt, seed: meta.seeds[Number(number) - 1], created: meta.created,
    alt, changes: changes || "",
  });
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  console.log(`${file} (${meta.style}${changes ? `; ${changes}` : ""}). Use it as { "src": "${name}.jpg", "alt": "${alt}" }.`);
} else {
  console.error('usage: generate-image.mjs draft "<subject>" --as <name> [--aspect 3:2] [--count 4] [--style <style>] [--seed <n>] [--account <id>] [--dry-run] | use <name> <number> --alt "<text>"');
  process.exit(2);
}
