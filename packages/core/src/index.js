// Framework B core runtime. A site's Worker is:
//
//   import config from "../site.config.json";
//   import { createWorker, dripWorkflow } from "../core/src/index.js";
//   export const DripWorkflow = dripWorkflow(config); // drips (src/drips.js); idle unless configured
//   export default createWorker(config);
//
// Routes: POST /api/submit/:form, PUT /api/upload/:lead, GET /api/health, GET|POST /u, GET /admin/*.
// Everything else is served from static assets (env.ASSETS), or, with client editing on, by the
// `fallback` handler (the Astro/EmDash server): createWorker(config, { fallback }).

import { loadConfig } from "./config.js";
import { handleSubmit, handleUpload } from "./forms.js";
import { handleUnsubscribe } from "./unsubscribe.js";
import { handleAdmin } from "./admin.js";
import { dripWorkflowClass } from "./drips.js";
import { json } from "./lib/util.js";

export const CORE_VERSION = "0.5.0";

// The drips Workflow class for this site: `export const DripWorkflow = dripWorkflow(config);` in the site's Worker.
// It does nothing until site.config.json has a "drips" block and wrangler.jsonc binds it as DRIPS.
export function dripWorkflow(rawConfig) {
  return dripWorkflowClass(loadConfig(rawConfig));
}

export function createWorker(rawConfig, { fallback } = {}) {
  const config = loadConfig(rawConfig);

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;

      try {
        if (path === "/api/health") {
          const row = await env.DB.prepare("SELECT 1 AS ok").first();
          return json({ ok: row?.ok === 1, site: config.site.id, core: CORE_VERSION });
        }

        const submit = path.match(/^\/api\/submit\/([a-z][a-z0-9-]{0,31})$/);
        if (submit) {
          if (request.method !== "POST") return json({ ok: false, error: "method" }, 405, { allow: "POST" });
          return await handleSubmit(request, env, ctx, config, submit[1]);
        }

        const upload = path.match(/^\/api\/upload\/([^/]+)$/);
        if (upload) {
          if (request.method !== "PUT") return json({ ok: false, error: "method" }, 405, { allow: "PUT" });
          return await handleUpload(request, env, config, upload[1]);
        }

        // QR codes and campaign links: redirect, keeping the query string (attribution is read on the landing page).
        if (path === "/go" || path === "/go/") {
          const to = new URL(config.go.to, url);
          to.search = url.search;
          return new Response(null, { status: 302, headers: { location: to.pathname + to.search, "cache-control": "no-store" } });
        }

        if (path === "/u") {
          if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
          return await handleUnsubscribe(request, env, config);
        }

        if (path === "/admin" || path.startsWith("/admin/")) return await handleAdmin(request, env, config);

        if (path.startsWith("/api/")) return json({ ok: false, error: "not_found" }, 404);
      } catch (e) {
        console.error("core", path, e);
        return json({ ok: false, error: "server_error" }, 500);
      }

      return serveAsset(request, env, config, url, fallback ? () => fallback(request, env, ctx) : null);
    },
  };
}

async function serveAsset(request, env, config, url, fallback) {
  const res = fallback ? await fallback() : await env.ASSETS.fetch(request);
  // noindex when the site chose not to be indexed (idea default) and on any non-canonical host
  // (workers.dev twin of a launch site, preview URLs).
  if (!config.site.indexing || url.host !== config.site.canonicalHost) {
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex");
    return out;
  }
  return res;
}
