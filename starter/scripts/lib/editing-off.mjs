// The pure parts of `node scripts/editing.mjs off`: what the site's files become when client editing (EmDash) is
// switched back off. No file or network access here, so scripts/test/editing-off.test.mjs covers it.

// The `export const prerender = true;` line `editing.mjs on` adds to every page it doesn't replace, removed again.
// It adds the line directly after the opening `---` (Astro) or at the top (JS/TS); a page that declares prerender
// anywhere else had it before and keeps it.
export function staticPage(text, name) {
  if (name.endsWith(".astro")) return text.replace(/^---\nexport const prerender = true;\n/, "---\n");
  if (/\.(js|ts)$/.test(name)) return text.replace(/^export const prerender = true;\n/, "");
  return text;
}

// wrangler.jsonc without what `editing.mjs on` and site create added: the CMS_DB, MEDIA and SESSION bindings
// (production and previews), EmDash's cron and the nodejs_compat flag. Assets get the static site's 404 page back.
export function staticWrangler(wrangler, cron) {
  const out = structuredClone(wrangler);
  const drop = (o) => {
    if (!o) return;
    if (o.d1_databases) o.d1_databases = o.d1_databases.filter((d) => d.binding !== "CMS_DB");
    if (o.r2_buckets) o.r2_buckets = o.r2_buckets.filter((b) => b.binding !== "MEDIA");
    if (o.kv_namespaces) {
      o.kv_namespaces = o.kv_namespaces.filter((k) => k.binding !== "SESSION");
      if (!o.kv_namespaces.length) delete o.kv_namespaces;
    }
  };
  drop(out);
  drop(out.previews);
  if (out.triggers?.crons) {
    out.triggers.crons = out.triggers.crons.filter((c) => c !== cron);
    if (!out.triggers.crons.length) delete out.triggers;
  }
  if (out.compatibility_flags) {
    out.compatibility_flags = out.compatibility_flags.filter((f) => f !== "nodejs_compat");
    if (!out.compatibility_flags.length) delete out.compatibility_flags;
  }
  if (out.assets) out.assets = { ...out.assets, not_found_handling: "404-page" };
  return out;
}

// package.json without the EmDash packages and the "emdash" key.
export function staticPackage(pkg, emdashPackages) {
  const out = structuredClone(pkg);
  for (const name of Object.keys(emdashPackages)) delete out.dependencies?.[name];
  delete out.emdash;
  return out;
}

// The resources a site keeps after switching off, for the owner to delete by hand if they want to (nothing is
// deleted automatically: the content database is the only copy of the editors' history).
export function leftovers(wrangler) {
  const all = [wrangler, wrangler.previews].filter(Boolean);
  const list = [];
  for (const o of all) {
    for (const d of o.d1_databases || []) if (d.binding === "CMS_DB") list.push(`D1 database ${d.database_name}`);
    for (const b of o.r2_buckets || []) if (b.binding === "MEDIA") list.push(`R2 bucket ${b.bucket_name}`);
    for (const k of o.kv_namespaces || []) if (k.binding === "SESSION") list.push(`KV namespace ${k.id}`);
  }
  return list;
}

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "image";
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };

// The home page as src/content/home.json from an `emdash export-seed` file.
//   seed:    the export (content.pages[] with { slug, status, data: { title, sections } })
//   current: the site's src/content/home.json now (kept as it is when EmDash has no published home page)
//   media:   rows of EmDash's media table ({ id, filename, mime_type, alt, storage_key })
//   taken:   file names already in src/assets/images
// Returns { home, images: [{ storageKey, file, alt, id }], notes: [] }. EmDash media in any section field (an object
// with the id of a media row) becomes a file in src/assets/images; the caller copies each storageKey to its file.
export function homeFromExport(seed, current, media = [], taken = []) {
  const notes = [];
  const pages = seed?.content?.pages || [];
  const page = pages.find((p) => p.slug === "home" && (p.status || "published") === "published");
  for (const p of pages) if (p.slug !== "home") notes.push(`EmDash page "${p.slug}" isn't exported: with editing on, only the home page was served from EmDash`);
  if (!page) {
    notes.push("EmDash has no published home page, so src/content/home.json stays as it is (it is what the site was showing)");
    return { home: current, images: [], notes, changed: false };
  }
  const byId = new Map(media.map((m) => [m.id, m]));
  const used = new Set(taken);
  const images = [];
  const fileFor = (row) => {
    const ext = EXT[row.mime_type] || (row.filename.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg").toLowerCase();
    let name = `${slugify(row.filename)}.${ext}`;
    for (let i = 2; used.has(name); i++) name = `${slugify(row.filename)}-${i}.${ext}`;
    used.add(name);
    return name;
  };
  const fromRow = new Map();
  const walk = (value, where) => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${where}[${i}]`));
    if (!value || typeof value !== "object") return value;
    if (typeof value.id === "string" && (value.provider ?? "local") === "local" && byId.has(value.id)) {
      const row = byId.get(value.id);
      if (!fromRow.has(row.id)) {
        const file = fileFor(row);
        fromRow.set(row.id, file);
        images.push({ id: row.id, storageKey: row.storage_key, file, alt: value.alt || row.alt || "" });
      }
      return { src: fromRow.get(row.id), alt: value.alt || row.alt || "" };
    }
    if (typeof value.id === "string" && typeof value.src === "string" && /^https?:\/\//.test(value.src)) {
      notes.push(`${where}: image from ${value.provider || "an external provider"} kept as its URL (${value.src})`);
      return { src: value.src, alt: value.alt || "" };
    }
    if (typeof value.id === "string" && ("provider" in value || "mimeType" in value || "previewUrl" in value)) {
      notes.push(`${where}: image ${value.id} isn't in the media library export and was left out`);
      return undefined;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "_version") continue;
      const w = walk(v, `${where}.${k}`);
      if (w !== undefined) out[k] = w;
    }
    return out;
  };
  const sections = walk(page.data?.sections || [], "sections");
  const home = { ...current, title: page.data?.title || current.title, sections };
  return { home, images, notes, changed: JSON.stringify(home) !== JSON.stringify(current) };
}

// design/credits.json with an entry for each image brought over from EmDash's media library.
export function creditsWith(credits, images) {
  const out = structuredClone(credits || { images: [] });
  out.images = out.images || [];
  for (const img of images) {
    const file = `src/assets/images/${img.file}`;
    if (out.images.some((c) => c.file === file)) continue;
    out.images.push({ file, source: "owner", alt: img.alt, note: `Uploaded by an editor in client editing (EmDash media ${img.id}); confirm the source` });
  }
  return out;
}
