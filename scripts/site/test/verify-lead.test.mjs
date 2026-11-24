// The live lead check (scripts/site/verify-lead.mjs) run end to end against a stand-in for the Cloudflare API: with the
// consent box (the self-test's static leg), the ticked lead keeps the box's wording and subscribes, and the lead sent
// with the box unticked keeps no wording and subscribes no one; without the box, the visitor is subscribed by the line
// under the button. The stand-in answers the rate limit probe's posts with 429, so the probe passes at once.
//   node --test scripts/site/test/verify-lead.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../verify-lead.mjs");

// Loaded with --import before the script: answers the D1 lookups from rows given in the environment.
const MOCK = `
const CF = "https://api.cloudflare.com/client/v4/accounts/acct-id";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result) => json({ success: true, result });
const { leads, subscribers } = JSON.parse(process.env.MOCK_ROWS);
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith(CF)) return json({ ok: false, error: "rate_limited" }, 429); // the probe's first post
  const path = url.slice(CF.length).split("?")[0];
  if (path === "/d1/database") return ok([{ name: "fb-ideas", uuid: "db-1" }]);
  if (path === "/d1/database/db-1/query") {
    const { sql, params } = JSON.parse(init.body);
    let results = [];
    if (/FROM leads WHERE id = \\? AND site = \\?/.test(sql)) results = leads.filter((r) => r.id === params[0] && r.site === params[1]);
    else if (/FROM subscribers WHERE site = \\? AND email = \\?/.test(sql)) results = subscribers.filter((r) => r.site === params[0] && r.email === params[1]);
    else return json({ success: false, errors: [{ code: 0, message: "unexpected query " + sql }] }, 500);
    return ok([{ results }]);
  }
  return json({ success: false, errors: [{ code: 0, message: "unexpected " + path }] }, 500);
};
`;

const SITE = "selftest-1-st";
const LABEL = "Email me occasional news. Unsubscribe anytime.";
const LINE = "You'll get occasional emails from us. Unsubscribe anytime.";
const attribution_json = JSON.stringify({ utm_source: "live-selftest", landing: "/contact" });
const ticked = { id: "lead-1", site: SITE, form: "contact", email: "live+1@example.com", consent_text: LABEL, attribution_json };
const quiet = { id: "lead-2", site: SITE, form: "contact", email: "live+1-unticked@example.com", consent_text: "", attribution_json };
const boxLead = {
  id: "lead-1", email: ticked.email, url: "https://selftest-1-st.example.workers.dev", file: false,
  consent: { box: true, required: false, label: LABEL }, unticked: { id: "lead-2", email: quiet.email },
};

function run(lead, rows) {
  const dir = mkdtempSync(join(tmpdir(), "fb-verify-lead-"));
  writeFileSync(join(dir, "mock.mjs"), MOCK);
  writeFileSync(join(dir, "lead.json"), JSON.stringify(lead));
  const r = spawnSync(process.execPath, ["--import", join(dir, "mock.mjs"), SCRIPT], {
    env: {
      PATH: process.env.PATH, SITE_ID: SITE, LEAD_FILE: join(dir, "lead.json"),
      CLOUDFLARE_API_TOKEN: "api-token", CLOUDFLARE_ACCOUNT_ID: "acct-id", MOCK_ROWS: JSON.stringify(rows),
    },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test("consent box: the ticked lead keeps the box's wording and subscribes; the unticked one keeps none and subscribes no one", () => {
  const r = run(boxLead, { leads: [ticked, quiet], subscribers: [{ site: SITE, email: ticked.email, status: "subscribed", consent_text: LABEL }] });
  assert.equal(r.status, 0, r.out);
  for (const name of ["lead row keeps the consent box's wording", "visitor subscribed by ticking the box, with its wording",
    "lead sent with the box unticked saved, with no consent wording", "an unticked box subscribed no one"]) assert.match(r.out, new RegExp(`PASS  ${name}`));
  assert.doesNotMatch(r.out, /auto-subscribed/);
  assert.match(r.out, /PASS  rate limit/);
});

test("consent box: an unticked box that subscribed the visitor fails", () => {
  const r = run(boxLead, {
    leads: [ticked, quiet],
    subscribers: [{ site: SITE, email: ticked.email, status: "subscribed", consent_text: LABEL }, { site: SITE, email: quiet.email, status: "subscribed", consent_text: "" }],
  });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL  an unticked box subscribed no one/);
});

test("consent box: wording that isn't the box's label fails, and a missing unticked lead fails", () => {
  const r = run({ ...boxLead, unticked: null }, { leads: [{ ...ticked, consent_text: LINE }], subscribers: [{ site: SITE, email: ticked.email, status: "subscribed", consent_text: LINE }] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /FAIL  lead row keeps the consent box's wording/);
  assert.match(r.out, /FAIL  visitor subscribed by ticking the box, with its wording/);
  assert.match(r.out, /FAIL  lead sent with the box unticked saved, with no consent wording/);
  assert.match(r.out, /FAIL  an unticked box subscribed no one/);
});

test("no consent box (the line under the button): the visitor is auto-subscribed, as before", () => {
  const { consent, unticked, ...auto } = boxLead;
  const r = run(auto, { leads: [{ ...ticked, consent_text: LINE }], subscribers: [{ site: SITE, email: ticked.email, status: "subscribed", consent_text: LINE }] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /PASS  visitor auto-subscribed/);
  assert.doesNotMatch(r.out, /consent box|unticked/);
});
