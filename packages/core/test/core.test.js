import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./fixture/worker.js";
import config from "./fixture/site.config.json";
import { loadConfig } from "../src/config.js";
import { createWorker } from "../src/index.js";
import { buildHeadersFile } from "../src/headers.js";
import { sign } from "../src/lib/crypto.js";
import { csv } from "../src/lib/util.js";
import { verifyTurnstile } from "../src/lib/turnstile.js";
import pkg from "../package.json";

const BASE = "https://example-idea.example.workers.dev";
const ORIGIN = { origin: BASE };

let outbound;
beforeEach(() => {
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    outbound.push({ url, init });
    if (url.includes("turnstile/v0/siteverify")) {
      const token = init.body.get("response");
      return Response.json(token === "XXXX.DUMMY.TOKEN.XXXX" ? { success: true, hostname: "example.com" } : { success: false });
    }
    if (url.startsWith("https://script.google.com/")) return Response.json({ ok: true, sent: 2, remaining: 98 });
    return new Response("unexpected outbound fetch", { status: 599 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(path, init = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function submit(body, headers = {}) {
  return call("/api/submit/contact", {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN, "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 250)}`, ...headers },
    body: JSON.stringify({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", ...body }),
  });
}

describe("config", () => {
  it("rejects a form without a required email field", () => {
    const bad = structuredClone(config);
    bad.forms.contact.fields = bad.forms.contact.fields.filter((f) => f.name !== "email");
    expect(() => loadConfig(bad)).toThrow(/required "email" field/);
  });
  it("rejects a domain mailer on an idea site", () => {
    const bad = structuredClone(config);
    bad.email = { notify: "cloudflare", notifyFrom: "notify@example.com", confirm: "none" };
    expect(() => loadConfig(bad)).toThrow(/idea sites have no domain/);
  });
  it("requires a postal address in launch mode", () => {
    const bad = structuredClone(config);
    bad.site.mode = "launch";
    bad.email = { notify: "none", confirm: "none" };
    expect(() => loadConfig(bad)).toThrow(/postalAddress/);
  });
});

describe("headers file", () => {
  it("noindexes everything for an unindexed idea site", () => {
    expect(buildHeadersFile(config)).toMatch(/\/\*\n(.+\n)*  X-Robots-Tag: noindex/);
  });
  it("noindexes only the workers.dev twin of an indexed launch site", () => {
    const launch = structuredClone(config);
    Object.assign(launch.site, { mode: "launch", indexing: true, canonicalHost: "www.example.com", postalAddress: "1 Example St, Example City" });
    launch.email = { notify: "none", confirm: "none" };
    const file = buildHeadersFile(launch);
    expect(file).toContain("https://:worker.:subdomain.workers.dev/*\n  X-Robots-Tag: noindex");
    expect(file.split("\n\n")[0]).not.toContain("noindex");
  });
  it("keeps an indexed idea site's workers.dev address indexable", () => {
    const idea = structuredClone(config);
    Object.assign(idea.site, { mode: "idea", indexing: true, canonicalHost: "example-idea.example.workers.dev" });
    const file = buildHeadersFile(idea);
    expect(file).not.toContain("noindex");
  });
});

describe("health", () => {
  it("reports D1 reachable", async () => {
    const res = await call("/api/health");
    expect(await res.json()).toMatchObject({ ok: true, site: "example-idea", core: pkg.version });
  });
});

describe("submit", () => {
  it("saves a lead, auto-subscribes, and mails through Apps Script", async () => {
    const res = await submit({ name: "Test Person", email: "Person@Example.com", message: "Hello", attr_utm_source: "flyer", attr_referrer: "https://ref.example.org/a?b=c" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ ok: true, redirect: "/thanks" });
    expect(out.upload).toBeUndefined();

    const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(out.id).first();
    expect(lead).toMatchObject({ site: "example-idea", form: "contact", email: "person@example.com", name: "Test Person", notified: 1, confirmed: 1 });
    expect(JSON.parse(lead.attribution_json)).toEqual({ utm_source: "flyer", referrer: "https://ref.example.org/a" });
    expect(lead.consent_text).toBe("You'll get occasional emails from us. Unsubscribe anytime.");

    const sub = await env.DB.prepare("SELECT status FROM subscribers WHERE site = ? AND email = ?").bind("example-idea", "person@example.com").first();
    expect(sub.status).toBe("subscribed");

    const mail = outbound.find((o) => o.url.startsWith("https://script.google.com/"));
    const payload = JSON.parse(mail.init.body);
    expect(payload.secret).toBe("test-mailer-secret");
    expect(payload.notify.to).toBe("owner@example.com");
    expect(payload.notify.replyTo).toBe("person@example.com");
    expect(payload.reply.to).toBe("person@example.com");
    expect(payload.reply.text).toMatch(/Unsubscribe: https:\/\/example-idea\.example\.workers\.dev\/u\?e=/);
  });

  it("accepts a plain form post (no JavaScript)", async () => {
    const body = new URLSearchParams({ name: "Form Post", email: "formpost@example.com", "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" });
    const res = await call("/api/submit/contact", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...ORIGIN }, body });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/thanks`);
    const row = await env.DB.prepare("SELECT name FROM leads WHERE email = 'formpost@example.com'").first();
    expect(row.name).toBe("Form Post");
  });

  it("records a mail failure on the lead without losing it", async () => {
    globalThis.fetch.mockImplementation(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("siteverify")) return Response.json({ success: true, hostname: "localhost" });
      return Response.json({ ok: false, error: "quota_exhausted" });
    });
    const out = await (await submit({ name: "A", email: "quota@example.com" })).json();
    const lead = await env.DB.prepare("SELECT notified, notify_error FROM leads WHERE id = ?").bind(out.id).first();
    expect(lead).toEqual({ notified: 0, notify_error: "apps-script: quota_exhausted" });
  });

  it("rejects a cross-origin post", async () => {
    const res = await submit({ name: "A", email: "a@example.com" }, { origin: "https://evil.example.net" });
    expect(res.status).toBe(403);
  });

  it("rejects a failed Turnstile check", async () => {
    const res = await submit({ name: "A", email: "a@example.com", "cf-turnstile-response": "bad" });
    expect(await res.json()).toMatchObject({ ok: false, error: "turnstile_failed" });
  });

  it("silently drops honeypot submissions", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first();
    const res = await submit({ name: "Bot", email: "bot@example.com", website: "http://spam.example" });
    expect(await res.json()).toMatchObject({ ok: true });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first();
    expect(after.n).toBe(before.n);
  });

  it("validates fields against the schema", async () => {
    const res = await submit({ name: "", email: "not-an-email", topic: "nope" });
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual({ name: "required", email: "invalid_email", topic: "invalid_option" });
  });

  it("re-subscribes someone who unsubscribed and then fills in a form again", async () => {
    await env.DB.prepare(
      "INSERT INTO subscribers (site, email, status, created_at, updated_at, unsubscribed_at) VALUES ('example-idea', 'gone@example.com', 'unsubscribed', 'x', 'x', 'x')",
    ).run();
    await submit({ name: "Back Again", email: "gone@example.com" });
    const sub = await env.DB.prepare("SELECT status, unsubscribed_at, source_form FROM subscribers WHERE email = 'gone@example.com'").first();
    expect(sub).toEqual({ status: "subscribed", unsubscribed_at: null, source_form: "contact" });
  });

  it("rate-limits repeated posts from one address", async () => {
    const statuses = [];
    for (let i = 0; i < 8; i++) {
      const res = await submit({ name: "R", email: `r${i}@example.com` }, { "cf-connecting-ip": "203.0.113.9" });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("upload", () => {
  async function startUpload(file) {
    const out = await (await submit({ name: "Uploader", email: "up@example.com", file_name: file.name, file_size: file.size, file_type: file.type })).json();
    return out;
  }

  it("rejects disallowed types and oversized files before any ticket exists", async () => {
    let res = await submit({ name: "U", email: "u@example.com", file_name: "x.exe", file_size: 10, file_type: "application/x-msdownload" });
    expect((await res.json()).fields).toEqual({ file: "file_type" });
    res = await submit({ name: "U", email: "u@example.com", file_name: "big.pdf", file_size: 2 * 1024 * 1024, file_type: "application/pdf" });
    expect((await res.json()).fields).toEqual({ file: "file_too_large" });
  });

  it("streams the file to R2 under the site prefix, once", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 test file");
    const out = await startUpload({ name: "Quote Request.pdf", size: bytes.length, type: "application/pdf" });
    expect(out.upload.url).toMatch(/^\/api\/upload\/[0-9a-f-]{36}\?exp=\d+&sig=/);

    const put = () => call(out.upload.url, { method: "PUT", headers: { ...ORIGIN, "content-type": "application/pdf", "content-length": String(bytes.length) }, body: bytes });
    const res = await put();
    expect(res.status).toBe(200);

    const lead = await env.DB.prepare("SELECT upload_status, upload_key FROM leads WHERE id = ?").bind(out.id).first();
    expect(lead).toEqual({ upload_status: "stored", upload_key: `example-idea/${out.id}/Quote-Request.pdf` });
    const obj = await env.UPLOADS.get(lead.upload_key);
    expect(await obj.text()).toBe("%PDF-1.4 test file");

    expect((await put()).status).toBe(409); // single use
  });

  it("refuses a body that doesn't match the signed size or type, or a forged signature", async () => {
    const out = await startUpload({ name: "a.png", size: 4, type: "image/png" });
    let res = await call(out.upload.url, { method: "PUT", headers: { ...ORIGIN, "content-type": "image/png", "content-length": "5" }, body: "12345" });
    expect(res.status).toBe(400);
    res = await call(out.upload.url, { method: "PUT", headers: { ...ORIGIN, "content-type": "application/pdf", "content-length": "4" }, body: "1234" });
    expect(res.status).toBe(400);
    res = await call(out.upload.url.replace(/sig=.*/, "sig=forged"), { method: "PUT", headers: { ...ORIGIN, "content-type": "image/png", "content-length": "4" }, body: "1234" });
    expect(res.status).toBe(403);
  });
});

describe("unsubscribe", () => {
  it("GET only shows a button; POST unsubscribes; bad tokens are refused", async () => {
    await submit({ name: "Leaver", email: "leaver@example.com" });
    const t = await sign(env.SIGNING_SECRET, "unsub:example-idea:leaver@example.com");

    const get = await call(`/u?e=leaver%40example.com&t=${t}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("<button");
    let sub = await env.DB.prepare("SELECT status FROM subscribers WHERE email = 'leaver@example.com'").first();
    expect(sub.status).toBe("subscribed");

    const post = await call("/u", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `e=leaver%40example.com&t=${t}` });
    expect(post.status).toBe(200);
    sub = await env.DB.prepare("SELECT status, unsubscribed_at FROM subscribers WHERE email = 'leaver@example.com'").first();
    expect(sub.status).toBe("unsubscribed");
    expect(sub.unsubscribed_at).toBeTruthy();

    expect((await call(`/u?e=leaver%40example.com&t=wrong`)).status).toBe(400);
  });
});

describe("admin", () => {
  it("is closed without a valid Access JWT", async () => {
    expect((await call("/admin")).status).toBe(403);
    expect((await call("/admin", { headers: { "cf-access-jwt-assertion": "a.b.c" } })).status).toBe(403);
    expect((await call("/admin/leads.csv")).status).toBe(403);
  });

  it("opens with a valid Access JWT and shows only this site's leads", async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1", alg: "RS256" };
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const head = b64({ alg: "RS256", kid: "k1" });
    const body = b64({ aud: ["test-aud"], iss: "https://example.cloudflareaccess.com", exp: Math.floor(Date.now() / 1000) + 600, email: "owner@example.com" });
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)));
    const jwt = `${head}.${body}.${btoa(String.fromCharCode(...sig)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;

    const base = globalThis.fetch.getMockImplementation();
    globalThis.fetch.mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.cloudflareaccess.com/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
      return base(input, init);
    });

    await submit({ name: "Visible Lead", email: "visible@example.com" });
    await env.DB.prepare(
      "INSERT INTO leads (id, site, form, email, name, consent_text, created_at) VALUES ('11111111-1111-1111-1111-111111111111', 'other-site', 'contact', 'other@example.com', 'Other Site Lead', 'x', '2026-10-22T00:00:00Z')",
    ).run();

    const res = await call("/admin", { headers: { "cf-access-jwt-assertion": jwt } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Visible Lead");
    expect(html).not.toContain("Other Site Lead");

    const other = await call("/admin/lead/11111111-1111-1111-1111-111111111111", { headers: { "cf-access-jwt-assertion": jwt } });
    expect(other.status).toBe(404);

    const csvRes = await call("/admin/leads.csv", { headers: { "cf-access-jwt-assertion": jwt } });
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    expect(await csvRes.text()).toContain("visible@example.com");
  });
});

describe("csv", () => {
  it("neutralises spreadsheet formulas", () => {
    expect(csv([["=HYPERLINK(\"x\")", "+1", "ok"]])).toBe(`"'=HYPERLINK(""x"")",'+1,ok\r\n`);
  });
});

describe("turnstile hostname", () => {
  it("rejects a real-key token minted on another hostname, accepts its own", async () => {
    globalThis.fetch.mockImplementation(async () => Response.json({ success: true, hostname: "other.example.net" }));
    const real = { TURNSTILE_SECRET: "0x4AAAAAAA-real-looking-secret" };
    expect(await verifyTurnstile(real, "tok", "", "example-idea.example.workers.dev")).toEqual({ ok: false, reason: "turnstile_hostname" });
    globalThis.fetch.mockImplementation(async () => Response.json({ success: true, hostname: "example-idea.example.workers.dev" }));
    expect(await verifyTurnstile(real, "tok", "", "example-idea.example.workers.dev")).toEqual({ ok: true });
  });
});


describe("client editing (EmDash) fallback", () => {
  it("sends non-core routes to the fallback and keeps core routes and the noindex rule", async () => {
    const { createWorker } = await import("../src/index.js");
    const seen = [];
    const w = createWorker(config, { fallback: async (req) => { seen.push(new URL(req.url).pathname); return new Response("from emdash", { headers: { "content-type": "text/html" } }); } });
    const page = await w.fetch(new Request("https://example-idea.example.workers.dev/_emdash/admin"), env, createExecutionContext());
    expect(await page.text()).toBe("from emdash");
    expect(page.headers.get("x-robots-tag")).toBe("noindex");
    const health = await w.fetch(new Request("https://example-idea.example.workers.dev/api/health"), env, createExecutionContext());
    expect((await health.json()).ok).toBe(true);
    expect(seen).toEqual(["/_emdash/admin"]);
  });
});

describe("checkbox opt-in (optIn.mode checkbox)", () => {
  const cfg = structuredClone(config);
  cfg.optIn = { mode: "checkbox", label: "Email me news." };
  cfg.forms.contact.consent = "required";
  cfg.forms.note = { title: "Note", fields: [{ name: "email", type: "email", label: "Email", required: true }], thanks: "/thanks" };
  const boxWorker = createWorker(cfg);
  async function post(form, body) {
    const ctx = createExecutionContext();
    const res = await boxWorker.fetch(new Request(`${BASE}/api/submit/${form}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ORIGIN, "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", ...body }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const status = (email) => env.DB.prepare("SELECT status FROM subscribers WHERE email = ?").bind(email).first();

  it("refuses a required-consent form without the box, and subscribes when it is ticked", async () => {
    const no = await post("contact", { name: "A", email: "box-a@example.com" });
    expect(no.status).toBe(422);
    expect((await no.json()).fields.consent).toBe("required");
    const yes = await post("contact", { name: "A", email: "box-a@example.com", consent: "on" });
    expect(yes.status).toBe(200);
    expect(await status("box-a@example.com")).toEqual({ status: "subscribed" });
    const lead = await env.DB.prepare("SELECT consent_text FROM leads WHERE email = 'box-a@example.com'").first();
    expect(lead.consent_text).toBe("Email me news.");
  });

  it("stores an optional-consent lead without subscribing, and never re-subscribes without the box", async () => {
    expect((await post("note", { email: "box-b@example.com" })).status).toBe(200);
    expect(await status("box-b@example.com")).toBeNull();
    await env.DB.prepare("INSERT INTO subscribers (site, email, status, created_at, updated_at, unsubscribed_at) VALUES ('example-idea', 'box-c@example.com', 'unsubscribed', 'x', 'x', 'x')").run();
    expect((await post("note", { email: "box-c@example.com" })).status).toBe(200);
    expect(await status("box-c@example.com")).toEqual({ status: "unsubscribed" });
    expect((await post("note", { email: "box-c@example.com", consent: "on" })).status).toBe(200);
    expect(await status("box-c@example.com")).toEqual({ status: "subscribed" });
  });

  it("rejects a form field named consent and an unknown mode", () => {
    const bad = structuredClone(cfg);
    bad.forms.note.fields.push({ name: "consent", type: "checkbox", label: "x" });
    expect(() => loadConfig(bad)).toThrow(/reserved for the opt-in box/);
    expect(() => loadConfig({ ...cfg, optIn: { mode: "maybe" } })).toThrow(/optIn.mode/);
  });
});

describe("/go", () => {
  it("redirects to the landing page and keeps the query string", async () => {
    const res = await call("/go?src=flyer&utm_campaign=fall");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?src=flyer&utm_campaign=fall");
    const other = createWorker({ ...structuredClone(config), go: { to: "/backers" } });
    const ctx = createExecutionContext();
    const r2 = await other.fetch(new Request(`${BASE}/go/?src=card`), env, ctx);
    expect(r2.headers.get("location")).toBe("/backers?src=card");
    expect(() => loadConfig({ ...structuredClone(config), go: { to: "https://evil.example" } })).toThrow(/go.to/);
  });
});

describe("legacy unsubscribe links", () => {
  it("accepts links signed by the older system only when LEGACY_UNSUB_SECRET is set", async () => {
    const legacy = "short-old-secret";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(legacy), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("unsub:old@example.com")));
    const t = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await call(`/u?e=old%40example.com&t=${t}`)).status).toBe(400);
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${BASE}/u?e=old%40example.com&t=${t}`), { ...env, LEGACY_UNSUB_SECRET: legacy }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<button");
  });

  it("reads the legacy secret from the binding legacyUnsubSecret names", async () => {
    const legacy = "kept-old-secret";
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(legacy), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("unsub:old@example.com")));
    const t = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const adopted = createWorker({ ...structuredClone(config), legacyUnsubSecret: "UNSUB_SECRET" });
    const ctx = createExecutionContext();
    const res = await adopted.fetch(new Request(`${BASE}/u?e=old%40example.com&t=${t}`), { ...env, UNSUB_SECRET: legacy }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(() => loadConfig({ ...structuredClone(config), legacyUnsubSecret: "not a name" })).toThrow(/legacyUnsubSecret/);
  });
});

describe("radio and checkbox-group fields", () => {
  const cfg = structuredClone(config);
  cfg.forms.backer = {
    title: "Backer",
    steps: [{ title: "About you", intro: "Two minutes." }, { title: "How you'd help" }],
    fields: [
      { name: "email", type: "email", label: "Email", required: true, step: 1 },
      { name: "funded", type: "radio", label: "Funded a film before?", required: true, step: 1, options: ["Yes", "No"] },
      { name: "gives", type: "checkboxes", label: "What you could offer", required: true, step: 2,
        options: [{ value: "money", label: "Money", group: "Money" }, { value: "venue", label: "A venue", group: "Places" }, { value: "van", label: "A van", group: "Things" }] },
    ],
  };
  const w = createWorker(cfg);
  async function post(body, type = "application/json") {
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request(`${BASE}/api/submit/backer`, {
      method: "POST",
      headers: { "content-type": type, ...ORIGIN, "cf-connecting-ip": `192.0.2.${Math.floor(Math.random() * 250)}` },
      body: type === "application/json" ? JSON.stringify({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", ...body }) : body,
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("stores the radio choice and the ticked options as a list, and mails them joined", async () => {
    const res = await post({ email: "group@example.com", funded: "No", gives: ["venue", "money"] });
    expect(res.status).toBe(200);
    const lead = await env.DB.prepare("SELECT fields_json FROM leads WHERE email = 'group@example.com'").first();
    expect(JSON.parse(lead.fields_json)).toMatchObject({ funded: "No", gives: ["venue", "money"] });
    const mail = JSON.parse(outbound.find((o) => o.url.startsWith("https://script.google.com/")).init.body);
    expect(mail.notify.text).toContain("What you could offer: venue, money");
  });

  it("refuses unknown options and an empty required group", async () => {
    const bad = await (await post({ email: "g2@example.com", funded: "Maybe", gives: ["yacht"] })).json();
    expect(bad.fields).toEqual({ funded: "invalid_option", gives: "invalid_option" });
    const empty = await (await post({ email: "g3@example.com", funded: "Yes", gives: [] })).json();
    expect(empty.fields).toEqual({ gives: "required" });
  });

  it("keeps repeated names from a plain form post as a list", async () => {
    const body = new URLSearchParams([["email", "g4@example.com"], ["funded", "Yes"], ["gives", "van"], ["gives", "money"], ["cf-turnstile-response", "XXXX.DUMMY.TOKEN.XXXX"]]);
    const res = await post(body, "application/x-www-form-urlencoded");
    expect(res.status).toBe(303);
    const lead = await env.DB.prepare("SELECT fields_json FROM leads WHERE email = 'g4@example.com'").first();
    expect(JSON.parse(lead.fields_json).gives).toEqual(["van", "money"]);
  });

  it("checks options and step headings in the config", () => {
    expect(() => loadConfig({ ...structuredClone(cfg), forms: { x: { fields: [{ name: "email", type: "email", required: true }, { name: "r", type: "radio" }] } } })).toThrow(/radio needs options/);
    expect(() => loadConfig({ ...structuredClone(cfg), forms: { x: { steps: "one", fields: [{ name: "email", type: "email", required: true }] } } })).toThrow(/steps must be a list/);
  });
});

describe("plain message forms and upload types by extension", () => {
  const cfg = structuredClone(config);
  cfg.forms.contact.consent = "none";
  cfg.forms.contact.file = { types: ["application/pdf", ".fdx"] };
  const w = createWorker(cfg);
  async function post(body) {
    const ctx = createExecutionContext();
    const res = await w.fetch(new Request(`${BASE}/api/submit/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ORIGIN, "cf-connecting-ip": `198.18.0.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", ...body }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("never subscribes on a consent: none form", async () => {
    expect((await post({ name: "Plain", email: "plain@example.com" })).status).toBe(200);
    expect(await env.DB.prepare("SELECT * FROM subscribers WHERE email = 'plain@example.com'").first()).toBeNull();
    const lead = await env.DB.prepare("SELECT consent_text FROM leads WHERE email = 'plain@example.com'").first();
    expect(lead.consent_text).toBe("");
  });

  it("accepts a typeless file by its listed extension and refuses others", async () => {
    const ok = await (await post({ name: "S", email: "fdx@example.com", file_name: "script.fdx", file_size: 1200, file_type: "" })).json();
    expect(ok.ok).toBe(true);
    expect(ok.upload).toBeTruthy();
    const row = await env.DB.prepare("SELECT upload_type FROM leads WHERE email = 'fdx@example.com'").first();
    expect(row.upload_type).toBe("application/octet-stream");
    const bad = await (await post({ name: "S", email: "exe@example.com", file_name: "tool.exe", file_size: 1200, file_type: "" })).json();
    expect(bad.fields.file).toBe("file_type");
  });
});

describe("auto-reply wording", () => {
  it("fills {first_name} and {name} in a form's confirm subject and text", async () => {
    const cfg = structuredClone(config);
    cfg.forms.contact.confirm = { subject: "We got it, {first_name}", text: "Hi {first_name},\n\nThanks, {name}." };
    const w = createWorker(cfg);
    const ctx = createExecutionContext();
    await w.fetch(new Request(`${BASE}/api/submit/contact`, {
      method: "POST",
      headers: { "content-type": "application/json", ...ORIGIN, "cf-connecting-ip": "198.19.0.7" },
      body: JSON.stringify({ "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX", name: "Ada Lovelace", email: "ada@example.com" }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    const payload = JSON.parse(outbound.find((o) => o.url.startsWith("https://script.google.com/")).init.body);
    expect(payload.reply.subject).toBe("We got it, Ada");
    expect(payload.reply.text.startsWith("Hi Ada,\n\nThanks, Ada Lovelace.")).toBe(true);
  });
});
