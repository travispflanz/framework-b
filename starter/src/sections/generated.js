// Whether an image needs the visible "Generated image" label: a generated, photorealistic image in
// src/assets/images/ (design/credits.json says so). Illustrations are obviously not photos and are listed on /credits.
import credits from "../../design/credits.json";

export function isLabelled(image) {
  if (!image?.src) return false;
  const c = (credits.images || []).find((x) => x.file === `src/assets/images/${image.src}`);
  return c?.source === "generated" && c?.photoreal === true;
}
