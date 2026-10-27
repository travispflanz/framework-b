// Proves the Access token headers reach only the checked origin: a page on origin A loads a script and an image
// from origin B (standing in for Turnstile or any third party). A must see the headers on every request; B never.
//   node --test scripts/test/access-auth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";
import { accessAuth } from "../lib/access-auth.mjs";
import { launchBrowser } from "../lib/local-site.mjs";

const ENV = { ACCESS_CLIENT_ID: "test-id.access", ACCESS_CLIENT_SECRET: "test-secret" };

function server(handler) {
  const seen = [];
  const s = createServer((req, res) => {
    seen.push({ path: req.url, id: req.headers["cf-access-client-id"], secret: req.headers["cf-access-client-secret"] });
    handler(req, res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r({ s, seen, origin: `http://127.0.0.1:${s.address().port}` })));
}

async function pair() {
  const third = await server((req, res) => {
    res.setHeader("content-type", req.url.endsWith(".js") ? "text/javascript" : "image/svg+xml");
    res.end(req.url.endsWith(".js") ? "window.thirdLoaded = true;" : "<svg xmlns='http://www.w3.org/2000/svg'/>");
  });
  const site = await server((req, res) => {
    if (req.url === "/style.css") return res.setHeader("content-type", "text/css"), res.end("body{margin:0}");
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><html lang="en"><head><title>t</title><link rel="stylesheet" href="/style.css">
      <script src="${third.origin}/widget.js"></script></head><body><img src="${third.origin}/pixel.svg" alt=""></body></html>`);
  });
  return { site, third, close: () => { for (const x of [site.s, third.s]) { x.closeAllConnections(); x.close(); } } };
}

const assertScoped = (site, third) => {
  assert.ok(site.seen.length >= 2, "the site served the page and its stylesheet");
  for (const r of site.seen) assert.deepEqual([r.id, r.secret], [ENV.ACCESS_CLIENT_ID, ENV.ACCESS_CLIENT_SECRET], `site request ${r.path} carries the headers`);
  assert.ok(third.seen.length >= 2, "the third party served the script and the image");
  for (const r of third.seen) assert.deepEqual([r.id, r.secret], [undefined, undefined], `third-party request ${r.path} has no headers`);
};

test("fetch adds the headers to the base origin only", async () => {
  const { site, third, close } = await pair();
  const auth = accessAuth(site.origin, ENV);
  await auth.fetch(`${site.origin}/`);
  await auth.fetch(`${site.origin}/style.css`);
  await auth.fetch(`${third.origin}/widget.js`);
  await auth.fetch(`${third.origin}/pixel.svg`);
  assertScoped(site, third);
  close();
});

test("Playwright: same-origin requests carry the headers, third-party requests don't", async () => {
  const { site, third, close } = await pair();
  const auth = accessAuth(site.origin, ENV);
  const browser = await launchBrowser();
  const context = await browser.newContext();
  await auth.playwright(context);
  const page = await context.newPage();
  await page.goto(`${site.origin}/`, { waitUntil: "load" });
  assert.equal(await page.evaluate(() => window.thirdLoaded), true);
  await browser.close();
  assertScoped(site, third);
  close();
});

test("Puppeteer (the page Lighthouse uses): same-origin requests carry the headers, third-party requests don't", async () => {
  const { site, third, close } = await pair();
  const auth = accessAuth(site.origin, ENV);
  // Puppeteer drives the Playwright Chromium build, as QA's Lighthouse run does.
  const { chromium } = await import("playwright");
  const browser = await puppeteer.launch({ executablePath: process.env.PW_CHROMIUM || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await auth.puppeteer(page);
  await page.goto(`${site.origin}/`, { waitUntil: "load" });
  assert.equal(await page.evaluate(() => window.thirdLoaded), true);
  await browser.close();
  assertScoped(site, third);
  close();
});

test("with no token in the environment every helper is a no-op", async () => {
  const auth = accessAuth("http://127.0.0.1:1", {});
  assert.equal(auth.on, false);
});
