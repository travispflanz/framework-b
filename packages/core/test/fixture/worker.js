import config from "./site.config.json";
import dripsConfig from "./drips.config.json";
import { createWorker, dripWorkflow } from "../../src/index.js";
// The drips Workflow runs with a launch-mode config (drips are launch only); the main Worker stays an idea site.
export const DripWorkflow = dripWorkflow(dripsConfig);
export default createWorker(config);
