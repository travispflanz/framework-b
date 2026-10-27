import { test } from "node:test";
import assert from "node:assert/strict";
import { launchConfig, launchNames, launchWrangler, mergeRedirectRules, notifyPlan, redirectRule, REDIRECT_REF, resendRecordName, ownerChecklist, zoneFor } from "../lib/promote.mjs";

const ideaConfig = {
  site: { id: "example-co", name: "Example Co", mode: "idea", canonicalHost: "example-co.acct.workers.dev", ownerEmail: "owner@example.com", postalAddress: "", indexing: false },
  email: { notify: "apps-script", confirm: "none" },
  forms: { contact: { fields: [] } },
};
const ideaWrangler = {
  name: "example-co",
  workers_dev: true,
  d1_databases: [{ binding: "DB", database_name: "fb-ideas", database_id: "shared", migrations_dir: "core/migrations" }, { binding: "CMS_DB", database_name: "example-co-cms", database_id: "cms" }],
  r2_buckets: [{ binding: "UPLOADS", bucket_name: "fb-ideas-uploads" }, { binding: "MEDIA", bucket_name: "example-co-media" }],
  vars: { ACCESS_AUD: "aud" },
  previews: {
    d1_databases: [{ binding: "DB", database_name: "fb-previews", database_id: "prev", migrations_dir: "core/migrations" }, { binding: "CMS_DB", database_name: "example-co-cms-preview", database_id: "cmsprev" }],
    r2_buckets: [{ binding: "UPLOADS", bucket_name: "fb-previews" }],
  },
};

test("launch config: mode, host, address, indexing and both mailers", () => {
  const c = launchConfig(ideaConfig, { domain: "example.com", postalAddress: " 1 Main St, Town, KS 66000 ", resend: true });
  assert.equal(c.site.mode, "launch");
  assert.equal(c.site.canonicalHost, "example.com");
  assert.equal(c.site.postalAddress, "1 Main St, Town, KS 66000");
  assert.equal(c.site.indexing, true);
  assert.deepEqual(c.email, { notify: "cloudflare", notifyFrom: "notify@example.com", confirm: "resend", confirmFrom: "hello@mail.example.com" });
  assert.equal(ideaConfig.site.mode, "idea", "the input is not changed");
});

test("launch config without Resend leaves auto-replies off", () => {
  const c = launchConfig({ ...ideaConfig, email: { notify: "none", confirm: "resend", confirmFrom: "x@y.z" } }, { domain: "example.com", postalAddress: "PO Box 1", resend: false });
  assert.equal(c.email.confirm, "none");
  assert.equal(c.email.confirmFrom, undefined);
});

test("launch config refuses a bad domain or a missing postal address", () => {
  assert.throws(() => launchConfig(ideaConfig, { domain: "https://example.com", postalAddress: "x" }), /not a domain/);
  assert.throws(() => launchConfig(ideaConfig, { domain: "example.com", postalAddress: " " }), /postal address/);
});

test("launch wrangler: custom domain, own databases and bucket, send_email; other bindings kept", () => {
  const w = launchWrangler(ideaWrangler, { id: "example-co", domain: "example.com", owner: "owner@example.com", db: "prod-uuid", stagingDb: "staging-uuid" });
  assert.deepEqual(w.routes, [{ pattern: "example.com", custom_domain: true }]);
  assert.equal(w.workers_dev, true);
  assert.deepEqual(w.d1_databases[0], { binding: "DB", database_name: "example-co-prod", database_id: "prod-uuid", migrations_dir: "core/migrations" });
  assert.deepEqual(w.d1_databases[1], ideaWrangler.d1_databases[1]);
  assert.deepEqual(w.r2_buckets, [{ binding: "UPLOADS", bucket_name: "example-co-uploads" }, { binding: "MEDIA", bucket_name: "example-co-media" }]);
  assert.deepEqual(w.send_email, [{ name: "EMAIL", destination_address: "owner@example.com" }]);
  assert.equal(w.previews.d1_databases[0].database_name, "example-co-staging");
  assert.equal(w.previews.d1_databases[0].database_id, "staging-uuid");
  assert.deepEqual(w.previews.d1_databases[1], ideaWrangler.previews.d1_databases[1]);
  assert.deepEqual(w.previews.r2_buckets, ideaWrangler.previews.r2_buckets, "previews keep the shared previews bucket");
  assert.deepEqual(w.vars, ideaWrangler.vars);
  assert.deepEqual(launchNames("example-co"), { db: "example-co-prod", stagingDb: "example-co-staging", uploads: "example-co-uploads" });
});

test("redirect rule is merged by ref, keeping other rules and dropping read-only fields", () => {
  const rule = redirectRule("example.com");
  assert.equal(rule.expression, '(http.host eq "www.example.com")');
  assert.equal(rule.action_parameters.from_value.status_code, 301);
  assert.equal(rule.action_parameters.from_value.preserve_query_string, true);
  const other = { id: "1", version: "3", last_updated: "t", ref: "other", expression: "true", action: "redirect", action_parameters: {} };
  const old = { id: "2", version: "1", ref: REDIRECT_REF, expression: "old", action: "redirect", action_parameters: {} };
  const merged = mergeRedirectRules([other, old], rule);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { ref: "other", expression: "true", action: "redirect", action_parameters: {} });
  assert.equal(merged[1], rule);
  assert.deepEqual(mergeRedirectRules(undefined, rule), [rule]);
});

test("Resend record names land under the sending domain", () => {
  const at = { zone: "example.com", sendingDomain: "mail.example.com" };
  assert.equal(resendRecordName("resend._domainkey.mail", at), "resend._domainkey.mail.example.com");
  assert.equal(resendRecordName("send.mail", at), "send.mail.example.com");
  assert.equal(resendRecordName("resend._domainkey", at), "resend._domainkey.mail.example.com");
  assert.equal(resendRecordName("send", at), "send.mail.example.com");
  assert.equal(resendRecordName("resend._domainkey.mail.example.com.", at), "resend._domainkey.mail.example.com");
  assert.equal(resendRecordName("@", at), "mail.example.com");
});

test("owner checklist names the domain in every dashboard step", () => {
  const list = ownerChecklist("example.com");
  assert.equal(list.length, 4);
  assert.ok(list.every((l) => l.includes("https://")));
  assert.ok(list.filter((l) => l.includes("example.com")).length >= 3);
});

test("a subdomain finds its zone; the longest matching zone wins", () => {
  const zones = [{ name: "example.com", id: "a" }, { name: "shop.example.com", id: "b" }, { name: "other.org", id: "c" }];
  assert.equal(zoneFor("example.com", zones).id, "a");
  assert.equal(zoneFor("site.example.com", zones).id, "a");
  assert.equal(zoneFor("x.shop.example.com", zones).id, "b");
  assert.equal(zoneFor("notexample.com", zones), null);
});

test("notifications use Email Routing only on a whole zone with no other mail provider", () => {
  assert.equal(notifyPlan({ ownsZone: true, apexMx: [] }).notify, "cloudflare");
  assert.equal(notifyPlan({ ownsZone: true, apexMx: ["route1.mx.cloudflare.net."] }).notify, "cloudflare");
  assert.equal(notifyPlan({ ownsZone: true, apexMx: ["mx.mailhost.example."], mailer: true }).notify, "apps-script");
  assert.equal(notifyPlan({ ownsZone: false, apexMx: [], mailer: true }).notify, "apps-script");
  const none = notifyPlan({ ownsZone: false, mailer: false });
  assert.equal(none.notify, "none");
  assert.match(none.why, /MAILER_URL/);
});

test("launch files for an Apps Script site: no notifyFrom, no send_email binding", () => {
  const c = launchConfig({ ...ideaConfig, email: { notify: "none", confirm: "none" } }, { domain: "site.example.com", postalAddress: "PO Box 1", resend: true, notify: "apps-script" });
  assert.deepEqual(c.email, { notify: "apps-script", confirm: "resend", confirmFrom: "hello@mail.site.example.com" });
  const w = launchWrangler({ ...ideaWrangler, send_email: [{ name: "EMAIL" }] }, { id: "example-co", domain: "site.example.com", owner: "o@example.com", db: "p", stagingDb: "s", sendEmail: false });
  assert.equal(w.send_email, undefined);
  assert.deepEqual(w.routes, [{ pattern: "site.example.com", custom_domain: true }]);
});
