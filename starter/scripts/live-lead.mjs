#!/usr/bin/env node
// Sends one real lead, with a file, through a deployed site's first form, in a real browser.
// Works for any form schema: it fills whatever fields the page shows. Use only on sites running
// Turnstile test keys (self-tests and previews); a real widget would block the browser.
// Usage: node scripts/live-lead.mjs --url https://<host> [--out lead.json] [--file-mb <n>]
//   --file-mb   the size of the PDF it sends, in MB (whole or decimal). The default is a few bytes; on a self-test
//               site (host selftest-*, whose forms take 20 MB) it is 15 MB, over the 10 MB default cap.
// Writes { id, email, url, file, fileName, fileBytes, fileSha256 } of the saved lead to --out, for a follow-up check
// of the database and the bucket (framework-b scripts/site/verify-lead.mjs).
// A local Worker (http://localhost:<port>) also works, for testing this script.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker, launchBrowser, ownConsoleError } from "./lib/local-site.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const base = (arg("url") || "").replace(/\/$/, "");
if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("--url https://<host> is required");
const out = arg("out") || "live-lead.json";
const selftestSite = new URL(base).hostname.startsWith("selftest-");
const fileMb = arg("file-mb") !== undefined ? Number(arg("file-mb")) : selftestSite ? 15 : 0;
if (!(fileMb >= 0 && fileMb <= 95)) throw new Error("--file-mb must be a number from 0 to 95");
const email = `live-selftest+${Date.now()}@example.com`;
const VALUES = { email, tel: "+1 555 0100", url: "https://example.org", number: "1", date: "2026-01-01" };

// A PDF-typed file: the marker line, then random bytes up to the size asked for (random, so nothing on the way can
// shrink it). Its SHA-256 lets the follow-up check prove the stored object is the same, byte for byte.
const MARKER = "%PDF-1.4\n% live self-test file\n";
const fileBytes = Math.max(MARKER.length, Math.round(fileMb * 1024 * 1024));
const body = Buffer.concat([Buffer.from(MARKER), randomBytes(fileBytes - MARKER.length)]);
const fileSha256 = createHash("sha256").update(body).digest("hex");
const size = (n) => (n < 1024 * 1024 ? `${n}-byte` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const { check, failed } = checker();
const browser = await launchBrowser();
let hasFile = false; // read before submitting: the form is gone once the thank-you page loads
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => ownConsoleError(m) && consoleErrors.push(m.text()));

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
  hasFile = (await fileInput.count()) > 0;
  if (hasFile) {
    const cap = Number(await fileInput.getAttribute("data-max-bytes"));
    if (fileBytes > MARKER.length) check(`the form takes a ${size(fileBytes)} file`, fileBytes <= cap, `its cap is ${size(cap)}`);
    const dir = mkdtempSync(join(tmpdir(), "live-lead-"));
    writeFileSync(join(dir, "brief.pdf"), body);
    await fileInput.setInputFiles(join(dir, "brief.pdf"));
  }
  await page.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 30000 });
  // The upload's own answer, watched from before the submit: the browser PUTs the file once the lead is saved.
  const started = Date.now();
  let putSeconds = 0;
  const put = hasFile
    ? page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/upload/"), { timeout: 180000 })
      .then((r) => ((putSeconds = (Date.now() - started) / 1000), r), () => null)
    : null;
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/api/submit/"), { timeout: 30000 }),
    form.locator('button[type="submit"]').click(),
  ]);
  const submit = await response.json().catch(() => ({}));
  if (submit?.redirect) {
    const target = new URL(submit.redirect, base).pathname;
    await page.waitForURL((u) => u.pathname === target, { timeout: 180000 }).catch(() => {}); // the upload runs first
  }
  check("the server accepted the lead", submit?.ok === true, submit ? JSON.stringify(submit).slice(0, 200) : "no response");
  if (hasFile) {
    const answer = submit?.upload ? await put : null;
    check(`the ${size(fileBytes)} upload was accepted`, answer?.status() === 200, answer ? `HTTP ${answer.status()}, ${putSeconds.toFixed(1)} s after sending` : "no upload request seen");
  }
  check("the visitor lands on the thank-you page", !!submit?.redirect && page.url().includes(submit.redirect) && !page.url().includes("file-failed"), page.url());
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  writeFileSync(out, JSON.stringify({ id: submit?.id || null, email, url: base, file: hasFile, ...(hasFile ? { fileName: "brief.pdf", fileBytes, fileSha256 } : {}) }, null, 2));
} catch (e) {
  check("live lead run completed", false, e.message);
} finally {
  await browser.close();
}
console.log(failed() ? `\n${failed()} check(s) failed` : "\nLive lead sent");
process.exit(failed() ? 1 : 0);
