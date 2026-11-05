// The Cloudflare API client (scripts/site/lib/api.mjs): GETs ride out a transient 429/5xx or network failure,
// writes never repeat, and a lasting error still fails.
//   node --test scripts/site/test/api.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY, cf } from "../lib/api.mjs";

RETRY.baseMs = 1; // no real waiting in tests
const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
function fake(sequence) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(init.method);
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return calls;
}

test("a GET retries a 500 and a network failure, then returns the result", async () => {
  const calls = fake([reply(500, { success: false, errors: [{ code: 12001, message: "Internal server error" }] }), new TypeError("fetch failed"), reply(200, { success: true, result: [1] })]);
  assert.deepEqual(await cf("/accounts/x/builds", { token: "t" }), [1]);
  assert.equal(calls.length, 3);
});

test("a GET that keeps failing gives up after the last attempt", async () => {
  const calls = fake(Array.from({ length: RETRY.attempts }, () => reply(503, { success: false, errors: [{ code: 1, message: "busy" }] })));
  await assert.rejects(cf("/accounts/x/builds", { token: "t" }), /busy/);
  assert.equal(calls.length, RETRY.attempts);
});

test("a write and a client error are not retried", async () => {
  let calls = fake([reply(500, { success: false, errors: [{ code: 1, message: "boom" }] })]);
  await assert.rejects(cf("/accounts/x/thing", { method: "POST", body: {}, token: "t" }), /boom/);
  assert.equal(calls.length, 1);
  calls = fake([reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] })]);
  await assert.rejects(cf("/accounts/x/builds", { token: "t" }), /Authentication error/);
  assert.equal(calls.length, 1);
});
