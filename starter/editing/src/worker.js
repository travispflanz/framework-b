// The site's Worker with client editing on. Core routes come first (/api/*, /admin, /u); everything else,
// including the pages and /_emdash, goes to the Astro/EmDash handler. The scheduled handler runs EmDash's
// maintenance and scheduled publishing, hourly (wrangler.jsonc triggers.crons must match), then brings pages added
// to the site's files into EmDash (src/pages/fb-sync-pages.js), so every page stays editable.
import emdashHandler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import config from "../site.config.json";
import { createWorker, dripWorkflow } from "../core/src/index.js";

export { PluginBridge };
export const DripWorkflow = dripWorkflow(config); // idle unless "drips" is configured and bound

const EMDASH_CRON = "17 * * * *"; // module exports must be handlers, so this stays private
const SYNC_PATH = "/fb-sync-pages"; // reached only from the scheduled handler below

const core = createWorker(config, { fallback: (request, env, ctx) => emdashHandler.fetch(request, env, ctx) });
const emdashScheduled = createScheduledHandler({ generalCron: EMDASH_CRON });

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.replace(/\/$/, "") === SYNC_PATH) return new Response("Not found", { status: 404 });
    return core.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    await emdashScheduled(controller, env, ctx);
    if (controller.cron !== EMDASH_CRON) return;
    const res = await emdashHandler.fetch(new Request(`https://${config.site.canonicalHost}${SYNC_PATH}`, { method: "POST" }), env, ctx);
    const body = await res.text();
    if (res.ok) console.log(`pages sync: ${body}`);
    else console.error(`pages sync failed (${res.status}): ${body.slice(0, 500)}`);
  },
};
