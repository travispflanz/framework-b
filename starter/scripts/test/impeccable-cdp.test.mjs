// Proves the QA gate's rendered-page Impeccable scan isn't vacuous: a page with known AI-design tells, open in a
// browser, scanned through --cdp the way qa.mjs does it, must come back with findings (exit 2); a plain page
// must come back clean (exit 0).
//   node --test scripts/test/impeccable-cdp.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { launchBrowser } from "../lib/local-site.mjs";

const PORT = 9337;
const BAD = `<!doctype html><html lang="en"><head><title>Bad</title><style>
  h1{background:linear-gradient(90deg,#7c3aed,#06b6d4);-webkit-background-clip:text;color:transparent}
  .card{border-left:4px solid #7c3aed;border-radius:12px;padding:16px}
</style></head><body><main><h1>Unlock the future</h1><div class="card">Card</div></main></body></html>`;
const PLAIN = `<!doctype html><html lang="en"><head><title>Plain</title><style>
  body{font:18px/1.6 Georgia,serif;color:#1d1d1b;background:#fbfaf7;max-width:40rem;margin:4rem auto;padding:0 1rem}
</style></head><body><main><h1>Plain page</h1><p>Some ordinary text on an ordinary page.</p></main></body></html>`;

const scan = (marker) => new Promise((done) => {
  const child = spawn("node_modules/.bin/impeccable", ["detect", "--json", "--no-config", "--cdp", String(PORT), "--target", marker], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("close", (status) => done({ status, findings: JSON.parse(out || "[]") }));
});

test("the --cdp scan finds the tells on a bad page and nothing on a plain one", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url.startsWith("/bad") ? BAD : PLAIN);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser({ args: [`--remote-debugging-port=${PORT}`] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(`${base}/bad#scan-bad`);
    const bad = await scan("scan-bad");
    assert.equal(bad.status, 2, "findings on the bad page");
    const rules = bad.findings.map((f) => f.antipattern);
    assert.ok(rules.includes("side-tab"), `side-tab among ${rules.join(", ")}`);
    await page.goto(`${base}/plain#scan-plain`);
    const plain = await scan("scan-plain");
    assert.equal(plain.status, 0, `plain page clean, got ${plain.findings.map((f) => f.antipattern).join(", ")}`);
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
});
