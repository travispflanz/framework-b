// The live lead check (scripts/site/verify-lead.mjs), with the Cloudflare API and Wrangler stood in for: a large
// file passes only when the stored object has the recorded size and SHA-256, and the small default file still passes
// on its marker.
//   node --test scripts/site/test/verify-lead.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(new URL("../verify-lead.mjs", import.meta.url));
const SITE = "selftest-1-st";

// D1 answers for one lead row (and its subscription), through a fetch stand-in loaded before the script.
function fakeApi(dir, row) {
  const preload = join(dir, "fake-api.mjs");
  writeFileSync(preload, `
    const row = ${JSON.stringify(row)};
    const ok = (result) => new Response(JSON.stringify({ success: true, result }), { headers: { "content-type": "application/json" } });
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/d1/database?name=")) return ok([{ name: "fb-ideas", uuid: "db" }]);
      const { sql } = JSON.parse(init.body);
      if (sql.includes("FROM leads")) return ok([{ results: [row] }]);
      if (sql.includes("FROM subscribers")) return ok([{ results: [{ status: "subscribed" }] }]);
      throw new Error("unexpected call " + url);
    };`);
  return preload;
}
// "npx wrangler r2 object get ... --file <out>" copies the stored object to <out>.
function fakeNpx(dir) {
  const bin = join(dir, "bin");
  const npx = join(bin, "npx");
  mkdirSync(bin);
  writeFileSync(npx, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv;
fs.copyFileSync(process.env.FAKE_R2_OBJECT, a[a.indexOf("--file") + 1]);
`);
  chmodSync(npx, 0o755);
  return bin;
}
function setup({ stored, lead, rowSize }) {
  const dir = mkdtempSync(join(tmpdir(), "verify-lead-"));
  const object = join(dir, "object.bin");
  writeFileSync(object, stored);
  const leadFile = join(dir, "lead.json");
  writeFileSync(leadFile, JSON.stringify({ id: "lead-1", email: "live-selftest+1@example.com", url: "https://x", file: true, ...lead }));
  const row = { email: "live-selftest+1@example.com", attribution_json: JSON.stringify({ utm_source: "live-selftest", landing: "/contact" }),
    upload_status: "stored", upload_key: `${SITE}/lead-1/x.pdf`, upload_size: rowSize ?? stored.length };
  return { dir, object, leadFile, preload: fakeApi(dir, row), bin: fakeNpx(dir) };
}
const run = ({ dir, object, leadFile, preload, bin }) => new Promise((resolve) => {
  execFile(process.execPath, ["--import", pathToFileURL(preload).href, SCRIPT, leadFile], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_R2_OBJECT: object, SITE_ID: SITE,
      CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", GITHUB_STEP_SUMMARY: "" },
  }, (err, stdout) => resolve({ code: err?.code ?? 0, stdout }));
});

const big = Buffer.alloc(3 * 1024 * 1024, 7);
const sha = (b) => createHash("sha256").update(b).digest("hex");

test("a large file passes when its size and SHA-256 match", async () => {
  const r = await run(setup({ stored: big, lead: { fileName: "x.pdf", fileBytes: big.length, fileSha256: sha(big) } }));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /PASS {2}file SHA-256 in R2 matches/);
});

test("one changed byte, or a short object, fails", async () => {
  const changed = Buffer.from(big);
  changed[12345] ^= 1;
  let r = await run(setup({ stored: changed, lead: { fileName: "x.pdf", fileBytes: big.length, fileSha256: sha(big) } }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}file SHA-256 in R2 matches/);
  const short = big.subarray(0, big.length - 1);
  r = await run(setup({ stored: short, rowSize: big.length, lead: { fileName: "x.pdf", fileBytes: big.length, fileSha256: sha(big) } }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /FAIL {2}file size in R2 matches/);
});

test("the small default file still passes on its marker", async () => {
  const r = await run(setup({ stored: Buffer.from("%PDF-1.4\n% live self-test file\n"), lead: {} }));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /PASS {2}file bytes in R2 match/);
});
