// The preview URL the preview check and the agent edit check read from a Workers Builds log
// (scripts/site/lib/builds.mjs), and the guards both apply before sending a credential there: the URL is one of the
// Worker's previews, and it is the branch's own Worker Preview, deployed by this build.
//   node --test scripts/site/test/builds.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { branchPreview, branchPreviewMismatch, isPreviewOrigin, previewUrlFrom } from "../lib/builds.mjs";

test("the preview URL is the first \"Preview URL:\" line of the build log", () => {
  const lines = [
    "Installing dependencies",
    "  Preview URL: https://feat-x-example.acct.workers.dev  ",
    "Preview URL: https://later-example.acct.workers.dev",
  ];
  assert.equal(previewUrlFrom(lines), "https://feat-x-example.acct.workers.dev");
  assert.equal(previewUrlFrom(["Preview URL: http://feat-x-example.acct.workers.dev", "Deployed"]), null, "only https");
  assert.equal(previewUrlFrom([]), null);
});

test("credentials go only to this Worker's previews on the account's workers.dev subdomain", () => {
  const ours = { worker: "example", subdomain: "acct" };
  assert.ok(isPreviewOrigin("https://feat-x-example.acct.workers.dev", ours));
  assert.ok(isPreviewOrigin("https://feat-x-example.acct.workers.dev/some/path", ours));
  assert.ok(isPreviewOrigin("https://Feat-X-Example.ACCT.workers.dev", ours), "hosts compare without case");
  for (const url of [
    "https://example.com",
    "http://feat-x-example.acct.workers.dev",
    "https://feat-x-example.acct.workers.dev:8443",
    "https://feat-x-other.acct.workers.dev",
    "https://feat-x-example.someone-else.workers.dev",
    "https://example.acct.workers.dev",
    "https://feat-x-example.acct.workers.dev.example.com",
    "https://evil.feat-x-example.acct.workers.dev",
    "https://user@feat-x-example.acct.workers.dev.example.com",
    "not a url",
  ]) assert.ok(!isPreviewOrigin(url, ours), url);
});

test("a build that prints its own \"Preview URL:\" line first is refused", () => {
  // The branch's `npm run build` runs before `npx wrangler preview` and writes to the same log.
  const lines = ["> npm run build", "Preview URL: https://collector.example.com/", "Preview URL: https://feat-x-example.acct.workers.dev"];
  const found = previewUrlFrom(lines);
  assert.equal(found, "https://collector.example.com/");
  assert.ok(!isPreviewOrigin(found, { worker: "example", subdomain: "acct" }));
});

const BUILD = { created_on: "2026-11-23T07:00:00.000Z" };
const OWN = { name: "feat/x", urls: ["https://feat-x-example.acct.workers.dev"], deployed_on: "2026-11-23T07:01:30.123456Z" };

test("the branch's own Worker Preview, deployed during or after its build, passes", () => {
  const opts = { branch: "feat/x", build: BUILD };
  assert.equal(branchPreviewMismatch("https://feat-x-example.acct.workers.dev/", OWN, opts), null, "a trailing slash is the same origin");
  assert.equal(branchPreviewMismatch("https://Feat-X-Example.acct.workers.dev", OWN, opts), null, "hosts compare without case");
  assert.equal(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", { ...OWN, deployed_on: BUILD.created_on }, opts), null, "deployed the moment the build started");
  assert.equal(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", OWN, { branch: "feat/x", build: { running_on: "2026-11-23T07:00:05Z" } }), null, "running_on when created_on is missing");
});

test("another preview, a stale one or none is refused, with the reason", () => {
  const opts = { branch: "feat/x", build: BUILD };
  assert.match(branchPreviewMismatch("https://main-example.acct.workers.dev", OWN, opts), /main-example\.acct\.workers\.dev isn't the URL of the `feat\/x` Worker Preview \(feat-x-example\.acct\.workers\.dev\)/);
  assert.match(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", { ...OWN, urls: [] }, opts), /\(it lists none\)/);
  assert.match(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", null, opts), /the Worker has no Preview named `feat\/x`/);
  assert.match(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", { ...OWN, deployed_on: "2026-11-23T06:59:59Z" }, opts), /last deployed at 2026-11-23T06:59:59Z, before this build started \(2026-11-23T07:00:00\.000Z\)/);
  assert.match(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", { ...OWN, deployed_on: null }, opts), /last deployed never/);
  assert.match(branchPreviewMismatch("https://feat-x-example.acct.workers.dev", OWN, { branch: "feat/x", build: {} }), /before this build started \(unknown\)/, "no build time: refused, not assumed");
});

test("branchPreview finds the exact name through the API's partial-match filter, across pages", async () => {
  const seen = [];
  const all = [...Array.from({ length: 3 }, (_, i) => ({ name: `feat/x-${i}` })), { name: "feat/x", urls: ["https://feat-x-example.acct.workers.dev"] }];
  const realFetch = globalThis.fetch;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    seen.push(u.pathname + u.search);
    const name = u.searchParams.get("name");
    const per = Number(u.searchParams.get("per_page"));
    const page = Number(u.searchParams.get("page"));
    const result = all.filter((p) => p.name.includes(name)).slice((page - 1) * per, page * per);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  try {
    const hit = await branchPreview({ A: "/accounts/acct-id", worker: "example", branch: "feat/x", perPage: 2 });
    assert.deepEqual(hit?.urls, ["https://feat-x-example.acct.workers.dev"]);
    assert.equal(seen.length, 2, "it read the second page");
    assert.match(seen[0], /^\/client\/v4\/accounts\/acct-id\/workers\/workers\/example\/previews\?name=feat%2Fx&per_page=2&page=1$/);
    assert.equal(await branchPreview({ A: "/accounts/acct-id", worker: "example", branch: "feat/y", perPage: 2 }), null, "no such Preview");
  } finally {
    globalThis.fetch = realFetch;
    if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = token;
  }
});
