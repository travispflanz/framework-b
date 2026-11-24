#!/usr/bin/env node
// Sends one real lead, with a file, through a deployed site's first form, in a real browser.
// Works for any form schema: it fills whatever fields the page shows. Use only on sites running
// Turnstile test keys (self-tests and previews); a real widget would block the browser.
// Usage: node scripts/live-lead.mjs --url https://<host> [--out lead.json] [--file-mb <n>]
//   --file-mb   the size of the PDF it sends, in MB (whole or decimal). The default is a few bytes; on a self-test
//               site (host selftest-*, whose forms take 20 MB) it is 15 MB, over the 10 MB default cap.
// With the consent box (optIn.mode "checkbox"), the lead ticks it; when the box is optional, a second lead, with no file,
// leaves it unticked, so the follow-up check can prove that only a ticked box subscribes.
// Writes { id, email, url, file, fileName, fileBytes, fileSha256, consent, unticked } of the saved lead to --out, for a
// follow-up check of the database and the bucket (framework-b scripts/site/verify-lead.mjs). `consent` is
// { box: false } or { box: true, required, label } (the label's text as shown); `unticked` is { id, email } of the
// second lead, or null.
// A local Worker (http://localhost:<port>) also works, for testing this script.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker, consoleErrorText, launchBrowser, ownConsoleError } from "./lib/local-site.mjs";

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
const stamp = Date.now();
const email = `live-selftest+${stamp}@example.com`;
const untickedEmail = `live-selftest+${stamp}-unticked@example.com`;
const VALUES = { tel: "+1 555 0100", url: "https://example.org", number: "1", date: "2026-01-01" };

// A PDF-typed file: the marker line, then random bytes up to the size asked for (random, so nothing on the way can
// shrink it). Its SHA-256 lets the follow-up check prove the stored object is the same, byte for byte.
const MARKER = "%PDF-1.4\n% live self-test file\n";
const fileBytes = Math.max(MARKER.length, Math.round(fileMb * 1024 * 1024));
const body = Buffer.concat([Buffer.from(MARKER), randomBytes(fileBytes - MARKER.length)]);
const fileSha256 = createHash("sha256").update(body).digest("hex");
const size = (n) => (n < 1024 * 1024 ? `${n}-byte` : `${(n / 1024 / 1024).toFixed(1)} MB`);

// Opens the first form (on /contact, else the home page), fills each visible step and moves on until the submit button
// shows. Every checkbox and radio is ticked; the consent box only when `tick` is true.
async function openAndFill(page, { address, tick }) {
  await page.goto(`${base}/contact?utm_source=live-selftest`);
  if (!(await page.locator("form[data-fb-form]").count())) await page.goto(`${base}/?utm_source=live-selftest`);
  const form = page.locator("form[data-fb-form]").first();
  if ((await form.count()) !== 1) return null;
  for (let guard = 0; guard < 10; guard++) {
    for (const el of await form.locator("input:visible, textarea:visible, select:visible").all()) {
      const type = (await el.getAttribute("type")) || (await el.evaluate((e) => e.tagName.toLowerCase()));
      const name = await el.getAttribute("name");
      if (["hidden", "file", "submit", "button"].includes(type) || name === "website") continue;
      if (name === "consent") await el.setChecked(tick);
      else if (type === "checkbox" || type === "radio") await el.check();
      else if (type === "select") await el.selectOption({ index: 1 });
      else if (type === "textarea") await el.fill("Live self-test message.");
      else await el.fill(type === "email" ? address : VALUES[type] || "Live Selftest");
    }
    const next = form.locator("[data-fb-next]:visible");
    if (!(await next.count())) break;
    await next.click();
  }
  return form;
}

// The consent box as the visitor sees it on the last step: { box: false }, or its required flag, label text and state.
async function consentBox(form) {
  const box = form.locator('input[name="consent"]');
  if (!(await box.count())) return { box: false };
  const label = form.locator(`label[for="${await box.getAttribute("id")}"]`);
  return {
    box: true,
    required: await box.evaluate((e) => e.required),
    label: ((await label.count()) ? await label.textContent() : "").replace(/\s+/g, " ").trim(),
    ticked: await box.isChecked(),
  };
}

const { check, failed } = checker();
const browser = await launchBrowser();
let hasFile = false; // read before submitting: the form is gone once the thank-you page loads
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => ownConsoleError(m) && consoleErrors.push(consoleErrorText(m)));

  const form = await openAndFill(page, { address: email, tick: true });
  check("a form is on the page", !!form);
  if (!form) throw new Error("no form on /contact or the home page");
  const { ticked, ...consent } = await consentBox(form);
  if (consent.box) check("the consent box is shown and ticked", ticked && consent.label !== "", consent.label || "no label");
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

  // An optional consent box left unticked: the lead is still saved, but must not subscribe (checked by verify-lead.mjs).
  // A required box can't be sent unticked, so there is no second lead then.
  let unticked = null;
  if (consent.box && !consent.required) {
    const second = await browser.newPage();
    second.on("console", (m) => ownConsoleError(m) && consoleErrors.push(consoleErrorText(m)));
    const form2 = await openAndFill(second, { address: untickedEmail, tick: false });
    const state = form2 ? await consentBox(form2) : { box: false };
    check("a second lead has the consent box unticked", state.box && !state.ticked);
    if (form2 && state.box && !state.ticked) {
      await second.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 30000 });
      // With no file to upload, the page moves to the thank-you page as soon as the answer comes, which discards its
      // body in the browser; the answer is read on its way through instead.
      let sent = null;
      let done;
      const answered = new Promise((resolve) => (done = resolve));
      await second.route("**/api/submit/**", async (route) => {
        const response = await route.fetch();
        sent = await response.json().catch(() => ({}));
        await route.fulfill({ response });
        done();
      });
      await form2.locator('button[type="submit"]').click();
      await Promise.race([answered, new Promise((r) => setTimeout(r, 30000))]);
      check("the server accepted the lead with the box unticked", sent?.ok === true, sent ? JSON.stringify(sent).slice(0, 200) : "no response");
      if (sent?.redirect) await second.waitForURL((u) => u.pathname === new URL(sent.redirect, base).pathname, { timeout: 30000 }).catch(() => {});
      unticked = { id: sent?.id || null, email: untickedEmail };
    }
  }
  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
  writeFileSync(out, JSON.stringify({ id: submit?.id || null, email, url: base, file: hasFile, ...(hasFile ? { fileName: "brief.pdf", fileBytes, fileSha256 } : {}), consent, unticked }, null, 2));
} catch (e) {
  check("live lead run completed", false, e.message);
} finally {
  await browser.close();
}
console.log(failed() ? `\n${failed()} check(s) failed` : "\nLive lead sent");
process.exit(failed() ? 1 : 0);
