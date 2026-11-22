// The preview URL the preview check and the agent edit check read from a Workers Builds log
// (scripts/site/lib/builds.mjs), and the guard both apply before sending a credential there.
//   node --test scripts/site/test/builds.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreviewOrigin, previewUrlFrom } from "../lib/builds.mjs";

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
