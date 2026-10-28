import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptWrangler, checkAdoptConfig, checkLeadRow, checkSelect, checkSubscriberRow, keepTrigger } from "../lib/adopt.mjs";

test("adopt.json needs the Worker, the old database and the leads query", () => {
  assert.deepEqual(checkAdoptConfig({ worker: "example", legacyDb: "example-leads", leadsSql: "adopt/leads.sql" }), []);
  assert.equal(checkAdoptConfig({ worker: "example" }).length, 2);
  assert.ok(checkAdoptConfig({ worker: "w", legacyDb: "d", leadsSql: "l", uploads: "move" })[0].includes("uploads"));
  assert.deepEqual(checkAdoptConfig({ worker: "w", legacyDb: "d", leadsSql: "l", uploads: { copyFrom: "old-bucket" } }), []);
});

test("mapping queries must be one read-only SELECT", () => {
  assert.equal(checkSelect("SELECT id, kind AS form FROM leads;"), null);
  assert.equal(checkSelect("-- map\nWITH x AS (SELECT 1) SELECT * FROM x"), null);
  assert.equal(checkSelect("SELECT 'drop table; delete' AS note FROM leads"), null, "words inside strings don't count");
  assert.match(checkSelect("DELETE FROM leads"), /SELECT/);
  assert.match(checkSelect("SELECT 1; DROP TABLE leads"), /one statement/);
  assert.equal(checkSelect("SELECT * FROM leads WHERE id IN (SELECT 1) /* drop */ UNION SELECT 1 FROM pragma_table_info('x')"), null, "comments are ignored; table-valued pragmas only read");
  assert.match(checkSelect("SELECT load_extension('x')"), /only reads/);
  assert.match(checkSelect("WITH d AS (DELETE FROM leads RETURNING *) SELECT * FROM d"), /only reads/);
});

test("mapped lead rows are checked and given this site's id", () => {
  const good = { id: "a1", site: "other", form: "contact", email: "a@example.com", consent_text: "", created_at: "2026-10-15T10:00:00.000Z", fields_json: '{"zip":"64105"}' };
  const r = checkLeadRow(good, "example");
  assert.deepEqual(r.errors, []);
  assert.equal(r.row.site, "example");
  assert.equal(r.row.attribution_json, "{}");
  const bad = checkLeadRow({ id: "a2", form: "", email: "b@example.com", created_at: "yesterday", fields_json: "nope", kind: "x", upload_status: "done" }, "example");
  for (const e of ["unknown column(s) kind", "missing form", "missing consent_text", "fields_json isn't JSON", 'upload_status "done"', 'created_at "yesterday" isn\'t a date']) assert.ok(bad.errors.includes(e), e);
});

test("mapped subscriber rows are checked, lower-cased and given this site's id", () => {
  const r = checkSubscriberRow({ email: "A@Example.com", status: "subscribed", created_at: "2026-10-15", updated_at: "2026-10-15" }, "example");
  assert.deepEqual(r.errors, []);
  assert.equal(r.row.email, "a@example.com");
  assert.equal(r.row.site, "example");
  assert.ok(checkSubscriberRow({ email: "a@example.com", status: "maybe" }, "example").errors.length >= 2);
});

test("wrangler.jsonc keeps the Worker's name, gets the new database, and previews use the shared one", () => {
  const w = {
    name: "site-example", routes: [{ pattern: "example.com", custom_domain: true }],
    d1_databases: [{ binding: "DB", database_name: "x", database_id: "x", migrations_dir: "core/migrations" }],
    r2_buckets: [{ binding: "UPLOADS", bucket_name: "example-uploads" }],
    previews: { d1_databases: [{ binding: "DB", database_name: "y", database_id: "y" }] },
  };
  const out = adoptWrangler(w, { worker: "example", db: "p1", previewDb: "s1", id: "example" });
  assert.equal(out.name, "example");
  assert.deepEqual(out.d1_databases[0], { binding: "DB", database_name: "example-prod", database_id: "p1", migrations_dir: "core/migrations" });
  assert.deepEqual(out.previews.d1_databases[0], { binding: "DB", database_name: "fb-previews", database_id: "s1" });
  assert.deepEqual(out.routes, w.routes);
  assert.deepEqual(out.r2_buckets, w.r2_buckets);
  assert.equal(w.name, "site-example", "the input is not changed");
});

test("a trigger is kept with only the fields needed to recreate it", () => {
  const t = keepTrigger({ trigger_uuid: "u", trigger_name: "Deploy production", build_command: "node x.mjs", deploy_command: "npx wrangler deploy", branch_includes: ["main"], repo_connection: { repo_name: "old" } });
  assert.deepEqual(t, { trigger_name: "Deploy production", build_command: "node x.mjs", deploy_command: "npx wrangler deploy", branch_includes: ["main"] });
});
