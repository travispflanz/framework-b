import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import config from "./fixture/site.config.json";
import { loadConfig } from "../src/config.js";
import { crmRow, mirror } from "../src/crm.js";
import { hmacHex } from "../src/lib/crypto.js";

const site = loadConfig({ ...structuredClone(config), crm: { sheet: true, webhook: true } });
const env = { MAILER_URL: "https://script.google.com/macros/s/x/exec", MAILER_SECRET: "test-mailer-secret", CRM_WEBHOOK_URL: "https://hooks.example.org/lead", CRM_WEBHOOK_SECRET: "hook-secret" };
const lead = {
  id: "lead-1",
  form: "contact",
  email: "person@example.com",
  createdAt: "2026-10-27T12:00:00.000Z",
  page: "/book",
  country: "US",
  fields: { name: "Test Person", email: "person@example.com", message: "Hi" },
  attribution: { utm_source: "flyer", landing: "/" },
};

let outbound;
beforeEach(() => {
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    outbound.push({ url: typeof input === "string" ? input : input.url, init });
    return outbound.at(-1).url.startsWith("https://script.google.com/") ? Response.json({ ok: true, rows: { added: 1, existing: 0 } }) : new Response("ok");
  });
});
afterEach(() => vi.restoreAllMocks());

describe("crm mirror", () => {
  it("is off by default and validated", () => {
    expect(loadConfig(structuredClone(config)).crm).toEqual({ sheet: false, webhook: false });
    expect(() => loadConfig({ ...structuredClone(config), crm: { sheet: "yes" } })).toThrow(/crm.sheet/);
  });

  it("builds one flat row: fixed columns, the form's fields, then attribution", () => {
    const row = crmRow(site, lead);
    expect(Object.keys(row)).toEqual(["id", "created_at", "site", "form", "email", "name", "message", "page", "country", "attr_utm_source", "attr_landing"]);
    expect(row).toMatchObject({ id: "lead-1", site: "example-idea", email: "person@example.com", name: "Test Person", attr_utm_source: "flyer" });
  });

  it("sends the row to the Sheet through the mailer and to the webhook, keyed by the lead id", async () => {
    const row = crmRow(site, lead);
    await mirror(env, site, row);
    const sheet = outbound.find((o) => o.url.startsWith("https://script.google.com/"));
    const payload = JSON.parse(sheet.init.body);
    expect(payload.secret).toBe("test-mailer-secret");
    expect(payload.rows).toEqual({ sheet: "example-idea", values: [row] });
    expect(payload.notify).toBeUndefined();
    const hook = outbound.find((o) => o.url === "https://hooks.example.org/lead");
    expect(hook.init.headers["idempotency-key"]).toBe("lead-1");
    expect(hook.init.headers["x-framework-b-signature"]).toBe(`sha256=${await hmacHex("hook-secret", hook.init.body)}`);
    expect(JSON.parse(hook.init.body)).toEqual({ site: "example-idea", lead: row });
  });

  it("logs a failed copy instead of throwing", async () => {
    globalThis.fetch.mockImplementation(async () => new Response("down", { status: 500 }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(mirror(env, site, crmRow(site, lead))).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
