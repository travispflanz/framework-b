// Where the starter's unit tests are running: in Framework B's own starter, or in a site made from it.
// A site has framework.lock.json at its root (written by scripts/site/create.mjs and by every update; a site made by
// hand, an adopted one for example, gets it from its first update); the starter never does. A test that checks one of
// the starter's own templates (site.config.json, design/research.md, STYLE-GUIDE.md, PRODUCT.md) as the starter ships it passes
// `{ skip: STARTER_ONLY }`: in a site those files are the owner's, so the check means nothing there. Everything else
// in such a test runs on the test's own fixture, in both places.
import { existsSync } from "node:fs";

export const inSite = existsSync(new URL("../../framework.lock.json", import.meta.url));
export const STARTER_ONLY = inSite && "checks the starter's own template; in a site that file is the owner's";
