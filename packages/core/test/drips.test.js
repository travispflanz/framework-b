import { env, introspectWorkflowInstance, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./fixture/worker.js";
import ideaConfig from "./fixture/site.config.json";
import launchRaw from "./fixture/drips.config.json";
import { loadConfig } from "../src/config.js";
import { dripErrors, parseAfter } from "../src/drips-config.js";
import { dripFrom, dripMessage, startDrip, textToHtml } from "../src/drips.js";
import { unsubscribeUrl } from "../src/mailers.js";

const launch = loadConfig(launchRaw);
const SITE = launch.site.id;

let outbound;
beforeEach(() => {
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    outbound.push({ url, init });
    if (url === "https://api.resend.com/emails") return Response.json({ id: `email-${outbound.length}` });
    return new Response("unexpected outbound fetch", { status: 599 });
  });
});
afterEach(() => vi.restoreAllMocks());

const subscribe = (email, status = "subscribed") =>
  env.DB.prepare(
    `INSERT INTO subscribers (site, email, status, source_form, consent_text, created_at, updated_at) VALUES (?, ?, ?, 'contact', '', '2026-10-27', '2026-10-27')
     ON CONFLICT (site, email) DO UPDATE SET status = excluded.status`,
  ).bind(SITE, email, status).run();

describe("drips config", () => {
  it("accepts a launch site with Resend and checks every email", () => {
    expect(launch.drips.emails).toHaveLength(2);
    expect(parseAfter("1 day")).toEqual({ n: 1, duration: "1 day", days: 1 });
    expect(parseAfter("3 weeks").duration).toBe("3 weeks");
    expect(parseAfter("2 months")).toBeNull();
    expect(dripErrors({ ...launch, drips: { forms: ["nope"], emails: [{ after: "soon", subject: "", text: "x" }] } })).toEqual([
      'drips.forms: no form "nope"',
      'drips.emails[0].after must look like "2 days" (minutes, hours, days or weeks)',
      "drips.emails[0].subject is required (200 characters at most)",
    ]);
    expect(dripErrors({ ...launch, drips: { forms: ["contact"], emails: [{ after: "60 weeks", subject: "s", text: "t" }] } })).toEqual(["drips.emails[0].after is longer than 365 days"]);
  });

  it("refuses drips on an idea site", () => {
    expect(() => loadConfig({ ...structuredClone(ideaConfig), drips: launchRaw.drips })).toThrow(/drips need launch mode[\s\S]*email.confirm "resend"/);
  });
});

describe("drip email", () => {
  it("is marketing mail: one-click unsubscribe headers, postal address, the site's Resend domain", async () => {
    const unsub = await unsubscribeUrl(env, launch, "https://example.com", "person@example.com");
    const msg = dripMessage(launch, 0, "person@example.com", unsub);
    expect(msg.from).toBe("Example Co <news@mail.example.com>");
    expect(dripFrom({ ...launch, drips: { ...launch.drips, from: "tips" } })).toBe("tips@mail.example.com");
    expect(msg.headers).toEqual({ "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(msg.text).toContain("1 Main St, Town, KS 66000");
    expect(msg.text).toContain(`Unsubscribe: ${unsub}`);
    expect(msg.html).toContain('<a href="https://example.com/guide">https://example.com/guide</a>.');
    expect(textToHtml("a <b>\nline\n\nnext")).toBe("<p>a &lt;b&gt;<br>line</p><p>next</p>");
  });

  it("starts one instance per lead, only for the listed forms", async () => {
    const create = vi.fn(async () => ({}));
    expect(await startDrip({ DRIPS: { create } }, launch, "contact", { id: "L9", email: "a@example.com" })).toBe(true);
    expect(create).toHaveBeenCalledWith({ id: "drip-L9", params: { lead: "L9", email: "a@example.com" } });
    expect(await startDrip({ DRIPS: { create } }, launch, "other", { id: "L9", email: "a@example.com" })).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("drip workflow", () => {
  it("sends each email in order to a subscriber, with an idempotency key per email", async () => {
    await subscribe("ann@example.com");
    await using instance = await introspectWorkflowInstance(env.DRIPS, "drip-L1");
    await instance.modify(async (m) => m.disableSleeps());
    await env.DRIPS.create({ id: "drip-L1", params: { lead: "L1", email: "ann@example.com" } });
    await instance.waitForStatus("complete");
    const out = await instance.getOutput();
    expect(out.sent).toHaveLength(2);
    const sends = outbound.filter((o) => o.url === "https://api.resend.com/emails");
    expect(sends.map((s) => s.init.headers["idempotency-key"])).toEqual(["drip-L1-1", "drip-L1-2"]);
    expect(sends.map((s) => JSON.parse(s.init.body).subject)).toEqual(["Welcome to Example Co", "A tip from Example Co"]);
    expect(JSON.parse(sends[0].init.body).headers["List-Unsubscribe"]).toMatch(/^<https:\/\/example\.com\/u\?e=ann%40example\.com&t=/);
  });

  it("stops when the person has unsubscribed", async () => {
    await subscribe("bob@example.com", "unsubscribed");
    await using instance = await introspectWorkflowInstance(env.DRIPS, "drip-L2");
    await instance.modify(async (m) => m.disableSleeps());
    await env.DRIPS.create({ id: "drip-L2", params: { lead: "L2", email: "bob@example.com" } });
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ lead: "L2", sent: [], stopped: "unsubscribed before email 1" });
    expect(outbound.filter((o) => o.url === "https://api.resend.com/emails")).toHaveLength(0);
  });
});

describe("one-click unsubscribe (RFC 8058)", () => {
  it("a POST with only List-Unsubscribe=One-Click in the body unsubscribes the address in the link", async () => {
    const unsub = await unsubscribeUrl(env, loadConfig(ideaConfig), "https://example-idea.example.workers.dev", "carl@example.com");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(unsub, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT status FROM subscribers WHERE site = ? AND email = ?").bind("example-idea", "carl@example.com").first();
    expect(row.status).toBe("unsubscribed");
  });
});
