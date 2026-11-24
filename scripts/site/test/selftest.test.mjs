// The self-test's own pieces (scripts/site/lib/selftest.mjs): only a self-test site gets the bigger upload cap, and the
// rate limit probe passes on a 429, fails when nothing is limited, and is inconclusive otherwise. The probe runs
// against a local HTTP server that answers like core's submit endpoint (packages/core/src/forms.js).
//   node --test scripts/site/test/selftest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { SELFTEST_UPLOAD_MAX_BYTES, isSelftestSite, probeRateLimit, sameWording, selftestConsent, selftestUploads } from "../lib/selftest.mjs";

const starterConfig = () => JSON.parse(readFileSync(new URL("../../../starter/site.config.json", import.meta.url), "utf8"));

test("only a selftest-* site on Turnstile test keys is a self-test site", () => {
  assert.equal(isSelftestSite("selftest-123-st", "test"), true);
  assert.equal(isSelftestSite("selftest-123-st", "real"), false);
  assert.equal(isSelftestSite("example-co", "test"), false);
  assert.equal(isSelftestSite("my-selftest-site", "test"), false);
});

test("the static leg runs the consent box; the client-editing leg keeps the mode it was created with", () => {
  const stat = starterConfig();
  assert.equal(selftestConsent(stat, { editing: false }), "checkbox");
  assert.equal(stat.optIn.mode, "checkbox");
  const ed = starterConfig();
  const before = JSON.stringify(ed.optIn);
  assert.equal(selftestConsent(ed, { editing: true }), ed.optIn?.mode || "auto");
  assert.equal(JSON.stringify(ed.optIn), before);
  const kept = { optIn: { mode: "auto", label: "Keep me posted." } };
  selftestConsent(kept, { editing: false });
  assert.deepEqual(kept.optIn, { mode: "checkbox", label: "Keep me posted." });
});

test("stored consent wording matches the label's text: markup taken out, spaces collapsed, empty never matches", () => {
  assert.equal(sameWording("Email me occasional news. Unsubscribe anytime.", "Email me occasional news. Unsubscribe anytime."), true);
  assert.equal(sameWording("Email me **occasional** news. See [our privacy page](/privacy).", "Email me occasional news.  See our privacy page."), true);
  assert.equal(sameWording("Send me the ==newsletter==, *monthly*.", "Send me the newsletter, monthly."), true);
  assert.equal(sameWording("", ""), false);
  assert.equal(sameWording(null, "Email me occasional news."), false);
  assert.equal(sameWording("You'll get occasional emails from us.", "Email me occasional news."), false);
});

test("a self-test site's file fields take 20 MB, and the hint says so; forms without a file stay without one", () => {
  const config = starterConfig();
  config.forms.note = { fields: [{ name: "email", type: "email", label: "Email", required: true }] };
  selftestUploads(config);
  assert.equal(SELFTEST_UPLOAD_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(config.forms.contact.file.maxBytes, SELFTEST_UPLOAD_MAX_BYTES);
  assert.match(config.forms.contact.file.hint, /up to 20 MB\.$/);
  assert.equal(config.forms.note.file, undefined);
  // Every other site keeps the starter's form as it is (core's default cap, 10 MB).
  assert.equal(starterConfig().forms.contact.file.maxBytes, undefined);
});

// A stand-in for the live submit endpoint: answers 403 turnstile_missing until `limitAfter` posts, then 429.
async function endpoint({ limitAfter = Infinity, answer } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, origin: req.headers.origin, body });
      const [status, error] = answer ? answer(seen.length) : seen.length > limitAfter ? [429, "rate_limited"] : [403, "turnstile_missing"];
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

test("the probe passes on the first 429, after the posts the limiter let through", async () => {
  const site = await endpoint({ limitAfter: 5 });
  const r = await probeRateLimit({ url: site.url, form: "contact", gapMs: 0 });
  await site.close();
  assert.equal(r.result, "pass");
  assert.equal(r.limitedAt, 6);
  assert.equal(r.allowed, 5);
  assert.equal(site.seen.length, 6); // stops at the first 429
  // Each post is same-origin, to the form's endpoint, with no Turnstile token, so the live site stores nothing.
  for (const s of site.seen) assert.deepEqual(s, { method: "POST", url: "/api/submit/contact", origin: site.url, body: "{}" });
});

test("the probe still passes when the limit lets a burst run over it", async () => {
  const site = await endpoint({ limitAfter: 17 });
  const r = await probeRateLimit({ url: site.url, form: "contact", gapMs: 0 });
  await site.close();
  assert.equal(r.result, "pass");
  assert.equal(r.limitedAt, 18);
});

test("the probe fails when every post within one period gets past the limiter, and sends no more than its cap", async () => {
  const site = await endpoint();
  const r = await probeRateLimit({ url: site.url, form: "contact", gapMs: 0 });
  await site.close();
  assert.equal(r.result, "fail");
  assert.equal(r.sent, 40); // eight times the limit of 5
  assert.equal(site.seen.length, 40);
  assert.match(r.detail, /all 40 posts got past the limiter/);
});

test("the probe is inconclusive on answers that never reached the limiter check, or on a burst slower than a period", async () => {
  let site = await endpoint({ answer: () => [500, "upload_failed"] });
  let r = await probeRateLimit({ url: site.url, form: "contact", attempts: 6, gapMs: 0 });
  await site.close();
  assert.equal(r.result, "inconclusive");
  assert.match(r.answers, /500 upload_failed ×6/);

  // A 429 that isn't core's (no rate_limited code) does not count as the limiter answering.
  site = await endpoint({ answer: () => [429, ""] });
  r = await probeRateLimit({ url: site.url, form: "contact", attempts: 3, gapMs: 0 });
  await site.close();
  assert.equal(r.result, "inconclusive");

  site = await endpoint();
  let calls = 0; // the probe reads the clock when it starts and when it ends: 61 s apart here
  r = await probeRateLimit({ url: site.url, form: "contact", attempts: 4, gapMs: 0, now: () => (calls++ ? 61000 : 0) });
  await site.close();
  assert.equal(r.result, "inconclusive");
  assert.match(r.detail, /longer than one 60 s period/);
});

test("the probe reports a network failure as inconclusive, not as a pass or a fail", async () => {
  const site = await endpoint();
  await site.close(); // nothing listens on the port any more
  const r = await probeRateLimit({ url: site.url, form: "contact", attempts: 2, gapMs: 0 });
  assert.equal(r.result, "inconclusive");
  assert.match(r.answers, /no answer network error ×2/);
});
