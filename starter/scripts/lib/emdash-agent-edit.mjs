// What an agent does to a page through EmDash's own API, checked against the rendered site at every step: create a
// draft page, publish it, change its hero headline as a draft, publish again, read it back through MCP, then trash
// it. The page is the check's own (slug fb-agent-check-<run>), so no page anyone else uses changes.
// Framework B's docs/research/2026-11-20-agent-editing.md has the plan (roadmap 3d, stage B).
//
// Used twice, with the same code:
// - scripts/test/editing-agent-api.mjs, on the local Worker with the real EmDash (CI), with only the agent's token;
// - Framework B's scripts/site/agent-edit-check.mjs, on a deployed preview behind Cloudflare Access, with the token and
//   a service token's headers (`access`), which are sent with every request, to the site's own origin only.
//
// The agent's token (an EmDash API token, scripts/lib/emdash-agent.mjs) needs content:read and content:write, and its
// user must be an Editor (or a Contributor, who may create and publish its own pages). Nothing here prints a token.
//
// EmDash 1.3.1's routes (read in its npm package on 2026-11-21; editing/packages.json pins the version):
// - POST /_emdash/api/content/pages with { slug, data }: 201, a draft (src/api/schemas/content.ts contentCreateBody).
// - POST /_emdash/api/content/pages/<id>/publish, optionally with { _rev }.
// - PUT /_emdash/api/content/pages/<id> with { data, _rev }: a change to a published page is kept as a draft.
// - DELETE /_emdash/api/content/pages/<id>: moves the page to the trash (it sets deleted_at); emptying the trash needs
//   an Admin. Publishing and trashing purge the page's cache tags (invalidateRouteCache).
// - POST /_emdash/api/mcp: JSON-RPC over Streamable HTTP, Bearer tokens only.
// A page EmDash has but the files don't is served at /<slug> (src/pages/[page].astro); a draft or a trashed page is not.

export const CHECK_SLUG_PREFIX = "fb-agent-check-";

/** The check page's slug and its two headlines, for a run id. */
export function checkPage(run) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(String(run))) throw new Error(`run id "${run}": use 1 to 48 lowercase letters, digits and hyphens`);
  return { slug: `${CHECK_SLUG_PREFIX}${run}`, first: `Agent check A ${run}`, second: `Agent check B ${run}` };
}

const hero = (headline) => ({ _type: "fb_hero", _key: "hero", _version: 1, headline, subheadline: "A page an automated check made through EmDash's API. It is moved to the trash when the check ends." });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the edit and returns its steps ({ step, detail }). Throws on the first step that fails, with the steps so far
 * on `error.steps`. `base` is the site's origin; `token` the agent's raw API token; `access` the headers that get a
 * request past Cloudflare Access (none on the local Worker); `settleMs` how long the rendered page may take to follow
 * a publish or a trash (Workers Cache is purged by EmDash; a first response from the cache is retried).
 */
export async function agentEdit({ base, token, run, access = {}, settleMs = 30_000, everyMs = 2000, onStep = () => {} }) {
  const origin = new URL(base).origin;
  const { slug, first, second } = checkPage(run);
  const steps = [];
  const done = (step, detail) => {
    steps.push({ step, detail });
    onStep(step, detail);
  };
  const fail = (message) => Object.assign(new Error(message), { steps });

  const api = async (path, init = {}) => {
    const t0 = Date.now();
    const r = await fetch(`${origin}/_emdash/api${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { ...access, Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    });
    const text = await r.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: r.status, body, text, ms: Date.now() - t0, location: r.headers.get("location"), type: r.headers.get("content-type") || "" };
  };
  const expect = (what, res, status) => {
    if (res.status !== status) {
      const why = res.body?.error ? `${res.body.error.code}: ${res.body.error.message}` : res.location ? `redirect to ${res.location.split("?")[0]}` : res.text.slice(0, 200);
      throw fail(`${what}: HTTP ${res.status}, expected ${status} (${why})`);
    }
    return res;
  };
  // The rendered page, as a visitor sees it (through Access on a preview). Waits until `want` holds, up to settleMs.
  const page = async (what, want) => {
    const t0 = Date.now();
    let last = null;
    for (;;) {
      const r = await fetch(`${origin}/${slug}`, { headers: access, redirect: "manual", signal: AbortSignal.timeout(60_000) }).catch((e) => ({ status: 0, error: e }));
      last = { status: r.status, html: r.text ? await r.text() : "", location: r.headers?.get?.("location") };
      if (want(last)) return { ...last, ms: Date.now() - t0 };
      if (Date.now() - t0 > settleMs) throw fail(`${what}: after ${Math.round(settleMs / 1000)} s /${slug} still answers HTTP ${last.status}${last.location ? ` (to ${last.location.split("?")[0]})` : ""}`);
      await sleep(everyMs);
    }
  };
  const shows = (headline) => (p) => p.status === 200 && p.html.includes(headline);
  const missing = (p) => p.status === 404;

  // 1. A new page, as a draft.
  const created = expect("create the check page", await api("/content/pages", { method: "POST", body: JSON.stringify({ slug, data: { title: `Agent check ${run}`, sections: [hero(first)] } }) }), 201);
  const id = created.body?.data?.item?.id;
  if (!id) throw fail(`create the check page: no item id in ${created.text.slice(0, 200)}`);
  if (created.body.data.item.status !== "draft") throw fail(`create the check page: status ${created.body.data.item.status}, expected draft`);
  done("create", `POST /content/pages: 201, a draft (${created.ms} ms)`);
  const draft = await page("a draft is not on the site", missing);
  done("draft hidden", `/${slug}: HTTP ${draft.status}`);

  // 2. Publish it: the page is on the site.
  const pub1 = expect("publish the check page", await api(`/content/pages/${id}/publish`, { method: "POST", body: "{}" }), 200);
  const shown1 = await page("the published page shows its headline", shows(first));
  done("publish", `POST …/publish: 200 (${pub1.ms} ms); /${slug} shows "${first}" after ${shown1.ms} ms`);

  // 3. Change the headline as a draft: the site keeps the published one.
  const got = expect("read the check page", await api(`/content/pages/${id}`), 200);
  const rev = got.body?.data?._rev;
  const sections = structuredClone(got.body?.data?.item?.data?.sections || []);
  if (!rev || sections[0]?.headline !== first) throw fail(`read the check page: no _rev, or the headline isn't "${first}"`);
  sections[0].headline = second;
  const put = expect("change the headline", await api(`/content/pages/${id}`, { method: "PUT", body: JSON.stringify({ data: { sections }, _rev: rev }) }), 200);
  if (!put.body?.data?.item?.draftRevisionId) throw fail("change the headline: EmDash kept no draft revision");
  const still = await page("the site keeps the published headline while the change is a draft", shows(first));
  if (still.html.includes(second)) throw fail("the draft headline is already on the site");
  done("draft", `GET (a _rev), then PUT: 200, kept as a draft (${put.ms} ms); /${slug} still shows "${first}"`);

  // 4. Publish the change: the site shows it.
  const pub2 = expect("publish the change", await api(`/content/pages/${id}/publish`, { method: "POST", body: JSON.stringify({ _rev: put.body.data._rev }) }), 200);
  const shown2 = await page("the site shows the published change", shows(second));
  done("publish change", `POST …/publish: 200 (${pub2.ms} ms); /${slug} shows "${second}" after ${shown2.ms} ms`);

  // 5. MCP reads the same page with the same credentials.
  const call = await api("/mcp", { method: "POST", headers: { Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "content_get", arguments: { collection: "pages", id } } }) });
  expect("MCP content_get", call, 200);
  const message = call.type.includes("text/event-stream")
    ? call.text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === 1)
    : call.body;
  const text = (message?.result?.content || []).map((c) => c.text || "").join("");
  if (message?.result?.isError || !text.includes(second)) throw fail(`MCP content_get: no "${second}" in ${JSON.stringify(message).slice(0, 200)}`);
  done("mcp", `tools/call content_get: 200, returns "${second}" (${call.ms} ms)`);

  // 6. Trash it: the page is gone from the site.
  const del = expect("trash the check page", await api(`/content/pages/${id}`, { method: "DELETE" }), 200);
  const gone = await page("a trashed page is not on the site", missing);
  done("trash", `DELETE: 200 (${del.ms} ms); /${slug} answers HTTP ${gone.status} after ${gone.ms} ms`);
  return { id, slug, steps };
}
