#!/usr/bin/env node
// Spot colour: one object in a black and white photograph, tinted in the site's accent, the way prints were coloured by
// hand (docs/SPEC.md section 12, "Spot colour"). Pick something that belongs to the photo's story: an article of
// clothing, a camera, a reel or strip of film, a ticket, a sign: never something random in the background, never a
// face or skin. One object per photograph.
//
//   node scripts/spot-colour.mjs mask <file in src/assets/images> --what "<the object>" --point x,y [--point x,y]
//        [--not x,y] [--box left,top,right,bottom] [--pick 1|2|3]
//   node scripts/spot-colour.mjs mask <file> --what "<lettering>" --box l,t,r,b | --quad x1,y1,...,x4,y4 --tone dark|light
//        [--threshold 0.4]
//   ... --add | --cut   adds this outline to the photo's outline so far, or cuts it out of it: an object in several
//        pieces (the film on two reels and the strip between them; a camera and its tripod; a jacket's collar and
//        cuffs) is outlined piece by piece, each with its own points and box. Without either, an outline starts afresh.
//   ... --add|--cut --box l,t,r,b (or --quad ...) with no points and no tone takes that shape whole: a stray piece
//        cut off, or a part the segmenter can't see added by hand.
//   ... --ellipse cx,cy,rx,ry draws a round object by hand (centre and radii, shares of the width and height): a
//        reel seen face on. It can start an outline, or be added or cut.
//   ... --fill          fills small holes inside the outline (a printed logo, a crease left out).
//   ... --spots radius[,contrast]  with --tone: finds small round spots of about that radius in pixels that stand out
//        from what's round them (light bulbs round a marquee, even beside a sign as bright as they are), instead of
//        every light pixel. Lettering in the shape can make spots too: --cut the sign's face afterwards.
//   ... --open radius  with --tone: drops anything thinner than 2 * radius + 1 pixels (the thin shadow under a sign's
//        edge between the tops of its letters), keeping the rest whole.
//   ... --specks pixels  with --tone: drops any separate part of the piece smaller than that many pixels (grain, the
//        halo round a screw head), after --open: unlike --open it never breaks a thin tube into dashes.
//   ... --grow radius  with --tone: widens the piece by that many pixels all round, after --open: a thin neon tube takes in
//        its glow and reads as lit in the accent rather than as a hairline.
//   ... --local radius  with --tone: measures each pixel against the average within that radius instead of an absolute
//        lightness, and --threshold (0.05 if left out) is how far it must stand out: a neon tube on a ceiling lit
//        unevenly from end to end. Each pixel is first averaged with its neighbours, so a scan's grain doesn't count.
//   ... --from <file>   outlines on another version of the same photograph (the colour original of an owner's photo,
//        same framing): colour separates two garments that are one grey. The tint still goes on the photo itself.
//       → design/spot/<name>/mask.png (the outline with a soft edge, which apply tints through), outline.png (the same
//         outline with a hard edge, which the next --add or --cut builds on) and preview.jpg (the photo, the outline,
//         the tinted result). Changes nothing yet.
//         Points and the box are shares of the width and height (0..1): put a point on the object, --not on what the
//         outline wrongly took in (a face above a jacket), and a box round it: nothing outside the box is tinted. The
//         segmenter offers three outlines; --pick another if the first is wrong. For lettering on a sign, --tone takes the dark (or light) pixels inside the box (or a four-cornered
//         --quad, for a sign seen at an angle) instead, with no model. Look at preview.jpg every time.
//   node scripts/spot-colour.mjs apply <file> --by "<the model that chose the object>" [--strength 0.9] [--keep-tone]
//       → keeps the untinted photo in design/spot/<name>/original.<ext> (the first time), writes the tinted photo in
//         its place and records it in design/credits.json (spot: what, colour, model, segmenter, date). The Website
//         assets page says what was coloured and how in the photo's entry, and under "How the colour was added" offers
//         the script (public/tools/spot-colour.mjs, standalone) and a prompt for any AI model or agent
//         (public/tools/spot-colour-prompt.md) for visitors to do the same.
//   node scripts/spot-colour.mjs undo <file>    → the untinted photo back, the record removed
//   node scripts/spot-colour.mjs sheet          → design/spot/sheet.jpg: every tinted photo, before and after
//   node scripts/spot-colour.mjs tools          → writes the visitor's script and prompt again (after editing spotNote)
//
// The outline comes from SlimSAM (Xenova/slimsam-77-uniform, Apache-2.0; a compressed Segment Anything model) run
// locally with Transformers.js (@huggingface/transformers, Apache-2.0), both fetched into node_modules/.cache/spot-colour
// on first use (about 750 MB with the ONNX runtime; the model itself is 14 MB), never into package.json. The colour is
// the accent from tokens.css, laid on in OKLab (scripts/lib/spot.mjs): each pixel keeps the photograph's lightness, so
// light, shadow, folds and grain stay. The object's middle tone is first moved halfway to the accent's lightness, as a
// dense dye would, so a light object reads red rather than pink and a dark one red rather than near black
// (--keep-tone leaves its tones alone).
// The Website assets page's note on the colour, the gist of the owner's brief in plain words, goes in
// design/credits.json as "spotNote"; the visitor's prompt repeats it.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { readPalette } from "./lib/treatment.mjs";
import { coverage, dropSpecks, fillHoles, grow, open, parseShares, spots, tint, toneGamma, toneMask } from "./lib/spot.mjs";
import { PROMPT, promptText, standaloneScript, TOOL } from "./lib/spot-tool.mjs";

for (const ev of ["uncaughtException", "unhandledRejection"]) process.on(ev, (e) => (console.error(`error: ${e?.message || e}`), process.exit(1)));
const [cmd, arg, ...rest] = process.argv.slice(2);
const all = (name) => rest.flatMap((v, i) => (rest[i - 1] === `--${name}` ? [v] : []));
const opt = (name) => all(name)[0];
const IMAGES = "src/assets/images";
const DIR = "design/spot";
const CACHE = resolve("node_modules/.cache/spot-colour");
const TRANSFORMERS = "4.3.1"; // released 2026-10-06
const PKG = `@huggingface/transformers@${TRANSFORMERS}`;
const MODEL = "Xenova/slimsam-77-uniform";
const SEGMENTER = `SlimSAM (${MODEL}, Apache-2.0) with Transformers.js 4.3.1`;
const CREDITS = "design/credits.json";

const nameOf = (file) => basename(file, extname(file));
const fileOf = (file) => {
  const f = join(IMAGES, basename(file));
  if (!existsSync(f)) throw new Error(`${f} doesn't exist`);
  return f;
};
const readCredits = () => JSON.parse(readFileSync(CREDITS, "utf8"));
const writeCredits = (c) => writeFileSync(CREDITS, JSON.stringify(c, null, 2) + "\n");
const entryOf = (credits, file) => {
  const e = credits.images.find((i) => i.file === file);
  if (!e) throw new Error(`${file} has no entry in ${CREDITS}`);
  return e;
};

async function segmenter() {
  const dir = join(CACHE, "node_modules", "@huggingface", "transformers");
  if (!existsSync(dir)) {
    mkdirSync(CACHE, { recursive: true });
    if (!existsSync(join(CACHE, "package.json"))) writeFileSync(join(CACHE, "package.json"), '{ "private": true }\n');
    console.log(`Fetching ${PKG} into ${CACHE} (once)...`);
    execFileSync("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund", "--prefix", CACHE, PKG], { stdio: ["ignore", "ignore", "inherit"] });
  }
  // The package's Node entry (exports["."].node.import in 4.3.1).
  const tf = await import(pathToFileURL(join(dir, "dist", "transformers.node.mjs")).href);
  tf.env.cacheDir = join(CACHE, "models");
  return tf;
}

if (cmd === "mask" && arg) {
  const file = fileOf(arg), name = nameOf(file);
  // A photo already tinted is outlined again on its untinted original, so the old colour can't steer the outline.
  const source = untinted(file);
  const mode = rest.includes("--add") ? "add" : rest.includes("--cut") ? "cut" : "new";
  const before = mode === "new" ? null : previous(name);
  const what = opt("what") || before?.what;
  if (!what || what === true) throw new Error('say what the object is: --what "the cameraman\'s jacket"');
  const points = all("point").map((p) => parseShares(p, 2));
  const not = all("not").map((p) => parseShares(p, 2));
  const box = opt("box") ? parseShares(opt("box"), 4) : null;
  const quad = opt("quad") ? parseShares(opt("quad"), 8) : null;
  const ellipse = opt("ellipse") ? parseShares(opt("ellipse"), 4) : null;
  if (ellipse) {
    // A round object drawn by hand (a reel seen face on, a can's lid): centre x,y and radii, in shares of the width
    // and height. It can start an outline, or be added or cut like any other piece.
    const meta = await sharp(source).metadata();
    const [cx, cy, rx, ry] = ellipse, W = meta.width, H = meta.height, m = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (((x + 0.5) / W - cx) ** 2 / rx ** 2 + ((y + 0.5) / H - cy) ** 2 / ry ** 2 <= 1) m[y * W + x] = 255;
    await finish(file, what, await combine(name, mode, m, W, H), W, H, record(before, mode, { ellipse, segmenter: "an ellipse drawn by hand round the object" }));
    process.exit(0);
  }
  if (!points.length && !box && !quad) throw new Error("give at least one --point x,y on the object (or a --box)");
  // A shape with no points and no tone is taken whole: for cutting a stray piece off (--cut --box ...) or adding a part
  // the segmenter can't see, drawn by hand (--add --quad ...).
  const region = !opt("tone") && !points.length;
  if (region && mode === "new") throw new Error("an outline needs at least one --point x,y on the object (a --box only limits it); a bare --box or --quad works with --add or --cut");
  const tone = region ? "dark" : opt("tone");
  if (tone) {
    if (!["dark", "light"].includes(tone) || !(box || quad)) throw new Error("--tone is dark or light, and needs a --box or --quad round the lettering");
    const local = opt("local") ? Number(opt("local")) : 0;
    if (opt("local") && !(local >= 1)) throw new Error("--local radius: measure each pixel against the average within that many pixels round it");
    const threshold = region ? 2 : Number(opt("threshold") ?? (local ? 0.05 : tone === "dark" ? 0.4 : 0.6));
    const { data, info } = await sharp(source).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const part = region ? { box, quad, segmenter: `a ${quad ? "four-cornered shape" : "box"} drawn by hand` } : { points, not, box, quad, tone, threshold, ...(local ? { local } : {}), segmenter: local ? `the pixels ${threshold} ${tone === "dark" ? "darker" : "lighter"} than the average within ${local} pixels round them (each pixel first averaged with its neighbours, past the film grain), inside a ${quad ? "four-cornered shape" : "box"} drawn round it` : `the ${tone} pixels (lightness ${tone === "dark" ? "under" : "over"} ${threshold}) inside a ${quad ? "four-cornered shape" : "box"} drawn round it` };
    const [radius, contrast = 0.08] = opt("spots") ? String(opt("spots")).split(",").map(Number) : [];
    if (opt("spots") && !(radius >= 1 && contrast > 0 && contrast < 1)) throw new Error("--spots radius[,contrast]: a spot's radius in pixels (and how far it stands out, 0..1; 0.08 if left out)");
    let found;
    if (radius) {
      found = spots(data, info.width, info.height, quad || box, tone, threshold, radius, contrast);
      Object.assign(part, { spots: { radius, contrast }, segmenter: `round ${tone} spots about ${2 * radius} pixels across that stand out from what's round them (a difference of Gaussians), lightness ${tone === "dark" ? "under" : "over"} ${threshold}, inside a ${quad ? "four-cornered shape" : "box"} drawn round them` });
    } else found = toneMask(data, info.width, info.height, quad || box, tone, threshold, local);
    const thin = opt("open") ? Number(opt("open")) : 0;
    if (opt("open") && !(Number.isInteger(thin) && thin >= 1)) throw new Error("--open radius: drop anything thinner than 2 * radius + 1 pixels (a whole number from 1)");
    if (thin) { found = open(found, info.width, info.height, thin); part.opened = thin; part.segmenter += `, without anything under ${2 * thin + 1} pixels thick`; }
    const least = opt("specks") ? Number(opt("specks")) : 0;
    if (opt("specks") && !(Number.isInteger(least) && least >= 2)) throw new Error("--specks pixels: drop any separate part of this piece smaller than that many pixels (a whole number from 2)");
    if (least) { found = dropSpecks(found, info.width, info.height, least); part.specks = least; part.segmenter += `, without specks under ${least} pixels`; }
    const more = opt("grow") ? Number(opt("grow")) : 0;
    if (opt("grow") && !(Number.isInteger(more) && more >= 1)) throw new Error("--grow radius: widen the piece by that many pixels all round (a whole number from 1)");
    if (more) { found = grow(found, info.width, info.height, more); part.grown = more; part.segmenter += `, widened by ${more} pixels to take in its glow`; }
    const mask = await combine(name, mode, found, info.width, info.height);
    await finish(file, what, mask, info.width, info.height, record(before, mode, part));
    process.exit(0);
  }
  const { SamModel, AutoProcessor, RawImage } = await segmenter();
  const model = await SamModel.from_pretrained(MODEL, { dtype: "q8" });
  const processor = await AutoProcessor.from_pretrained(MODEL);
  const from = opt("from");
  if (from && !existsSync(from)) throw new Error(`${from} doesn't exist`);
  const meta = await sharp(source).metadata();
  // Another version of the same photograph (a colour original) is brought to the photo's own size, so the outline
  // lands on the photo; the framing has to match.
  const image = from
    ? await RawImage.fromBlob(new Blob([await sharp(from).resize(meta.width, meta.height, { fit: "fill" }).removeAlpha().png().toBuffer()]))
    : await RawImage.read(source);
  const { width: W, height: H } = image;
  const px = ([x, y]) => [x * W, y * H];
  const input = {};
  if (points.length || not.length) {
    input.input_points = [[[...points, ...not].map(px)]];
    input.input_labels = [[[...points.map(() => 1), ...not.map(() => 0)]]];
  }
  // The SlimSAM ONNX export takes points only (its decoder has no box input in Transformers.js 4.3.1: a box prompt is
  // dropped with a warning), so a --box limits the outline afterwards instead: nothing outside it is tinted.
  const inputs = await processor(image, input);
  const outputs = await model(inputs);
  const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
  const scores = Array.from(outputs.iou_scores.data);
  const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i);
  const pick = opt("pick") ? order[Number(opt("pick")) - 1] : order[0];
  if (pick === undefined) throw new Error("--pick is 1, 2 or 3");
  const data = masks[0].data, plane = W * H;
  const mask = Buffer.alloc(plane);
  for (let p = 0; p < plane; p++) mask[p] = data[pick * plane + p] ? 255 : 0;
  if (box) {
    const [x0, y0, x1, y1] = [box[0] * W, box[1] * H, box[2] * W, box[3] * H];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) mask[y * W + x] = 0;
  }
  console.log(`${name}: outline ${order.indexOf(pick) + 1} of 3 (score ${scores[pick].toFixed(2)})`);
  const method = [SEGMENTER, box && "kept within a box drawn round the object", from && "outlined on the colour original"].filter(Boolean).join(", ");
  const part = { points, not, box, pick: order.indexOf(pick) + 1, scores, ...(from ? { from: basename(from) } : {}), segmenter: method };
  await finish(file, what, await combine(name, mode, mask, W, H), W, H, record(before, mode, part));
} else if (cmd === "apply" && arg) {
  const file = fileOf(arg), name = nameOf(file), out = join(DIR, name);
  const by = opt("by");
  if (!by || by === true) throw new Error('say which model chose the object: --by "Claude Opus 5.5 (Anthropic)"');
  if (!existsSync(join(out, "mask.png"))) throw new Error(`no outline yet: node scripts/spot-colour.mjs mask ${basename(file)} --what "..." --point x,y`);
  const spec = JSON.parse(readFileSync(join(out, "spot.json"), "utf8"));
  const original = join(out, `original${extname(file)}`);
  if (!existsSync(original)) copyFileSync(file, original);
  const strength = Number(opt("strength") ?? 1);
  const { accent } = readPalette();
  const buffer = await spotted(original, join(out, "mask.png"), accent, strength, !rest.includes("--keep-tone"));
  writeFileSync(file, buffer);
  const credits = readCredits();
  const entry = entryOf(credits, file);
  const hex = `#${accent.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  entry.spot = { what: spec.what, colour: hex, chosenBy: by, segmenter: spec.segmenter, method: "OKLab: the accent's hue and chroma over the photograph's own lightness", date: new Date().toISOString().slice(0, 10) };
  // The Website assets page names the model behind all the picture work (src/lib/ai-use.js).
  if (!credits.aiBy) credits.aiBy = by;
  writeCredits(credits);
  publishTools(credits, hex);
  console.log(`${basename(file)}: ${spec.what} tinted ${hex}. The untinted photo is ${original}.`);
} else if (cmd === "undo" && arg) {
  const file = fileOf(arg), out = join(DIR, nameOf(file));
  const original = join(out, `original${extname(file)}`);
  if (!existsSync(original)) throw new Error(`${basename(file)} has no spot colour to undo`);
  copyFileSync(original, file);
  rmSync(out, { recursive: true, force: true });
  const credits = readCredits();
  delete entryOf(credits, file).spot;
  writeCredits(credits);
  if (!credits.images.some((i) => i.spot)) for (const f of [TOOL, PROMPT]) rmSync(f, { force: true });
  console.log(`${basename(file)}: back to the untinted photo.`);
} else if (cmd === "tools") {
  const credits = readCredits();
  const spotted = credits.images.filter((i) => i.spot);
  if (!spotted.length) throw new Error("no tinted photos yet");
  publishTools(credits, spotted[0].spot.colour);
  console.log(`${TOOL} and ${PROMPT} written`);
} else if (cmd === "sheet") {
  const names = existsSync(DIR) ? readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && readdirSync(join(DIR, d.name)).some((f) => f.startsWith("original."))).map((d) => d.name) : [];
  if (!names.length) throw new Error("no tinted photos yet");
  const tiles = [];
  for (const n of names) {
    const orig = join(DIR, n, readdirSync(join(DIR, n)).find((f) => f.startsWith("original.")));
    const now = join(IMAGES, `${n}${extname(orig)}`);
    const pair = await Promise.all([orig, now].map((f) => sharp(f).resize({ height: 260 }).toBuffer()));
    const w = (await sharp(pair[0]).metadata()).width;
    tiles.push(await sharp({ create: { width: w * 2 + 8, height: 260, channels: 3, background: "#ffffff" } })
      .composite([{ input: pair[0], left: 0, top: 0 }, { input: pair[1], left: w + 8, top: 0 }]).png().toBuffer());
  }
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const width = Math.max(...metas.map((m) => m.width));
  const sheet = await sharp({ create: { width, height: tiles.length * 276, channels: 3, background: "#ffffff" } })
    .composite(tiles.map((input, i) => ({ input, left: 0, top: i * 276 }))).png().toBuffer();
  writeFileSync(join(DIR, "sheet.jpg"), await sharp(sheet).jpeg({ quality: 80 }).toBuffer());
  console.log(`${join(DIR, "sheet.jpg")}: ${names.length} photos, before and after`);
} else {
  console.error("usage: node scripts/spot-colour.mjs mask <file> --what \"...\" --point x,y [--not x,y] [--box l,t,r,b] [--pick n] [--add|--cut] [--from <colour original>] | apply <file> --by \"<model>\" | undo <file> | sheet | tools");
  process.exit(2);
}

// The photo as it was before any spot colour: design/spot/<name>/original.<ext> once a colour has been applied.
function untinted(file) {
  const kept = join(DIR, nameOf(file), `original${extname(file)}`);
  return existsSync(kept) ? kept : file;
}

// The record of the outline so far (design/spot/<name>/spot.json), for --add and --cut.
function previous(name) {
  const f = join(DIR, name, "spot.json");
  if (!existsSync(f)) throw new Error(`${name} has no outline yet to add to: start one without --add or --cut`);
  return JSON.parse(readFileSync(f, "utf8"));
}

// A fresh outline, or this piece added to (or cut from) the outline so far, read from outline.png, its hard-edged
// copy. The soft mask.png, blurred and read back at half after every piece, wore thin things away: each piece added
// pulled the end of a neon tube back a little further, and a line two pixels thick vanished at once. An outline saved
// before outline.png existed is read from mask.png, as the pixels at least half inside it.
async function combine(name, mode, mask, W, H) {
  if (mode === "new") return mask;
  const hard = join(DIR, name, "outline.png");
  const so = await sharp(existsSync(hard) ? hard : join(DIR, name, "mask.png")).resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const out = Buffer.alloc(W * H);
  for (let p = 0; p < W * H; p++) {
    const was = so[p] >= 128, now = mask[p] >= 128;
    out[p] = (mode === "add" ? was || now : was && !now) ? 255 : 0;
  }
  return out;
}

// One piece's record, or the pieces so far with this one added. The segmenter line names every method used.
function record(before, mode, part) {
  if (mode === "new") return part;
  const { file, what, coverage, parts, ...first } = before;
  const all = [...(parts || [{ op: "add", ...first }]), { op: mode, ...part }];
  return { parts: all, segmenter: [...new Set(all.map((p) => p.segmenter))].join("; ") };
}

// Writes the outline twice, hard-edged and with a soft edge of about a thousandth of the picture (so the tint meets
// the photograph without a cut line), its record and the preview.
async function finish(file, what, mask, W, H, record) {
  const name = nameOf(file), out = join(DIR, name);
  if (rest.includes("--fill")) { mask = fillHoles(mask, W, H); record = { ...record, filled: true }; }
  const share = coverage(mask);
  mkdirSync(out, { recursive: true });
  await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).toColourspace("b-w").png({ compressionLevel: 9 }).toFile(join(out, "outline.png"));
  // sharp hands a blurred single-channel image back as three channels; keep the first.
  const soft = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(0.6, Math.min(W, H) / 1000)).extractChannel(0).raw().toBuffer();
  await sharp(soft, { raw: { width: W, height: H, channels: 1 } }).toColourspace("b-w").png().toFile(join(out, "mask.png"));
  writeFileSync(join(out, "spot.json"), JSON.stringify({ file, what, ...record, coverage: Math.round(share * 1000) / 1000 }, null, 2) + "\n");
  await preview(file, soft, mask, join(out, "preview.jpg"), what);
  console.log(`${name}: ${(share * 100).toFixed(1)}% of the picture. Look at ${join(out, "preview.jpg")}.`);
  if (share > 0.25) console.log("  That's a lot of the picture for one object: check it took only the object, or add --not points.");
  if (share < 0.002) console.log("  That's a speck: check the point is on the object.");
}

// The tinted photo from the untinted one and the outline.
async function spotted(original, maskFile, accent, strength, matchTone) {
  const img = sharp(original);
  const meta = await img.metadata();
  const { data, info } = await img.removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(maskFile).resize(info.width, info.height).extractChannel(0).raw().toBuffer();
  const out = tint(data, mask, accent, strength, matchTone ? toneGamma(data, mask, accent) : 1);
  const pipe = sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } });
  return meta.format === "png" ? pipe.png().toBuffer() : pipe.jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

// The photo, its outline in the accent, and the tinted result, side by side.
async function preview(shown, mask, hard, to, what) {
  const { accent } = readPalette();
  const file = untinted(shown);
  const meta = await sharp(file).metadata();
  const full = await sharp(file).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const gamma = toneGamma(full, hard, accent);
  const H = 520, W = Math.round((meta.width * H) / meta.height);
  const base = await sharp(file).resize(W, H).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const m = await sharp(mask, { raw: { width: meta.width, height: meta.height, channels: 1 } }).resize(W, H).extractChannel(0).raw().toBuffer();
  const edge = await sharp(m, { raw: { width: W, height: H, channels: 1 } }).convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] }).extractChannel(0).raw().toBuffer();
  const outlined = Buffer.from(base);
  for (let p = 0; p < W * H; p++) if (edge[p] > 40) [outlined[p * 3], outlined[p * 3 + 1], outlined[p * 3 + 2]] = accent;
  const tinted = tint(base, m, accent, 1, gamma);
  const panes = await Promise.all([base, outlined, tinted].map((b) => sharp(b, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()));
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 3 + 16}" height="36"><rect width="100%" height="100%" fill="#ffffff"/><text x="6" y="24" font-family="sans-serif" font-size="18" fill="#111111">${String(what).replace(/&/g, "&amp;").replace(/</g, "&lt;")}: the photo, the outline, the tint</text></svg>`;
  await sharp({ create: { width: W * 3 + 16, height: H + 36, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from(label), left: 0, top: 0 }, ...panes.map((input, i) => ({ input, left: i * (W + 8), top: 36 }))]).jpeg({ quality: 82 }).toFile(to);
}

// The script and the prompt a visitor can take from the Website assets page. The brief is the site's own
// (design/credits.json "spotNote", in the owner's words where they gave them).
function publishTools(credits, colour) {
  const site = JSON.parse(readFileSync("site.config.json", "utf8")).site;
  const url = `https://${site.canonicalHost}/credits`;
  const brief = credits.spotNote || "One object in each black and white photograph, coloured in the site's own colour: something that belongs to the picture's story, never a face, and nothing else in the photograph changed.";
  const sharpVersion = JSON.parse(readFileSync("node_modules/sharp/package.json", "utf8")).version;
  mkdirSync("public/tools", { recursive: true });
  writeFileSync(TOOL, standaloneScript({ site: site.name, url, colour, transformers: TRANSFORMERS, sharpVersion }));
  writeFileSync(PROMPT, promptText({ site: site.name, url, colour, brief }));
}
