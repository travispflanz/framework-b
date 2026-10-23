// The site's Worker: the vendored core runtime, configured by site.config.json. Nothing else goes here.
import config from "../site.config.json";
import { createWorker } from "../core/src/index.js";

export default createWorker(config);
