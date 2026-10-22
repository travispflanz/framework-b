#!/usr/bin/env node
// End-to-end test of a built site on a local Worker (wrangler dev, local D1 and R2), in a real browser.
// Uses Turnstile's documented test keys and sends no email (mailer settings are left empty).
// Usage: npm run build && npm run test:e2e
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const STATE = ".wrangler/e2e-state";
const CONFIG = ".e2e.wrangler.jsonc";
const site = JSON.parse(readFileSync("site.config.json", "utf8"));

// A local-only copy of wrangler.jsonc with concrete values instead of placeholders.
const wr = JSON.parse(readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^"\n]*$/gm, ""));
wr.d1_databases[0] = { ...wr.d1_databases[0], database_name: "e2e", database_id: "00000000-0000-0000-0000-000000000000" };
wr.r2_buckets[0].bucket_name = "e2e-uploads";
wr.ratelimits[0].namespace_id = "9001";
wr.vars = { ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "e2e" };
writeFileSync(CONFIG, JSON.stringify(wr, null, 2));
rmSync(STATE, { recursive: true, force: true });

const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args, "--config", CONFIG], { encoding: "utf8" });
const sql = (q) => JSON.parse(wrangler("d1", "execute", "DB", "--local", "--persist-to", STATE, "--json", "--command", q))[0].results;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};

wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE);

const dev = spawn("npx", ["wrangler", "dev", "--config", CONFIG, "--port", String(PORT), "--persist-to", STATE,
  "--var", "TURNSTILE_SECRET:1x0000000000000000000000000000000AA",
  "--var", "SIGNING_SECRET:e2e-signing-secret-at-least-32-characters"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
let devLog = "";
dev.stdout.on("data", (d) => (devLog += d));
dev.stderr.on("data", (d) => (devLog += d));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev did not start:\n" + devLog);
}

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
let browser;
try {
  await waitForServer();

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check("health reports D1 ok", health.ok === true);
  const home = await fetch(`${BASE}/`);
  check("static pages carry the site's indexing header", site.site.indexing || home.headers.get("x-robots-tag") === "noindex", home.headers.get("x-robots-tag") || "none");
  check("/admin is closed without Access", (await fetch(`${BASE}/admin`)).status === 403);

  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    proxy: proxy ? { server: proxy, bypass: "localhost,127.0.0.1" } : undefined,
    args: proxy ? ["--ignore-certificate-errors"] : [], // only behind a TLS-inspecting proxy
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto(`${BASE}/contact?utm_source=e2e&utm_medium=test`);
  await page.getByLabel("Your name").fill("E2E Tester");
  await page.getByLabel("Email").fill("e2e@example.com");
  await page.getByLabel("How can we help?").fill("Testing the whole path.");

  const dir = mkdtempSync(join(tmpdir(), "e2e-"));
  const filePath = join(dir, "brief.pdf");
  writeFileSync(filePath, "%PDF-1.4\n% e2e test file\n");
  await page.locator("[data-fb-file]").setInputFiles(filePath);

  // Inline error before anything is sent: clear a required field and submit.
  await page.getByLabel("Your name").fill("");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  check("inline error shows for a missing required field", (await page.locator('[data-fb-error="name"]').textContent()).trim().length > 0);
  await page.getByLabel("Your name").fill("E2E Tester");

  await page.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 30000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(/\/thanks/, { timeout: 30000 });
  check("submit redirects to the thank-you page", new URL(page.url()).pathname === "/thanks" && !page.url().includes("file-failed"), page.url());
  check("no console errors in the browser", consoleErrors.length === 0, consoleErrors.join(" | "));

  const [lead] = sql("SELECT * FROM leads ORDER BY created_at DESC LIMIT 1");
  check("lead saved in D1", lead?.email === "e2e@example.com" && lead?.name === "E2E Tester");
  const attr = JSON.parse(lead?.attribution_json || "{}");
  check("attribution captured", attr.utm_source === "e2e" && attr.landing === "/contact", JSON.stringify(attr));
  check("file stored", lead?.upload_status === "stored" && lead?.upload_key === `${site.site.id}/${lead.id}/brief.pdf`, `${lead?.upload_status} ${lead?.upload_key}`);
  const [sub] = sql("SELECT status FROM subscribers WHERE email = 'e2e@example.com'");
  check("visitor auto-subscribed", sub?.status === "subscribed");
  check("mail failure recorded, not lost", lead?.notified === 0 && /MAILER_URL/.test(lead?.notify_error || ""), lead?.notify_error);

  const obj = wrangler("r2", "object", "get", `e2e-uploads/${lead.upload_key}`, "--local", "--persist-to", STATE, "--pipe");
  check("file bytes in R2 match", obj.includes("% e2e test file"));
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser?.close();
  try { process.kill(-dev.pid, "SIGTERM"); } catch {} // the whole group: npx, wrangler and workerd
  rmSync(CONFIG, { force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
