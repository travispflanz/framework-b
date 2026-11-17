#!/usr/bin/env node
// Sends one real lead, with a file, through a deployed site's first form, in a real browser.
// Works for any form schema: it fills whatever fields the page shows. Use only on sites running
// Turnstile test keys (self-tests and previews); a real widget would block the browser.
// Usage: node scripts/live-lead.mjs --url https://<host> [--out lead.json] [--file-mb <MiB>]
//   --file-mb  send a generated file of this many MiB (1,048,576 bytes, the unit of a form's file.maxBytes; decimals
//              allowed) instead of the small default one. Its bytes are deterministic for a given size: a short PDF
//              header, then SHA-256 blocks of a fixed seed, so any run can rebuild and compare them.
// Writes { id, email, url, file, fileName, fileBytes, fileSha256, sentAt } of the saved lead to --out, for a follow-up
// check of the database and the stored file (scripts/site/verify-lead.mjs in framework-b).
// --url may also be http://localhost or http://127.0.0.1, to try it against a local Worker (wrangler dev).
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checker, launchBrowser, ownConsoleError } from "./lib/local-site.mjs";

const MIB = 1024 * 1024;
const MARKER = "%PDF-1.4\n% live self-test file\n";

// The small default file, or `bytes` of deterministic content that starts with the same marker.
export function selftestFile(bytes) {
  if (!bytes) return Buffer.from(MARKER);
  const buf = Buffer.alloc(bytes);
  let offset = Buffer.from(MARKER).copy(buf, 0);
  for (let i = 0; offset < bytes; i++) {
    offset += createHash("sha256").update(`framework-b live self-test:${i}`).digest().copy(buf, offset);
  }
  return buf;
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const base = (arg("url") || "").replace(/\/$/, "");
  if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$)/.test(base)) throw new Error("--url https://<host> is required");
  const out = arg("out") || "live-lead.json";
  const fileMb = arg("file-mb");
  if (fileMb !== undefined && !(Number(fileMb) > 0)) throw new Error("--file-mb must be a positive number of MiB");
  const fileBytes = fileMb ? Math.round(Number(fileMb) * MIB) : 0;
  const email = `live-selftest+${Date.now()}@example.com`;
  const VALUES = { email, tel: "+1 555 0100", url: "https://example.org", number: "1", date: "2026-01-01" };

  const { check, failed } = checker();
  const browser = await launchBrowser();
  let file = null; // read before submitting: the form is gone once the thank-you page loads
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (m) => ownConsoleError(m) && consoleErrors.push(m.text()));
    let uploadStatus = null;
    page.on("response", (r) => {
      if (r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/upload/")) uploadStatus = r.status();
    });

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
    if (fileBytes) check("the form has a file field", (await fileInput.count()) > 0);
    if (await fileInput.count()) {
      const body = selftestFile(fileBytes);
      const name = fileBytes ? `selftest-${fileMb}mb.pdf` : "brief.pdf";
      const cap = Number(await fileInput.getAttribute("data-max-bytes"));
      if (fileBytes) check("the file fits the form's cap", body.length <= cap, `${body.length} bytes, cap ${cap}`);
      const dir = mkdtempSync(join(tmpdir(), "live-lead-"));
      writeFileSync(join(dir, name), body);
      await fileInput.setInputFiles(join(dir, name));
      file = { name, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") };
    }
    await page.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 30000 });
    const sentAt = new Date().toISOString();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname.startsWith("/api/submit/"), { timeout: 30000 }),
      form.locator('button[type="submit"]').click(),
    ]);
    const submit = await response.json().catch(() => ({}));
    if (submit?.redirect) {
      const target = new URL(submit.redirect, base).pathname;
      // The upload runs first: a minute, plus 10 s a MiB for a large file.
      await page.waitForURL((u) => u.pathname === target, { timeout: 60000 + Math.ceil(fileBytes / MIB) * 10000 }).catch(() => {});
    }
    check("the server accepted the lead", submit?.ok === true, submit ? JSON.stringify(submit).slice(0, 200) : "no response");
    if (file) check("the upload was accepted", uploadStatus === 200, `PUT /api/upload answered ${uploadStatus ?? "nothing"}`);
    check("the visitor lands on the thank-you page", !!submit?.redirect && page.url().includes(submit.redirect) && !page.url().includes("file-failed"), page.url());
    check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
    writeFileSync(out, JSON.stringify({
      id: submit?.id || null, email, url: base, file: !!file,
      fileName: file?.name ?? null, fileBytes: file?.bytes ?? null, fileSha256: file?.sha256 ?? null, sentAt,
    }, null, 2));
    if (file) console.log(`File: ${file.name}, ${file.bytes} bytes, sha256 ${file.sha256}`);
  } catch (e) {
    check("live lead run completed", false, e.message);
  } finally {
    await browser.close();
  }
  console.log(failed() ? `\n${failed()} check(s) failed` : "\nLive lead sent");
  process.exit(failed() ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
