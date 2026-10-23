// The site's Worker with client editing on. Core routes come first (/api/*, /admin, /u); everything else,
// including the pages and /_emdash, goes to the Astro/EmDash handler. The scheduled handler runs EmDash's
// maintenance and scheduled publishing, hourly (wrangler.jsonc triggers.crons must match).
import emdashHandler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import config from "../site.config.json";
import { createWorker } from "../core/src/index.js";

export { PluginBridge };

const EMDASH_CRON = "17 * * * *"; // module exports must be handlers, so this stays private

const core = createWorker(config, { fallback: (request, env, ctx) => emdashHandler.fetch(request, env, ctx) });

export default {
  fetch: core.fetch,
  scheduled: createScheduledHandler({ generalCron: EMDASH_CRON }),
};
