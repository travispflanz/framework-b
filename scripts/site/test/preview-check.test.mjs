// The preview check (scripts/site/preview-check.mjs) run end to end against a stand-in for the Cloudflare API: it mints
// its service token only after the build log's preview URL proved to be one of the Worker's previews, and sends the
// token nowhere else.
//   node --test scripts/site/test/preview-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../preview-check.mjs");

// Loaded with --import before the script: answers the Cloudflare API from a build log given in the environment,
// answers any other host with 200, and records every request (method, URL, whether it carried the token).
const MOCK = `
import { appendFileSync } from "node:fs";
const CF = "https://api.cloudflare.com/client/v4/accounts/acct-id";
const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || "GET";
  const h = init.headers || {};
  appendFileSync(process.env.MOCK_LOG, JSON.stringify({ method, url, token: Boolean(h["CF-Access-Client-Secret"]) }) + "\\n");
  if (!url.startsWith(CF)) return new Response("ok", { status: 200 });
  const path = url.slice(CF.length).split("?")[0];
  if (path === "/workers/scripts") return ok([{ id: "example", tag: "tag-1" }]);
  if (path === "/workers/subdomain") return ok({ subdomain: "acct" });
  if (path === "/access/apps") return ok([{ id: "app-1", name: "example previews" }]);
  if (path === "/access/apps/app-1") return ok({ id: "app-1", name: "example previews", policies: [{ id: "pol-1" }] });
  if (path === "/access/policies") return ok([{ id: "pol-1", name: "framework-b agent", reusable: true }]);
  if (path === "/builds/workers/tag-1/builds") {
    return ok([{ build_uuid: "b-1", status: "stopped", build_outcome: "success", build_trigger_metadata: { branch: "feat/x", commit_hash: "abc1234def" } }]);
  }
  if (path === "/builds/builds/b-1/logs") return ok({ lines: JSON.parse(process.env.MOCK_BUILD_LOG).map((l, i) => [i, l]), truncated: false });
  if (path === "/access/service_tokens" && method === "GET") return ok([]);
  if (path === "/access/service_tokens" && method === "POST") return ok({ id: "tok-1", client_id: "cid", client_secret: "csecret" });
  if (path === "/access/service_tokens/tok-1" && method === "DELETE") return ok({ id: "tok-1" });
  return new Response(JSON.stringify({ success: false, errors: [{ code: 0, message: "unexpected " + method + " " + path }] }), { status: 500 });
};
`;

function run(buildLog) {
  const dir = mkdtempSync(join(tmpdir(), "fb-preview-check-"));
  const site = join(dir, "site");
  mkdirSync(join(site, "scripts"), { recursive: true });
  // A stand-in QA gate (the check needs one that reads ACCESS_CLIENT_ID): it records the URL and whether it got the token.
  writeFileSync(join(site, "package.json"), JSON.stringify({ private: true, scripts: { qa: "node scripts/qa.mjs" } }));
  writeFileSync(
    join(site, "scripts/qa.mjs"),
    `import { writeFileSync } from "node:fs";
// reads ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET
writeFileSync(${JSON.stringify(join(dir, "qa.json"))}, JSON.stringify({ argv: process.argv.slice(2), token: Boolean(process.env.ACCESS_CLIENT_SECRET) }));
console.log("QA gate passed (stand-in)");
`,
  );
  writeFileSync(join(dir, "mock.mjs"), MOCK);
  const log = join(dir, "requests.jsonl");
  writeFileSync(log, "");
  const report = join(dir, "report.md");
  const r = spawnSync(process.execPath, ["--import", join(dir, "mock.mjs"), SCRIPT, "--site", site, "--site-id", "example", "--branch", "feat/x", "--commit", "abc1234", "--report", report], {
    env: {
      PATH: process.env.PATH,
      CLOUDFLARE_API_TOKEN: "api-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-id",
      CF_BUILDS_TOKEN: "builds-token",
      MOCK_LOG: log,
      MOCK_BUILD_LOG: JSON.stringify(buildLog),
      npm_config_update_notifier: "false",
      npm_config_cache: join(dir, "npm-cache"),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  try {
    const requests = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const qa = existsSync(join(dir, "qa.json")) ? JSON.parse(readFileSync(join(dir, "qa.json"), "utf8")) : null;
    return { status: r.status, report: readFileSync(report, "utf8"), requests, qa };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const minted = (requests) => requests.some((q) => q.method === "POST" && q.url.endsWith("/access/service_tokens"));

test("a build log whose first \"Preview URL:\" names another host gets no token minted or sent", () => {
  const { status, report, requests, qa } = run(["> npm run build", "Preview URL: https://collector.example.com", "Preview URL: https://feat-x-example.acct.workers.dev"]);
  assert.equal(status, 1);
  assert.match(report, /collector\.example\.com isn't one of example's previews on acct\.workers\.dev; no token was minted or sent/);
  assert.ok(!minted(requests), "no service token was minted");
  assert.ok(!requests.some((q) => !q.url.startsWith("https://api.cloudflare.com/")), "nothing but the Cloudflare API was called");
  assert.equal(qa, null, "QA never ran");
});

test("an unparseable preview URL is refused the same way", () => {
  const { status, report, requests } = run(["Preview URL: https://[not-a-host"]);
  assert.equal(status, 1);
  assert.match(report, /no token was minted or sent/);
  assert.ok(!minted(requests));
});

test("the Worker's own preview gets the token, only on its origin, and the token is deleted", () => {
  const { status, report, requests, qa } = run(["> npx wrangler preview", "Preview URL: https://feat-x-example.acct.workers.dev/"]);
  assert.equal(status, 0, report);
  assert.deepEqual(qa, { argv: ["--url", "https://feat-x-example.acct.workers.dev"], token: true }, "QA got the origin and the token");
  assert.match(report, /- Preview: https:\/\/feat-x-example\.acct\.workers\.dev \(behind Cloudflare Access\)/);
  assert.ok(minted(requests), "the token was minted");
  const carried = requests.filter((q) => q.token);
  assert.ok(carried.length > 0, "the preview was probed with the token");
  for (const q of carried) assert.equal(new URL(q.url).origin, "https://feat-x-example.acct.workers.dev", q.url);
  assert.ok(carried.every((q) => !q.url.includes("workers.dev//")), "the URL is the origin: the log's trailing slash doesn't double");
  assert.ok(requests.some((q) => q.method === "DELETE" && q.url.endsWith("/access/service_tokens/tok-1")), "the token was deleted");
});
