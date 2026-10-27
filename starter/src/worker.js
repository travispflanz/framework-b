// The site's Worker: the vendored core runtime, configured by site.config.json. Nothing else goes here.
// DripWorkflow is idle unless site.config.json has "drips" and wrangler.jsonc binds it (see AGENTS.md).
import config from "../site.config.json";
import { createWorker, dripWorkflow } from "../core/src/index.js";

export const DripWorkflow = dripWorkflow(config);
export default createWorker(config);
