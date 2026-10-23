#!/usr/bin/env node
// End-to-end test of a built site on a local Worker (wrangler dev, local D1 and R2), in a real browser.
// Uses Turnstile's documented test keys and sends no email (mailer settings are left empty).
// Usage: npm run build && npm run test:e2e
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { checker, launchBrowser, ownConsoleError, startLocalSite } from "./lib/local-site.mjs";

// The local SQLite file behind CMS_DB: the one holding EmDash's tables.
function findCmsDatabase(state) {
  const dir = join(state, "v3/d1/miniflare-D1DatabaseObject");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite")) {
    const db = new DatabaseSync(join(dir, f), { readOnly: true });
    const hit = db.prepare("SELECT 1 FROM sqlite_master WHERE name = '_emdash_fields'").get();
    db.close();
    if (hit) return join(dir, f);
  }
  return null;
}

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const { check, failed } = checker();
const formId = Object.keys(site.forms)[0];
const form = site.forms[formId];

let local, browser;
try {
  local = await startLocalSite({ name: "e2e" });
  const { base, sql } = local;

  const health = await (await fetch(`${base}/api/health`)).json();
  check("health reports D1 ok", health.ok === true);
  const home = await fetch(`${base}/`);
  check("static pages carry the site's indexing header", site.site.indexing || home.headers.get("x-robots-tag")?.includes("noindex"), home.headers.get("x-robots-tag") || "none");
  check("/admin is closed without Access", (await fetch(`${base}/admin`)).status === 403);

  browser = await launchBrowser();
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => ownConsoleError(m) && consoleErrors.push(m.text()));

  // Find a page that renders this form.
  // The form is on the home page (landing pages) or on /contact.
  await page.goto(`${base}/?utm_source=e2e&utm_medium=test`);
  if (!(await page.locator(`form[data-fb-form="${formId}"]`).count())) await page.goto(`${base}/contact?utm_source=e2e&utm_medium=test`);
  const formEl = page.locator(`form[data-fb-form="${formId}"]`).first();

  const submit = formEl.locator('button[type="submit"]');
  const steps = [...new Set(form.fields.map((f) => f.step || 1))].sort((a, b) => a - b);

  // Inline error before anything is sent: try to move on with the first step empty.
  await (steps.length > 1 ? formEl.locator("[data-fb-next]:visible").click() : submit.click());
  const firstRequired = form.fields.find((f) => f.required && (f.step || 1) === steps[0]);
  check("inline error shows for a missing required field",
    ((await formEl.locator(`[data-fb-error="${firstRequired.name}"]`).textContent()) || "").trim().length > 0);

  // Fill every visible field with a plausible value, step by step.
  const values = { email: "e2e@example.com", name: "E2E Tester", tel: "+1 555 0100", url: "https://example.org", text: "E2E", textarea: "Testing the whole path." };
  for (const [i, step] of steps.entries()) {
    for (const f of form.fields.filter((x) => (x.step || 1) === step && x.type !== "hidden")) {
      const input = formEl.locator(`[name="${f.name}"]`);
      if (f.type === "checkbox") { if (f.required) await input.check(); }
      else if (f.type === "select") await input.selectOption({ index: 1 });
      else await input.fill(values[f.name] || values[f.type] || "E2E");
    }
    if (i < steps.length - 1) await formEl.locator("[data-fb-next]:visible").click();
  }

  let filePath;
  if (form.file) {
    const dir = mkdtempSync(join(tmpdir(), "e2e-"));
    filePath = join(dir, "brief.pdf");
    writeFileSync(filePath, "%PDF-1.4\n% e2e test file\n");
    await formEl.locator("[data-fb-file]").setInputFiles(filePath);
  }

  await page.waitForFunction(() => document.querySelector('[name="cf-turnstile-response"]')?.value, null, { timeout: 30000 });
  const [submitResponse] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/submit/${formId}`, { timeout: 30000 }),
    submit.click(),
  ]);
  // The status is read rather than the body: the page moves on to the thank-you page straight away.
  const status = submitResponse.status();
  const why = status === 200 ? "" : await submitResponse.text().catch(() => "");
  check("the server accepted the submission", status === 200, `${status} ${why.slice(0, 200)}`.trim());
  await page.waitForURL((u) => u.pathname === form.thanks, { timeout: 30000 });
  check("submit redirects to the thank-you page", !page.url().includes("file-failed"), page.url());
  check("no console errors in the browser", consoleErrors.length === 0, consoleErrors.join(" | "));

  const [lead] = sql("SELECT * FROM leads ORDER BY created_at DESC LIMIT 1");
  check("lead saved in D1", lead?.email === "e2e@example.com" && lead?.form === formId);
  const attr = JSON.parse(lead?.attribution_json || "{}");
  check("attribution captured", attr.utm_source === "e2e" && !!attr.landing, JSON.stringify(attr));
  const [sub] = sql("SELECT status FROM subscribers WHERE email = 'e2e@example.com'");
  check("visitor auto-subscribed", sub?.status === "subscribed");
  if (site.email.notify !== "none") check("mail failure recorded, not lost", lead?.notified === 0 && !!lead?.notify_error, lead?.notify_error);
  if (filePath) {
    check("file stored", lead?.upload_status === "stored" && lead?.upload_key === `${site.site.id}/${lead.id}/brief.pdf`, `${lead?.upload_status} ${lead?.upload_key}`);
    check("file bytes in R2 match", local.r2get(lead.upload_key).includes("% e2e test file"));
  }

  // Client editing on: EmDash serves its admin and the home page, and content an editor publishes reaches the page.
  if (local.editing) {
    const admin = await fetch(`${base}/_emdash/admin`, { redirect: "manual" });
    check("EmDash admin answers (setup or login)", [302, 303].includes(admin.status), `${admin.status} ${admin.headers.get("location") || ""}`);
    check("home page renders through EmDash", (await fetch(`${base}/`)).status === 200);
    const cms = findCmsDatabase(local.state);
    check("EmDash created its tables in its own database", !!cms);
    if (cms) {
      const seed = JSON.parse(readFileSync("seed/seed.json", "utf8"));
      seed.content.pages[0].data.sections[0].headline = "Edited through EmDash";
      const seedPath = join(mkdtempSync(join(tmpdir(), "e2e-seed-")), "seed.json");
      writeFileSync(seedPath, JSON.stringify(seed));
      execFileSync("npx", ["emdash", "seed", "-d", cms, seedPath, "--skip-media"], { stdio: "ignore" });
      const html = await (await fetch(`${base}/`)).text();
      check("published EmDash content shows on the home page", html.includes("Edited through EmDash"));
    }
  }
} catch (e) {
  console.error(e);
  check("e2e run completed", false, e.message);
} finally {
  await browser?.close();
  local?.stop();
}
console.log(failed() ? `\n${failed()} check(s) failed` : "\nAll checks passed");
process.exit(failed() ? 1 : 0);
