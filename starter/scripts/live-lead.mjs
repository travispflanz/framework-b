#!/usr/bin/env node
// Sends one real lead, with a small file, through a deployed site's first form, in a real browser.
// Works for any form schema: it fills whatever fields the page shows. Use only on sites running
// Turnstile test keys (self-tests and previews); a real widget would block the browser.
// Usage: node scripts/live-lead.mjs --url https://<host> [--out lead.json]
// Writes { id, email, url } of the saved lead to --out, for a follow-up check of the database.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker, launchBrowser } from "./lib/local-site.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = (arg("url") || "").replace(/\/$/, "");
if (!/^https:\/\//.test(base)) throw new Error("--url https://<host> is required");
const out = arg("out") || "live-lead.json";
const email = `live-selftest+${Date.now()}@example.com`;
const VALUES = { email, tel: "+1 555 0100", url: "https://example.org", number: "1", date: "2026-01-01" };

const { check, failed } = checker();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));

  await page.goto(`${base}/contact?utm_source=live-selftest`);
  if (!(await page.locator("form[data-fb-form]").count())) await page.goto(`${base}/?utm_source=live-selftest`);
  const form = page.locator("form[data-fb-form]").first();
  check("a form is on the page", (await form.count()) === 1);

  // Fill the visible step, move on, repeat until the submit button shows.
  for (let guard = 0; guard < 10; guard++) {
    for (const el of await form.locator("input:visible, textarea:visible, select:visible").all()) {
      const type = (await el.getAttribute("type")) || (await el.evaluate((e) => e.tagName.toLowerCase()));
      if (["hidden", "file", "submit", "button"].includes(type) || (await el.getAttribute("name")) === "website") continue;
      if (type === "checkbox" || type === "radio") await el.check();
      else if (type === "select") await el.selectOption({ index: 1 });
      else if (type === "textarea") await el.fill("Live self-test message.");
      else await el.fill(VALUES[type] || "Live Selftest");
    }
    const next = form.locator("[data-fb-next]:visible");
    if (!(await next.count())) break;
    await next.click();
  }
  const fileInput = form.locator("[data-fb-file]");
  if (await fileInput.count()) {
    const dir = mkdtempSync(join(tmpdir(), "live-lead-"));
    writeFileSync(join(dir, "brief.pdf"), "%PDF-1.4\n% live self-test file\n");
    await fileInput.setInputFiles(join(dir, "brief.pdf"));
  }
  await page.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 30000 });
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/api/submit/"), { timeout: 30000 }),
    form.locator('button[type="submit"]').click(),
  ]);
  const submit = await response.json().catch(() => ({}));
  if (submit?.redirect) {
    const target = new URL(submit.redirect, base).pathname;
    await page.waitForURL((u) => u.pathname === target, { timeout: 60000 }).catch(() => {}); // the upload runs first
  }
  check("the server accepted the lead", submit?.ok === true, submit ? JSON.stringify(submit).slice(0, 200) : "no response");
  check("the visitor lands on the thank-you page", !!submit?.redirect && page.url().includes(submit.redirect) && !page.url().includes("file-failed"), page.url());
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  writeFileSync(out, JSON.stringify({ id: submit?.id || null, email, url: base, file: (await fileInput.count()) > 0 }, null, 2));
} catch (e) {
  check("live lead run completed", false, e.message);
} finally {
  await browser.close();
}
console.log(failed() ? `\n${failed()} check(s) failed` : "\nLive lead sent");
process.exit(failed() ? 1 : 0);
