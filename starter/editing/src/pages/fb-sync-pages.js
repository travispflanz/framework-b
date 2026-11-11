// Brings pages added to the site's files after the editor's first sign-in into EmDash, so every page stays editable.
// The Worker's hourly scheduled run calls it (editing/src/worker.js); from outside, the Worker answers 404 here.
// It applies the bundled seed (seed/seed.json: the section library and every src/content page) the way EmDash's setup
// wizard does, with onConflict "skip": a page EmDash already has, or has in its trash, is never touched, so an
// editor's work always wins, and a page added to the files appears in the admin within the hour. A new section type
// in the seed is added the same way; a changed one is not (see "Evolving a deployed site" in EmDash's docs).
export const prerender = false;
import { getDb } from "emdash/runtime";
import { applySeed, loadUserSeed } from "emdash/seed";

export async function POST() {
  const seed = await loadUserSeed();
  if (!seed) return Response.json({ ok: false, error: "no seed" }, { status: 500 });
  try {
    const result = await applySeed(await getDb(), seed, { includeContent: true, onConflict: "skip", skipMediaDownload: true });
    return Response.json({ ok: true, content: result.content, blockTypes: result.blockTypes });
  } catch (e) {
    return Response.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
