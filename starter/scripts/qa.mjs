#!/usr/bin/env node
// QA gate (docs/SPEC.md section 8). Fails the build if any check fails.
//
//   npm run build && npm run qa                      local Worker, template-safe content rules
//   npm run qa -- --url https://<preview-url>        a deployed preview (P6)
//   npm run qa -- --url https://<domain> --launch    production (P8): placeholder rules + performance tripwire
//
// Checks: content, layout at 360/768/1280/1920 px, console errors, banned fonts, axe (WCAG 2.2 AA tags),
// page structure, Lighthouse (mobile) accessibility / best practices / SEO = 100 and CLS < 0.1.
// Screenshots and a JSON report go to qa-output/.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { checker, launchBrowser, startLocalSite } from "./lib/local-site.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const LAUNCH = !!opt("launch");
const OUT = "qa-output";
const WIDTHS = [360, 768, 1280, 1920];
const BANNED_FONTS = ["inter", "geist", "space grotesk", "instrument serif"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const designDoc = existsSync("DESIGN.md") ? readFileSync("DESIGN.md", "utf8").toLowerCase() : "";
const { check, results, failed } = checker();
mkdirSync(OUT, { recursive: true });

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : []);
}
const pagePath = (file) => {
  const p = "/" + relative("dist", file).replace(/\\/g, "/").replace(/(index)?\.html$/, "");
  return p.length > 1 ? p.replace(/\/$/, "") : "/";
};
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");

// ---------- 1. Content check (built HTML and source) ----------
const files = htmlFiles("dist");
const pages = files.map(pagePath).filter((p) => p !== "/404");
for (const file of files) {
  const html = readFileSync(file, "utf8");
  const text = textOf(html);
  const where = pagePath(file);
  check(`content ${where}: no TODO, TBD or lorem ipsum`, !/\b(TODO|TBD|FIXME)\b|lorem ipsum/i.test(text));
  if (LAUNCH) {
    check(`content ${where}: no example names or addresses`, !/example\.(com|org|net)|Example Co\b/.test(text));
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || "";
    check(`content ${where}: canonical uses the site's host`, new URL(canonical).host === site.site.canonicalHost, canonical);
  }
}
if (LAUNCH) {
  check("DESIGN.md is locked (not the placeholder)", !designDoc.includes("until then"));
  check("wrangler.jsonc has no placeholders", !/<[a-z0-9-]+>/.test(readFileSync("wrangler.jsonc", "utf8")));
}
// Brand values belong in site.config.json, not in source files.
const srcFiles = (function walk(d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
})("src").filter((f) => /\.(astro|js|ts|css|md)$/.test(f));
const hardcoded = srcFiles.filter((f) => readFileSync(f, "utf8").includes(site.site.name) || readFileSync(f, "utf8").includes(site.site.ownerEmail));
check("no brand values hard-coded in src/", hardcoded.length === 0, hardcoded.join(", "));

// ---------- 2–5. Browser checks ----------
let local, browser, chrome;
try {
  let base = opt("url");
  if (!base || base === true) {
    local = await startLocalSite({ name: "qa", port: 8798 });
    base = local.base;
  }
  base = String(base).replace(/\/$/, "");
  browser = await launchBrowser();

  for (const path of pages) {
    for (const width of WIDTHS) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(e.message));
      const res = await page.goto(base + path, { waitUntil: "load" });
      await page.waitForTimeout(1500); // let Turnstile and late layout settle (Turnstile keeps a connection open, so no networkidle)
      const tag = `${path} @${width}`;
      check(`page ${tag}: loads`, res?.ok(), String(res?.status()));
      const overflow = await page.evaluate(() => {
        const px = document.documentElement.scrollWidth - window.innerWidth;
        // Name the widest offenders, so a failure says what to fix.
        const culprits = px > 0 ? [...document.querySelectorAll("body *")]
          .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
          .slice(0, 3).map((el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "")) : [];
        return { px, culprits };
      });
      check(`page ${tag}: no horizontal scroll`, overflow.px <= 0, overflow.px > 0 ? `${overflow.px}px: ${overflow.culprits.join(", ")}` : "");
      check(`page ${tag}: no console errors`, errors.length === 0, errors.join(" | "));
      const fonts = await page.evaluate(() => [...new Set([...document.querySelectorAll("body, h1, h2, h3, p, a, button, input, label")]
        .map((el) => getComputedStyle(el).fontFamily.split(",")[0].replace(/["']/g, "").trim().toLowerCase()))]);
      const banned = fonts.filter((f) => BANNED_FONTS.includes(f) && !designDoc.includes(f));
      check(`page ${tag}: no banned fonts without a DESIGN.md reason`, banned.length === 0, banned.join(", "));
      await page.screenshot({ path: join(OUT, `${(path.slice(1) || "home").replace(/\//g, "_")}-${width}.png`), fullPage: true });

      if (width === 360 || width === 1280) {
        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        check(`axe ${tag}: no WCAG 2.2 AA violations`, axe.violations.length === 0,
          axe.violations.map((v) => `${v.id} (${v.nodes.length})`).join(", "));
      }
      if (width === 1280) {
        const s = await page.evaluate(() => {
          const levels = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
          let skips = 0;
          levels.forEach((l, i) => i && l > levels[i - 1] + 1 && skips++);
          return {
            mains: document.querySelectorAll("main").length,
            h1s: document.querySelectorAll("h1").length,
            header: !!document.querySelector("header"),
            footer: !!document.querySelector("footer"),
            nav: !!document.querySelector("nav[aria-label]"),
            lang: !!document.documentElement.lang,
            skips,
            firstHeading: levels[0] || 0,
          };
        });
        check(`structure ${path}: one <main>, one <h1>, header, footer, labelled nav, lang`,
          s.mains === 1 && s.h1s === 1 && s.header && s.footer && s.nav && s.lang, JSON.stringify(s));
        check(`structure ${path}: headings start at h1 and never skip a level`, s.firstHeading === 1 && s.skips === 0, JSON.stringify(s));
      }
      await context.close();
    }
  }

  // ---------- 6. Lighthouse (mobile) ----------
  chrome = await chromeLauncher.launch({
    chromePath: process.env.PW_CHROMIUM || process.env.CHROME_PATH || browser.browserType().executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox", ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, "--proxy-bypass-list=localhost;127.0.0.1", "--ignore-certificate-errors"] : [])],
  });
  const scores = {};
  for (const path of pages) {
    const { lhr } = await lighthouse(base + path, {
      port: chrome.port,
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      // A noindex site fails "is-crawlable" by design; it's checked separately below.
      skipAudits: site.site.indexing ? [] : ["is-crawlable"],
    });
    const c = lhr.categories;
    const cls = lhr.audits["cumulative-layout-shift"].numericValue;
    scores[path] = { performance: c.performance.score, accessibility: c.accessibility.score, bestPractices: c["best-practices"].score, seo: c.seo.score, cls };
    const failing = (cat) => Object.values(lhr.audits).filter((a) => cat.auditRefs.some((r) => r.id === a.id && r.weight > 0) && a.score !== null && a.score < 1).map((a) => a.id).join(", ");
    check(`lighthouse ${path}: accessibility 100`, c.accessibility.score === 1, failing(c.accessibility));
    check(`lighthouse ${path}: best practices 100`, c["best-practices"].score === 1, failing(c["best-practices"]));
    check(`lighthouse ${path}: SEO 100`, c.seo.score === 1, failing(c.seo));
    check(`lighthouse ${path}: CLS below 0.1`, cls < 0.1, cls.toFixed(3));
    if (LAUNCH) check(`lighthouse ${path}: performance at least 90 (production tripwire)`, c.performance.score >= 0.9, String(c.performance.score));
  }
  writeFileSync(join(OUT, "lighthouse.json"), JSON.stringify(scores, null, 2));
  if (!site.site.indexing) {
    const r = await fetch(base + "/");
    check("indexing: noindex header present (site chose not to be indexed)", (r.headers.get("x-robots-tag") || "").includes("noindex"));
  }
} catch (e) {
  console.error(e);
  check("QA run completed", false, e.message);
} finally {
  await browser?.close();
  await chrome?.kill();
  local?.stop();
}

writeFileSync(join(OUT, "report.json"), JSON.stringify({ when: new Date().toISOString(), launch: LAUNCH, results }, null, 2));
console.log(failed() ? `\nQA gate FAILED: ${failed()} check(s)` : `\nQA gate passed (${results.length} checks)`);
process.exit(failed() ? 1 : 0);
