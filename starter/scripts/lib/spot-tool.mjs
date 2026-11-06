// What a visitor can take away from the Website assets page when a site's photos carry a spot of colour: the script,
// standalone (two npm packages, no Framework B), and a prompt that tells an AI model or agent how to do the same.
// scripts/spot-colour.mjs writes both to public/tools/ when it applies a colour; src/pages/credits.astro links them.
import { readFileSync } from "node:fs";

export const TOOL = "public/tools/spot-colour.mjs";
export const PROMPT = "public/tools/spot-colour-prompt.md";

// The arithmetic from scripts/lib/spot.mjs, word for word, then a small command around it.
export function standaloneScript({ site, url, colour, transformers, sharpVersion }) {
  const lib = readFileSync(new URL("./spot.mjs", import.meta.url), "utf8").replace(/^\/\/ scripts\/spot-colour\.mjs.*\n/m, "");
  return `#!/usr/bin/env node
// spot-colour.mjs: one object in a black and white photograph, tinted in one colour, the way prints were once
// coloured by hand. The photograph keeps its own light, shade and grain; nothing is drawn in.
// From ${site} (${url}). Free to use, change and share (MIT License).
//
// Setup (Node 20 or later), in an empty folder with this file:
//   npm install sharp@${sharpVersion} @huggingface/transformers@${transformers}
// Use:
//   node spot-colour.mjs photo.jpg --point 0.52,0.40 [--point x,y] [--not x,y] [--box left,top,right,bottom]
//        [--colour "${colour}"] [--out photo-spot.jpg]
// Points and the box are shares of the photo's width and height, from 0 to 1 (0.5,0.5 is the middle). Put a point on
// the object, --not on anything the outline wrongly takes in (a face above a jacket), and a box round the object:
// nothing outside it is coloured. It writes the coloured photo and photo-spot-outline.jpg: look at it, and move the
// points until the outline holds only the object. The outline comes from SlimSAM (Xenova/slimsam-77-uniform,
// Apache-2.0), a small Segment Anything model that runs on your computer; it downloads once (about 14 MB).
import sharp from "sharp";
import { SamModel, AutoProcessor, RawImage } from "@huggingface/transformers";

${lib.replace(/^export /gm, "")}
const args = process.argv.slice(2);
const file = args[0];
const all = (name) => args.flatMap((v, i) => (args[i - 1] === \`--\${name}\` ? [v] : []));
const hex = all("colour")[0] || "${colour}";
const accent = [1, 3, 5].map((i) => parseInt(hex.replace("#", "").padStart(7, "#").slice(i, i + 2), 16));
if (!file || !all("point").length || accent.some(Number.isNaN)) {
  console.error('usage: node spot-colour.mjs photo.jpg --point x,y [--not x,y] [--box l,t,r,b] [--colour "#rrggbb"] [--out file]');
  process.exit(2);
}
const points = all("point").map((p) => parseShares(p, 2)), not = all("not").map((p) => parseShares(p, 2));
const box = all("box")[0] ? parseShares(all("box")[0], 4) : null;
const out = all("out")[0] || file.replace(/(\\.[a-z]+)$/i, "-spot$1");
const model = await SamModel.from_pretrained("Xenova/slimsam-77-uniform", { dtype: "q8" });
const processor = await AutoProcessor.from_pretrained("Xenova/slimsam-77-uniform");
const image = await RawImage.read(file);
const W = image.width, H = image.height;
const inputs = await processor(image, { input_points: [[[...points, ...not].map(([x, y]) => [x * W, y * H])]], input_labels: [[[...points.map(() => 1), ...not.map(() => 0)]]] });
const outputs = await model(inputs);
const masks = await processor.post_process_masks(outputs.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes);
const scores = Array.from(outputs.iou_scores.data), best = scores.indexOf(Math.max(...scores));
const mask = Buffer.alloc(W * H);
for (let p = 0; p < W * H; p++) {
  const x = p % W, y = Math.floor(p / W);
  const inBox = !box || (x >= box[0] * W && x < box[2] * W && y >= box[1] * H && y < box[3] * H);
  mask[p] = inBox && masks[0].data[best * W * H + p] ? 255 : 0;
}
const soft = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).blur(Math.max(0.6, Math.min(W, H) / 1000)).extractChannel(0).raw().toBuffer();
const { data } = await sharp(file).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
const tinted = tint(data, soft, accent, 1, toneGamma(data, mask, accent));
await sharp(tinted, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 88 }).toFile(out);
const outline = Buffer.from(data);
for (let p = 0; p < W * H; p++) if (mask[p] && (!mask[p - 1] || !mask[p + 1] || !mask[p - W] || !mask[p + W])) [outline[p * 3], outline[p * 3 + 1], outline[p * 3 + 2]] = accent;
await sharp(outline, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 80 }).toFile(out.replace(/(\\.[a-z]+)$/i, "-outline$1"));
console.log(\`\${out}: \${(coverage(mask) * 100).toFixed(1)}% of the photo coloured \${hex}. Check \${out.replace(/(\\.[a-z]+)$/i, "-outline$1")}.\`);
`;
}

// The prompt: the brief and the method in plain words, for a person to hand to any AI model or agent.
export function promptText({ site, url, colour, brief }) {
  return `# Add one spot of colour to black and white photographs

From ${site} (${url}). Give this to an AI model or agent that can look at images and run code, with your photos.

## The brief

${brief}

## What to do, for each photograph

1. Look at the photograph and choose **one** object that belongs to its story: an article of clothing, a camera, a reel or strip of film, a ticket, a sign, something a person in it wears or uses. Never a face or skin, and never something random in the background. Say what you chose and why it fits.
2. Outline only that object. Use a segmentation model (for example Segment Anything, or SlimSAM, its small version, which runs on a laptop) with a point on the object, points on anything it should leave out, and a box round it; nothing outside the box is coloured. For lettering on a sign, take the dark (or light) pixels inside a shape drawn round the words instead.
3. Look at the outline at full size. If it spills onto a face, the background or the next object, move the points and try again.
4. Colour the object in ${colour} in OKLab, a perceptual colour space (https://bottosson.github.io/posts/oklab/): every pixel keeps its own lightness from the photograph and takes the colour's hue and chroma, so folds, grain and detail stay. Where that chroma doesn't fit the screen's colours at a pixel's lightness (deep shadow, near white), reduce the chroma and keep the lightness and hue, as CSS gamut mapping does (https://drafts.csswg.org/css-color-4/#gamut-mapping). First move the object's middle tone halfway to the colour's own lightness (a gamma curve on lightness, kept between 0.4 and 4), so a pale object reads as the colour and not as pink, and a dark one as the colour and not as near black. Soften the outline's edge by about a thousandth of the photo's size.
5. Change nothing else in the photograph: no drawing in, no cleaning up, no new detail.
6. Keep the untouched original next to the coloured one.
7. When you publish the photos, say that the colour was added with AI, which model chose and outlined each object, and the date.

## The script

The ready-made script that does steps 2 to 4 is at ${url.replace(/\/credits$/, "")}/tools/spot-colour.mjs. Setup and use are at the top of the file.
`;
}
