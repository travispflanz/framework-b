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

// Every published EmDash page as src/content/<slug>.json, from an `emdash export-seed` file.
//   seed:    the export (content.pages[] with { slug, status, data: { title, sections } })
//   current: the site's pages now, { <slug>: <src/content/<slug>.json> } (a page EmDash doesn't publish stays as it is)
//   media:   rows of EmDash's media table ({ id, filename, mime_type, alt, storage_key })
//   taken:   file names already in src/assets/images
// Returns { pages: { <slug>: page }, images: [{ storageKey, file, alt, id }], notes: [], changed: [<slug>] }. A page
// keeps its file's description, noindex and anything else EmDash doesn't hold; a page an editor created gets a new
// file (and a note: it isn't in the navigation). EmDash media in any section field (an object with the id of a media
// row) becomes a file in src/assets/images; the caller copies each storageKey to its file.
export function pagesFromExport(seed, current, media = [], taken = []) {
  const notes = [];
  const published = (seed?.content?.pages || []).filter((p) => p.slug && (p.status || "published") === "published");
  if (!published.some((p) => p.slug === "home")) notes.push("EmDash has no published home page, so src/content/home.json stays as it is (it is what the site was showing)");
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
    // A focal point an editor set (or the site set before editing) carries back to the file.
    const focal = Object.fromEntries(["focalX", "focalY"].filter((k) => typeof value[k] === "number").map((k) => [k, value[k]]));
    // The site's own files, seeded as external media values (scripts/editing.mjs): back to { src: "<file>" }.
    if (value.provider === "external" && typeof value.id === "string" && value.id.startsWith("local:")) {
      return { src: value.id.slice(6), alt: value.alt || "", ...focal };
    }
    if (typeof value.id === "string" && (value.provider ?? "local") === "local" && byId.has(value.id)) {
      const row = byId.get(value.id);
      if (!fromRow.has(row.id)) {
        const file = fileFor(row);
        fromRow.set(row.id, file);
        images.push({ id: row.id, storageKey: row.storage_key, file, alt: value.alt || row.alt || "" });
      }
      return { src: fromRow.get(row.id), alt: value.alt || row.alt || "", ...focal };
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
  const pages = structuredClone(current || {});
  const changed = [];
  for (const entry of published) {
    const slug = entry.slug;
    const before = current?.[slug];
    const sections = walk(entry.data?.sections || [], `${slug}.sections`);
    // The home page's title "Home" is EmDash's label for it; the file keeps its own title (or none).
    const title = slug === "home" && entry.data?.title === "Home" ? before?.title : entry.data?.title || before?.title;
    const page = { ...(before || {}), ...(title ? { title } : {}), sections };
    if (slug === "home" && !title) delete page.title;
    if (!before) notes.push(`/${slug} is a page an editor created: it is now src/content/${slug}.json; add it to "nav" in site.config.json if it belongs in the menu, and give it a description`);
    if (JSON.stringify(page) !== JSON.stringify(before)) {
      pages[slug] = page;
      changed.push(slug);
    }
  }
  return { pages, images, notes, changed };
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
