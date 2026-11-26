// One retry for a QA run's network failures (scripts/lib/qa-retry.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { gotoWithRetry, isTransientLoadError, transientAudits } from "../lib/qa-retry.mjs";

const timeout = Object.assign(new Error('page.goto: Timeout 30000ms exceeded.\nwaiting for navigation until "load"'), { name: "TimeoutError" });

test("a page load that timed out is loaded once more, and the retry is reported", async () => {
  const calls = [];
  const notes = [];
  const flaky = { goto: async (url) => { calls.push(url); if (calls.length === 1) throw timeout; return { ok: () => true }; } };
  const res = await gotoWithRetry(flaky, "http://localhost/contact", { waitUntil: "load" }, (n) => notes.push(n));
  assert.equal(res.ok(), true);
  assert.equal(calls.length, 2);
  assert.match(notes[0], /\/contact: page.goto: Timeout 30000ms exceeded\.; loading it once more/);
  // Twice in a row still fails, and any other error isn't retried.
  const dead = { goto: async () => { throw timeout; } };
  await assert.rejects(gotoWithRetry(dead, "http://localhost/", {}), /Timeout/);
  let n = 0;
  const broken = { goto: async () => { n++; throw new Error("Cannot navigate to invalid URL"); } };
  await assert.rejects(gotoWithRetry(broken, "nope", {}), /invalid URL/);
  assert.equal(n, 1);
  assert.ok(isTransientLoadError(new Error("page.goto: net::ERR_CONNECTION_RESET at https://example.com/")));
});

test("a Lighthouse run is redone only when a fetch failed or the page didn't load", () => {
  const audit = (id, extra) => ({ id, score: 0, scoreDisplayMode: "binary", ...extra });
  assert.deepEqual(transientAudits({ audits: { "robots-txt": audit("robots-txt", { explanation: "Fetch of robots.txt failed" }) } }), ["robots-txt: Fetch of robots.txt failed"]);
  assert.deepEqual(transientAudits({ audits: { "robots-txt": audit("robots-txt", { displayValue: "Request for robots.txt returned HTTP status: 503" }) } }), ["robots-txt: Request for robots.txt returned HTTP status: 503"]);
  assert.deepEqual(transientAudits({ runtimeError: { code: "NO_FCP", message: "The page did not paint any content." }, audits: {} }), ["NO_FCP: The page did not paint any content."]);
  // A real finding (a missing label, a 404 robots.txt marked not applicable, a pass) runs once.
  assert.deepEqual(transientAudits({ audits: { label: audit("label", { explanation: "" }), "robots-txt": { id: "robots-txt", score: 1 }, "is-crawlable": { id: "is-crawlable", score: null, scoreDisplayMode: "notApplicable" } } }), []);
});
