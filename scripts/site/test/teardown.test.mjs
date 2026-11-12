// The mail part of teardown (scripts/site/lib/teardown.mjs) against a mocked fetch: a site on a subdomain of a
// shared zone loses its Resend domain and only the DNS records promote added for it; a site on its own zone keeps
// its domain; Resend and DNS errors are reported and teardown goes on; a leftover domain is removed only when asked,
// confirmed and unused.
//   node --test scripts/site/test/teardown.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY } from "../lib/api.mjs";
import { RESEND_DNS_COMMENT } from "../lib/promote.mjs";
import { RESEND_RETRY, expectedDnsRecords, leftoverRequest, promoteDnsRecords, removeLeftover, resendCleanup, sendingDomainPlan } from "../lib/teardown.mjs";

process.env.CLOUDFLARE_API_TOKEN = "cf-test";
process.env.GH_SITES_TOKEN = "gh-test";
RETRY.baseMs = 1;
RESEND_RETRY.baseMs = 1;

const ADMIN = "re_test_admin";
const ZONES = [{ id: "z1", name: "example.com", status: "active" }, { id: "z2", name: "shop.example.net", status: "active" }];
const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result) => () => reply(200, { success: true, result });
const content = (cfg) => () => reply(200, { content: Buffer.from(JSON.stringify(cfg)).toString("base64") });

// Routes are keyed "METHOD host/path" (no query); each answers with a fresh Response. Anything else is recorded as
// unexpected and answered 418, so a stray call can't hide behind a reported error.
function mock(routes) {
  const calls = [];
  const unexpected = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    calls.push({ method, at: `${u.host}${u.pathname}`, query: u.search, auth: init.headers?.authorization });
    const handler = routes[`${method} ${u.host}${u.pathname}`];
    if (!handler) {
      unexpected.push(`${method} ${url}`);
      return reply(418, { message: "unexpected" });
    }
    return handler(u, init);
  };
  return { calls, unexpected, deletes: () => calls.filter((c) => c.method === "DELETE").map((c) => c.at) };
}
const reporter = () => {
  const lines = [];
  return { lines, did: (s) => lines.push(s) };
};

// What Resend lists for mail.shop.example.com (names relative to the zone, as on resend.com/docs/api-reference/domains/get-domain).
const RESEND_RECORDS = [
  { record: "SPF", name: "send.mail.shop", type: "MX", ttl: "Auto", status: "verified", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
  { record: "SPF", name: "send.mail.shop", type: "TXT", ttl: "Auto", status: "verified", value: '"v=spf1 include:amazonses.com ~all"' },
  { record: "DKIM", name: "resend._domainkey.mail.shop", type: "TXT", ttl: "Auto", status: "verified", value: "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC" },
];
// The zone's records under mail.shop.example.com: promote's three, and others that must stay.
const C = RESEND_DNS_COMMENT;
const ZONE_RECORDS = [
  { id: "r1", type: "MX", name: "send.mail.shop.example.com", content: "feedback-smtp.us-east-1.amazonses.com", priority: 10, comment: C },
  { id: "r2", type: "TXT", name: "send.mail.shop.example.com", content: '"v=spf1 include:amazonses.com ~all"', comment: C },
  { id: "r3", type: "TXT", name: "resend._domainkey.mail.shop.example.com", content: '"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"', comment: C },
  { id: "r4", type: "TXT", name: "_dmarc.mail.shop.example.com", content: '"v=DMARC1; p=none"', comment: null },
  { id: "r5", type: "TXT", name: "send.mail.shop.example.com", content: '"v=spf1 include:other.example ~all"' },
  { id: "r6", type: "TXT", name: "xmail.shop.example.com", content: '"v=spf1 -all"', comment: C },
  { id: "r7", type: "TXT", name: "resend._domainkey.mail.shop.example.com", content: '"p=OLDKEY"', comment: C },
];
const CF = "api.cloudflare.com/client/v4";
const resendRoutes = ({ domains = [{ id: "d-shop", name: "mail.shop.example.com" }, { id: "d-apex", name: "mail.example.com" }] } = {}) => ({
  "GET api.resend.com/api-keys": () => reply(200, { object: "list", has_more: false, data: [{ id: "k1", name: "shop sending" }, { id: "k2", name: "other sending" }] }),
  "DELETE api.resend.com/api-keys/k1": () => reply(200, {}),
  "GET api.resend.com/domains": () => reply(200, { object: "list", has_more: false, data: domains }),
  "GET api.resend.com/domains/d-shop": () => reply(200, { object: "domain", id: "d-shop", name: "mail.shop.example.com", status: "verified", records: RESEND_RECORDS }),
  "DELETE api.resend.com/domains/d-shop": () => reply(200, { object: "domain", id: "d-shop", deleted: true }),
  [`GET ${CF}/zones/z1/dns_records`]: ok(ZONE_RECORDS),
  [`DELETE ${CF}/zones/z1/dns_records/r1`]: ok({ id: "r1" }),
  [`DELETE ${CF}/zones/z1/dns_records/r2`]: ok({ id: "r2" }),
  [`DELETE ${CF}/zones/z1/dns_records/r3`]: ok({ id: "r3" }),
  [`DELETE ${CF}/zones/z1/dns_records/r7`]: ok({ id: "r7" }),
});

test("plan: a one-level subdomain of a shared zone frees its sending domain; an apex and the rest keep it", () => {
  const sub = sendingDomainPlan("shop.example.com", ZONES);
  assert.equal(sub.remove, true);
  assert.equal(sub.sendingDomain, "mail.shop.example.com");
  assert.equal(sub.zone.id, "z1");
  const apex = sendingDomainPlan("example.com", ZONES);
  assert.equal(apex.remove, false);
  assert.match(apex.why, /owns the zone/);
  assert.equal(sendingDomainPlan("shop.example.net", ZONES).remove, false, "a site on its own (sub)zone owns it");
  assert.equal(sendingDomainPlan("a.b.example.com", ZONES).remove, false, "promote never launches two levels down");
  assert.match(sendingDomainPlan("shop.example.org", ZONES).why, /no zone/);
  assert.match(sendingDomainPlan("shop.example.com", null).why, /could not be read/);
});

test("matching: only records with promote's comment that match Resend's list exactly", () => {
  const expected = expectedDnsRecords(RESEND_RECORDS, { zone: "example.com", sendingDomain: "mail.shop.example.com" });
  assert.deepEqual(expected.map((e) => `${e.type} ${e.name}`), ["MX send.mail.shop.example.com", "TXT send.mail.shop.example.com", "TXT resend._domainkey.mail.shop.example.com"]);
  const { remove, stale } = promoteDnsRecords(ZONE_RECORDS, { sendingDomain: "mail.shop.example.com", expected });
  assert.deepEqual(remove.map((r) => r.id), ["r1", "r2", "r3"]);
  assert.deepEqual(stale.map((r) => r.id), ["r7"]);
  // A different MX priority or a record without the comment is not promote's.
  const other = promoteDnsRecords([{ ...ZONE_RECORDS[0], priority: 20 }, { ...ZONE_RECORDS[1], comment: undefined }], { sendingDomain: "mail.shop.example.com", expected });
  assert.deepEqual(other.remove, []);
  // Without Resend's list: every MX, TXT or CNAME record with the comment at or under the sending domain.
  assert.deepEqual(promoteDnsRecords(ZONE_RECORDS, { sendingDomain: "mail.shop.example.com" }).remove.map((r) => r.id), ["r1", "r2", "r3", "r7"]);
});

test("subdomain site: deletes its key, its Resend domain and only the DNS records promote added for it", async () => {
  const m = mock(resendRoutes());
  const r = reporter();
  await resendCleanup({ id: "shop", host: "shop.example.com", zones: ZONES, adminKey: ADMIN, did: r.did });
  assert.deepEqual(m.unexpected, []);
  assert.deepEqual(m.deletes(), ["api.resend.com/api-keys/k1", "api.resend.com/domains/d-shop", `${CF}/zones/z1/dns_records/r1`, `${CF}/zones/z1/dns_records/r2`, `${CF}/zones/z1/dns_records/r3`]);
  const list = m.calls.find((c) => c.at === `${CF}/zones/z1/dns_records` && c.method === "GET");
  assert.match(decodeURIComponent(list.query), /name\.endswith=mail\.shop\.example\.com/);
  assert.ok(m.calls.filter((c) => c.at.startsWith("api.resend.com")).every((c) => c.auth === `Bearer ${ADMIN}`));
  assert.ok(r.lines.includes("deleted Resend domain mail.shop.example.com"));
  assert.ok(r.lines.some((l) => l.startsWith("kept the TXT record resend._domainkey.mail.shop.example.com")), "a stale record is reported, not deleted");
});

test("apex site: deletes its key and keeps mail.<domain> and the zone's records", async () => {
  const m = mock(resendRoutes());
  const r = reporter();
  await resendCleanup({ id: "shop", host: "example.com", zones: ZONES, adminKey: ADMIN, did: r.did });
  assert.deepEqual(m.unexpected, []);
  assert.deepEqual(m.deletes(), ["api.resend.com/api-keys/k1"]);
  assert.ok(!m.calls.some((c) => c.at.startsWith("api.resend.com/domains") || c.at.includes("dns_records")));
  assert.ok(r.lines.some((l) => /^Resend domain mail\.example\.com kept: the site owns the zone/.test(l)));
});

test("Resend errors are reported and teardown goes on; the DNS records stay with an undeleted domain", async () => {
  const routes = resendRoutes();
  routes["GET api.resend.com/api-keys"] = () => reply(500, { message: "Internal server error" });
  routes["DELETE api.resend.com/domains/d-shop"] = () => reply(403, { message: "API key is invalid" });
  const m = mock(routes);
  const r = reporter();
  await resendCleanup({ id: "shop", host: "shop.example.com", zones: ZONES, adminKey: ADMIN, did: r.did });
  assert.deepEqual(m.unexpected, []);
  assert.ok(r.lines.some((l) => /^Resend key not removed \(Resend GET \/api-keys: HTTP 500/.test(l)));
  assert.ok(r.lines.some((l) => /^Resend domain mail\.shop\.example\.com not removed \(.*HTTP 403 API key is invalid\); its DNS records are kept$/.test(l)));
  assert.ok(!m.calls.some((c) => c.at.includes("dns_records")), "no DNS call after the domain failed");
});

test("a DNS error is reported and the other records are still removed; a 429 from Resend is retried", async () => {
  const routes = resendRoutes();
  let first = true;
  routes["GET api.resend.com/domains"] = () => (first ? ((first = false), reply(429, { message: "Too many requests" })) : reply(200, { data: [{ id: "d-shop", name: "mail.shop.example.com" }] }));
  routes[`DELETE ${CF}/zones/z1/dns_records/r2`] = () => reply(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
  const m = mock(routes);
  const r = reporter();
  await resendCleanup({ id: "shop", host: "shop.example.com", zones: ZONES, adminKey: ADMIN, did: r.did });
  assert.deepEqual(m.unexpected, []);
  assert.equal(m.calls.filter((c) => c.at === "api.resend.com/domains" && c.method === "GET").length, 2);
  assert.ok(r.lines.includes("deleted Resend domain mail.shop.example.com"));
  assert.ok(r.lines.some((l) => /^the TXT record send\.mail\.shop\.example\.com not removed \(.*Authentication error\)$/.test(l)));
  assert.deepEqual(m.deletes().filter((d) => d.includes("dns_records")).map((d) => d.split("/").pop()), ["r1", "r2", "r3"], "the other records are still removed");
});

test("a domain Resend no longer has: its records with promote's comment are still removed", async () => {
  const m = mock(resendRoutes({ domains: [{ id: "d-apex", name: "mail.example.com" }] }));
  const r = reporter();
  await resendCleanup({ id: "shop", host: "shop.example.com", zones: ZONES, adminKey: ADMIN, did: r.did });
  assert.deepEqual(m.unexpected, []);
  assert.deepEqual(m.deletes().filter((d) => d.includes("dns_records")).map((d) => d.split("/").pop()), ["r1", "r2", "r3", "r7"]);
  assert.ok(r.lines.includes("Resend domain mail.shop.example.com not found (already removed)"));
});

test("without RESEND_ADMIN_KEY nothing is called and the leftover is reported", async () => {
  const m = mock({});
  const r = reporter();
  await resendCleanup({ id: "shop", host: "shop.example.com", zones: ZONES, adminKey: "", did: r.did });
  assert.equal(m.calls.length, 0);
  assert.match(r.lines[0], /not removed: no RESEND_ADMIN_KEY\. Remove it later with MAIL_DOMAIN=mail\.shop\.example\.com/);
});

// The leftover path: MAIL_DOMAIN with CONFIRM "delete <MAIL_DOMAIN>".
const leftoverRoutes = (extra = {}) => ({
  ...resendRoutes(),
  [`GET ${CF}/zones`]: ok(ZONES),
  "GET api.github.com/user": () => reply(200, { login: "owner" }),
  [`GET ${CF}/accounts/acc/workers/domains`]: ok([]),
  [`GET ${CF}/accounts/acc/workers/scripts`]: ok([{ id: "other-site" }, { id: "framework-backups" }]),
  "GET api.github.com/repos/owner/site-other-site/contents/site.config.json": content({ site: { mode: "launch", canonicalHost: "other.example.com" } }),
  "GET api.github.com/repos/owner/site-framework-backups/contents/site.config.json": () => reply(404, { message: "Not Found" }),
  ...extra,
});
const leftover = (over = {}) => ({ mailDomain: "mail.shop.example.com", confirm: "delete mail.shop.example.com", siteId: "shop", account: "acc", adminKey: ADMIN, ...over });

test("leftover: an unused sending domain, confirmed, is removed with its records and nothing else", async () => {
  const m = mock(leftoverRoutes());
  const r = reporter();
  await removeLeftover({ ...leftover({ mailDomain: " Mail.Shop.Example.com. " }), did: r.did });
  assert.deepEqual(m.unexpected, []);
  assert.deepEqual(m.deletes(), ["api.resend.com/api-keys/k1", "api.resend.com/domains/d-shop", `${CF}/zones/z1/dns_records/r1`, `${CF}/zones/z1/dns_records/r2`, `${CF}/zones/z1/dns_records/r3`]);
  assert.match(r.lines[0], /^leftover mail\.shop\.example\.com of shop: no Worker or site uses shop\.example\.com$/);
  const hostCheck = m.calls.find((c) => c.at === `${CF}/accounts/acc/workers/domains`);
  assert.match(decodeURIComponent(hostCheck.query), /hostname=shop\.example\.com/);
});

test("leftover: refuses without the confirmation, before any API call", async () => {
  for (const confirm of [undefined, "", "delete shop", "delete mail.shop.example.com ", "DELETE mail.shop.example.com"]) {
    const m = mock(leftoverRoutes());
    await assert.rejects(removeLeftover({ ...leftover({ confirm }), did: () => {} }), /Refusing: set CONFIRM to "delete mail\.shop\.example\.com"/);
    assert.equal(m.calls.length, 0);
  }
  assert.throws(() => leftoverRequest("mail.example.com", "delete mail.example.com"), /Refusing: MAIL_DOMAIN must be mail\./);
  assert.throws(() => leftoverRequest("shop.example.com.x", "delete shop.example.com.x"), /Refusing: MAIL_DOMAIN must be mail\./);
  const m = mock(leftoverRoutes());
  await assert.rejects(removeLeftover({ ...leftover({ adminKey: "" }), did: () => {} }), /RESEND_ADMIN_KEY/);
  assert.equal(m.calls.length, 0);
});

test("leftover: refuses a zone's own mail domain and a host still in use, deleting nothing", async () => {
  const cases = [
    [leftover({ mailDomain: "mail.shop.example.net", confirm: "delete mail.shop.example.net" }), {}, /isn't a subdomain site's sending domain \(the site owns the zone shop\.example\.net/],
    [leftover(), { [`GET ${CF}/accounts/acc/workers/domains`]: ok([{ hostname: "shop.example.com", service: "shop" }]) }, /still the Custom Domain of the Worker shop/],
    [leftover(), { [`GET ${CF}/accounts/acc/workers/scripts`]: ok([{ id: "shop" }]) }, /the Worker shop still exists/],
    [
      leftover(),
      {
        [`GET ${CF}/accounts/acc/workers/scripts`]: ok([{ id: "shop-v2" }]),
        "GET api.github.com/repos/owner/site-shop-v2/contents/site.config.json": content({ site: { mode: "launch", canonicalHost: "shop.example.com" } }),
      },
      /the site shop-v2 \(its Worker still exists, perhaps parked\) is launched on shop\.example\.com/,
    ],
  ];
  for (const [input, extra, reason] of cases) {
    const m = mock(leftoverRoutes(extra));
    await assert.rejects(removeLeftover({ ...input, did: () => {} }), reason);
    assert.deepEqual(m.deletes(), []);
    assert.ok(!m.calls.some((c) => c.at.startsWith("api.resend.com")), "Resend is not called before every check passes");
  }
});
