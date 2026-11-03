// Library of Congress photos for scripts/images.mjs: the pure parts (record reading, rights, file choice), unit-tested.
//
// The loc.gov JSON API: append fo=json to a search or item URL; at=results trims a search, at=item,resources gives an
// item's metadata and files. It allows 20 requests a minute and blocks an address for an hour above that; images and
// /storage-services/ files allow 150 a minute (loc.gov/apis/json-and-yaml/working-within-limits/, checked 2026-11-03).
// So images.mjs waits 3.1 s between API calls and 0.5 s between image downloads.

export const LOC_API_GAP_MS = 3100;
export const LOC_FILE_GAP_MS = 500;

/** Only photographs whose record says there are no known restrictions on publication are used. */
export function isFree(rights) {
  return /^\s*no known restrictions\b/i.test(Array.isArray(rights) ? rights.join(" ") : String(rights || ""));
}

/** The rights statement of a search result or an item record, as one string. */
export function rightsOf(record) {
  const r = record?.rights_advisory ?? record?.item?.rights_advisory ?? record?.rights ?? "";
  return Array.isArray(r) ? r.join(" ") : String(r || "");
}

/** "2014706018" from "http://www.loc.gov/item/2014706018/" (or the id itself). */
export function locId(idOrUrl) {
  const m = String(idOrUrl).match(/\/item\/([^/?#]+)/);
  return (m ? m[1] : String(idOrUrl)).replace(/^loc:/, "").replace(/\/$/, "");
}

/**
 * The file to download from an item's `resources`: the master TIFF when there is one (LoC's JPEG copies stop at
 * about 1024 px), else the largest JPEG. Returns { url, width, height, master } or null.
 */
export function pickFile(resources) {
  const files = (resources || []).flatMap((r) => (r.files || []).flat()).filter((f) => f && f.url);
  const tif = files.filter((f) => f.mimetype === "image/tiff");
  // "u" is the uncompressed master; "a" an archival master (both full size). Prefer the smaller download: u, then a.
  const master = tif.find((f) => /u\.tif$/i.test(f.url)) || tif.find((f) => /a\.tif$/i.test(f.url)) || tif[0];
  if (master) return { url: master.url, width: master.width || 0, height: master.height || 0, master: true };
  const jpgs = files.filter((f) => f.mimetype === "image/jpeg").sort((a, b) => (b.width || 0) - (a.width || 0));
  return jpgs[0] ? { url: jpgs[0].url, width: jpgs[0].width || 0, height: jpgs[0].height || 0, master: false } : null;
}

/** A search result, reduced to what the candidate list and contact sheet need (null if not usable). */
export function candidate(x) {
  const rights = rightsOf(x);
  const thumbs = (x.image_url || []).filter((u) => /\.(jpe?g|gif)(#|$)|default\.jpg/i.test(u));
  if (!isFree(rights) || !thumbs.length) return null;
  return { id: `loc:${locId(x.id)}`, title: x.title || "", date: x.date || "", rights: rights.slice(0, 160), landing: x.id, thumbnail: thumbs[Math.min(1, thumbs.length - 1)].split("#")[0] };
}
