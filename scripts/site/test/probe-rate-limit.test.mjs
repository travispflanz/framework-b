// The self-test's rate limit probe (scripts/site/probe-rate-limit.mjs): it only targets a throwaway selftest-* site
// (or a local Worker), reads the limiter's and Turnstile's answers, fails when a post without a token is accepted or
// nothing reached the limiter, and reports (without failing) a burst that was never limited.
//   node --test scripts/site/test/probe-rate-limit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedTarget, classify, sequence, verdict } from "../probe-rate-limit.mjs";

const SCRIPT = fileURLToPath(new URL("../probe-rate-limit.mjs", import.meta.url));

test("only a throwaway self-test site or a local Worker is a target", () => {
  assert.equal(allowedTarget("https://selftest-123-st.acct.workers.dev/"), true);
  assert.equal(allowedTarget("https://selftest-123-st.acct.workers.dev/", "selftest-123-st"), true);
  assert.equal(allowedTarget("https://selftest-123-st.acct.workers.dev/", "selftest-456-st"), false);
  assert.equal(allowedTarget("http://localhost:8799/"), true);
  for (const bad of ["https://example-co.acct.workers.dev/", "https://selftest-1.example.com/", "http://selftest-1.acct.workers.dev/",
    "https://selftest-1.acct.workers.dev.example.com/", "https://www.example.com/", "https://selftest-1.acct.workers.dev/api/", "not a url"]) {
    assert.equal(allowedTarget(bad), false, bad);
  }
});

test("answers are read as let through, limited, accepted or other", () => {
  assert.equal(classify(403, "turnstile_missing"), "passed");
  assert.equal(classify(429, "rate_limited"), "limited");
  assert.equal(classify(200, ""), "accepted");
  assert.equal(classify(403, "origin"), "other");
  assert.equal(classify(0, "network"), "other");
});

const run = (...kinds) => kinds.map((kind) => ({ kind, status: { passed: 403, limited: 429, accepted: 200, other: 500 }[kind], error: kind === "limited" ? "rate_limited" : kind === "passed" ? "turnstile_missing" : "" }));

test("the verdict fails only on an accepted post or a probe that reached nothing, unless a limit is required", () => {
  assert.deepEqual(verdict(run("passed", "passed", "limited")), { counts: { passed: 2, limited: 1, accepted: 0, other: 0 }, firstLimited: 3, fail: null });
  assert.equal(verdict(run("passed", "passed")).fail, null);
  assert.match(verdict(run("passed", "passed"), { requireLimit: true }).fail, /limited none/);
  assert.match(verdict(run("passed", "accepted", "limited")).fail, /accepted/);
  assert.match(verdict(run("other", "other")).fail, /no answer/);
});

test("the answers are summed up in runs", () => {
  assert.equal(sequence(run("passed", "passed", "limited", "limited")), "403 turnstile_missing ×2, 429 rate_limited ×2");
});

// A stand-in for the Worker: the contact page's form, then the limiter (5 posts) in front of Turnstile.
function fakeSite({ limit }) {
  let posts = 0;
  const origins = new Set();
  const server = createServer((req, res) => {
    if (req.method === "GET") return res.end('<form action="/api/submit/contact" data-fb-form="contact"></form>');
    origins.add(req.headers.origin);
    posts++;
    const limited = limit && posts > limit;
    res.writeHead(limited ? 429 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: limited ? "rate_limited" : "turnstile_missing" }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, posts: () => posts, origins })));
}
const probe = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { env: { ...process.env, GITHUB_STEP_SUMMARY: "", GITHUB_ACTIONS: "", ...env } }, (err, stdout) => resolve({ code: err?.code ?? 0, stdout }));
});

test("against a limited site it stops after the third 429 and passes", async () => {
  const site = await fakeSite({ limit: 5 });
  const out = join(mkdtempSync(join(tmpdir(), "probe-")), "probe.json");
  const { code, stdout } = await probe(["--url", site.url, "--out", out]);
  site.server.close();
  assert.equal(code, 0, stdout);
  const report = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(report.firstLimited, 6);
  assert.equal(site.posts(), 8);
  assert.deepEqual([...site.origins], [site.url]);
  assert.match(stdout, /First 429 at post 6/);
});

test("a site that never limits is reported, and fails only with --require-limit", async () => {
  const site = await fakeSite({ limit: 0 });
  const soft = await probe(["--url", site.url, "--max", "8"]);
  const hard = await probe(["--url", site.url, "--max", "8", "--require-limit"]);
  site.server.close();
  assert.equal(soft.code, 0);
  assert.match(soft.stdout, /No 429/);
  assert.equal(hard.code, 1);
});

test("it waits out the leads' period and refuses another site", async () => {
  const site = await fakeSite({ limit: 5 });
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  writeFileSync(join(dir, "lead.json"), JSON.stringify({ sentAt: new Date(Date.now() - 59_000).toISOString() }));
  const t = Date.now();
  const waited = await probe(["--url", site.url, "--after", join(dir, "lead.json"), "--max", "1"]);
  assert.equal(waited.code, 0);
  assert.ok(Date.now() - t >= 1_500, "waited until a period after the lead");
  const refused = await probe(["--url", "https://example-co.acct.workers.dev"]);
  site.server.close();
  assert.equal(refused.code, 1);
  assert.equal(site.posts(), 1);
});
