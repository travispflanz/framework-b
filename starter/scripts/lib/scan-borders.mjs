// Finds the picture inside an archive scan: the mat, the film rebate and the black frame around it are cropped off.
// Scans of old photographs and negatives carry white mats, black frames and edge markings ("KODAK SAFETY FILM",
// negative numbers, handwritten captions); left on, they show as stripes on cards and panels (seen on a real site,
// 2026-11-03). Pure function on a greyscale image; scripts/images.mjs feeds it a reduced copy of the scan.

/**
 * gray: Uint8Array (width × height, one byte a pixel). Returns { left, top, right, bottom } in pixels to cut from each
 * edge. From each edge it skips lines that are flat (a mat or a frame) or far from the picture's own brightness, until
 * eight lines in a row look like picture, looking at most `maxShare` of the way in; then adds `margin` of the size.
 */
export function scanBorders(gray, width, height, { maxShare = 0.12, margin = 0.025, flat = 22, far = 70 } = {}) {
  const row = (y) => { let s = 0, q = 0; for (let x = 0; x < width; x++) { const v = gray[y * width + x]; s += v; q += v * v; } const m = s / width; return [m, Math.sqrt(Math.max(0, q / width - m * m))]; };
  const col = (x) => { let s = 0, q = 0; for (let y = 0; y < height; y++) { const v = gray[y * width + x]; s += v; q += v * v; } const m = s / height; return [m, Math.sqrt(Math.max(0, q / height - m * m))]; };
  // The picture's own brightness: the median of the middle half of the rows.
  const mids = [];
  for (let y = Math.floor(height / 4); y < Math.floor((3 * height) / 4); y++) mids.push(row(y)[0]);
  mids.sort((a, b) => a - b);
  const ref = mids[Math.floor(mids.length / 2)] ?? 128;
  const picture = ([m, sd]) => sd > flat && Math.abs(m - ref) < far;
  const edge = (line, size) => {
    const limit = Math.floor(size * maxShare);
    for (let i = 0; i < limit; i++) {
      let ok = true;
      for (let j = i; j < Math.min(limit, i + 8); j++) if (!picture(line(j))) { ok = false; break; }
      if (ok) return i;
    }
    return 0;
  };
  const extra = (size) => Math.round(size * margin);
  return {
    top: edge((i) => row(i), height) + extra(height),
    bottom: edge((i) => row(height - 1 - i), height) + extra(height),
    left: edge((i) => col(i), width) + extra(width),
    right: edge((i) => col(width - 1 - i), width) + extra(width),
  };
}
