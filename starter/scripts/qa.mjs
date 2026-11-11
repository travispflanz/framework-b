#!/usr/bin/env node
// QA gate (docs/SPEC.md section 8). Fails the build if any check fails.
//
//   npm run build && npm run qa                      local Worker, template-safe content rules
//   npm run qa -- --url https://<preview-url>        a deployed preview (P6)
//   npm run qa -- --url https://<domain> --launch    production (P8): placeholder rules + performance tripwire
//
// Checks: content, layout at 360/768/1280/1920 px, console errors, banned fonts, axe (WCAG 2.2 AA tags),
// page structure, text over images (contrast against the picture behind it, at 360 and 1280 px), one design language
// (every page title in the home page's treatment, no bare photo banner, pictures at the home page's rhythm, every
// section balanced about the centre, a focal point on every heavy crop, a logo as tall as the buttons;
// scripts/lib/cohesion.mjs), Lighthouse (mobile)
// accessibility / best practices / SEO = 100 and CLS < 0.1.
// Screenshots, the site sheets (site-sheet-1280.png, site-sheet-360.png: the first screen of every page), the crop
// sheets (crop-sheet-1280.png, crop-sheet-360.png: every cropped picture, with the part that shows outlined) and a JSON
// report go to qa-output/. `--mixed-pages` turns the title and rhythm checks into notes, for a test site whose pages mix hero
// layouts on purpose (scripts/test/variants.mjs).
//
// Previews sit behind Cloudflare Access. With ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET set (an Access service
// token with a Service Auth policy on the site's previews application), every request to the URL's own host
// carries the token headers. Requests to any other host (the Turnstile script, for example) never do.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import puppeteer from "puppeteer-core";
import { checker, launchBrowser, ownConsoleError, startLocalSite } from "./lib/local-site.mjs";
import { accessAuth } from "./lib/access-auth.mjs";
import { measureImageText } from "./lib/image-text.mjs";
import { balance, bareBanners, cropSheet, crops, logoFit, pictureRhythm, rhythmBreaks, siteSheet, titleMismatches, titleStyle } from "./lib/cohesion.mjs";
import { unwritten } from "./lib/style-guide.mjs";
import { readInputs, STAMP, staleInputs } from "./lib/style-guide-stamp.mjs";
import { FILE as RESEARCH, unwrittenLenses } from "./lib/design-research.mjs";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const LAUNCH = !!opt("launch");
const MIXED = !!opt("mixed-pages");
const OUT = "qa-output";
const WIDTHS = [360, 768, 1280, 1920];
const BANNED_FONTS = ["inter", "geist", "space grotesk", "instrument serif"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const site = JSON.parse(readFileSync("site.config.json", "utf8"));
const designDoc = existsSync("DESIGN.md") ? readFileSync("DESIGN.md", "utf8").toLowerCase() : "";
// Composition from DESIGN.md (scripts/design-tokens.mjs writes it): the phone budget and the motion level.
const composition = existsSync("src/styles/design.json") ? JSON.parse(readFileSync("src/styles/design.json", "utf8")).composition : { phoneBudget: 6, motion: "none" };
const { check, results, failed } = checker();
mkdirSync(OUT, { recursive: true });

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : []);
}
const pagePath = (file) => {
  const p = "/" + relative(DIST, file).replace(/\\/g, "/").replace(/(index)?\.html$/, "");
  return p.length > 1 ? p.replace(/\/$/, "") : "/";
};
const textOf = (html) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");

// ---------- 1. Content check (built HTML and source) ----------
// Static builds put pages in dist/; with client editing on, prerendered pages are in dist/client/ and the pages that
// read their content through src/lib/page-content.js (the home page, every src/content page, privacy and contact) are
// rendered on request, so they are added to the browser checks by hand.
const DIST = existsSync("dist/client") ? "dist/client" : "dist";
const files = htmlFiles(DIST);
const contentSlugs = existsSync("src/content") ? readdirSync("src/content").filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [];
const onRequest = DIST === "dist/client" ? ["/", "/privacy", "/contact", ...contentSlugs.filter((s) => !["home", "privacy", "not-found", "contact"].includes(s)).map((s) => `/${s}`)] : [];
const pages = [...new Set([...onRequest, ...files.map(pagePath)])].filter((p) => p !== "/404");
if (onRequest.length) {
  const sourceText = contentSlugs.map((s) => JSON.stringify(JSON.parse(readFileSync(join("src/content", `${s}.json`), "utf8")))).join(" ");
  check("content src/content: no TODO, TBD or lorem ipsum", !/\b(TODO|TBD|FIXME)\b|lorem ipsum/i.test(sourceText));
}
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
// Design contract: DESIGN.md lints clean and tokens.css is generated from it; page content matches the section schema.
const runs = (cmd) => {
  try {
    return { ok: true, out: execFileSync("node", cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}`.trim().split("\n").slice(-3).join(" | ") };
  }
};
if (existsSync("scripts/design-tokens.mjs")) {
  const r = runs(["scripts/design-tokens.mjs", "--check"]);
  check("design: DESIGN.md lints clean, meets contrast, and tokens.css is generated from it", r.ok, r.ok ? "" : r.out);
}
if (existsSync("scripts/check-content.mjs") && existsSync("src/content")) {
  const r = runs(["scripts/check-content.mjs"]);
  check("content: page sections match the section schema", r.ok, r.ok ? "" : r.out);
}
// The style guide (SPEC section 12): rendered from DESIGN.md, STYLE-GUIDE.md and the logo (design/brand/logo.json).
// Once it has been rendered, a guide older than any of them fails, so it stays the description of the site as it is.
// Design research (SPEC section 12, "Four lenses"): a note until every lens is written.
if (existsSync(RESEARCH)) {
  const todo = unwrittenLenses(readFileSync(RESEARCH, "utf8"));
  if (todo.length) console.log(`  note  design research: not written yet: ${todo.join(", ")} (${RESEARCH})`);
}
// The logo kit (SPEC section 12, "Logo"): every file scripts/logo.mjs pick lists in design/brand/logo.json is there.
if (existsSync("design/brand/logo.json")) {
  const kit = JSON.parse(readFileSync("design/brand/logo.json", "utf8"));
  const files = [...Object.values(kit.versions || {}).map((v) => v.file), kit.mark, "/logo.svg", "/favicon.svg", "/favicon-96.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/og.png"].filter(Boolean);
  const missing = files.filter((f) => !existsSync(join("public", f)));
  check(`logo: the kit for concept "${kit.concept}" is complete`, missing.length === 0, missing.length ? `missing ${missing.join(", ")}; run node scripts/logo.mjs pick ${kit.concept}` : "");
}
if (existsSync("STYLE-GUIDE.md")) {
  const stamp = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, "utf8")) : null;
  const todo = unwritten(readFileSync("STYLE-GUIDE.md", "utf8"));
  if (!stamp) console.log("  note  style guide: not rendered yet (write STYLE-GUIDE.md, then node scripts/style-guide.mjs; docs/BUILD.md step 3)");
  else {
    const changed = staleInputs(stamp, readInputs());
    check("style guide: rendered from the current DESIGN.md, STYLE-GUIDE.md and logo", changed.length === 0, changed.length ? `${changed.join(" and ")} changed since; run node scripts/style-guide.mjs` : "");
    if (todo.length) console.log(`  note  style guide: unwritten sections: ${todo.join(", ")}`);
  }
}

// Copy rules, over the built pages and the page content (which, with editing on, isn't in the static build).
// Truth gate: nothing that reads as reviews, ratings, counts of customers or "trusted by" without an owner
// source (docs/SPEC.md section 12). A source is recorded in PRODUCT.md under "Evidence on hand"; then the
// matching phrase can be listed there under "Approved claims" to pass.
const contentText = existsSync("src/content")
  ? readdirSync("src/content").filter((f) => f.endsWith(".json")).map((f) => JSON.stringify(JSON.parse(readFileSync(join("src/content", f), "utf8")))).join(" ")
  : "";
const copy = `${files.map((f) => textOf(readFileSync(f, "utf8"))).join(" ")} ${contentText}`;
const approved = (existsSync("PRODUCT.md") ? readFileSync("PRODUCT.md", "utf8").split(/##\s+Approved claims/i)[1] || "" : "").toLowerCase();
const PROOF = [/\b\d[\d,]*\+?\s*(happy\s+)?(customers|clients|homes|households|reviews|five-star)\b/i, /\b(5|five)[- ]star\b/i, /★/, /\brated\s+\d/i, /\btrusted by\b/i, /\btestimonials?\b/i, /\b\d{2,3}(\.\d+)?%\s/];
const proofHits = PROOF.map((re) => copy.match(re)?.[0]).filter((m) => m && !approved.includes(m.toLowerCase()));
check("truth gate: no reviews, ratings, customer counts or percentages without an owner source", proofHits.length === 0, proofHits.join(" | "));
const TELLS = ["delve", "tapestry", "testament", "pivotal", "underscore", "landscape", "foster", "crucial", "empower", "unlock", "transform", "seamless", "elevate", "game-changer", "revolutionize", "cutting-edge", "in today's"];
// The owner's own words (an adopted site's existing copy) may use one of these: list each phrase, verbatim, under
// "## Owner's wording" in PRODUCT.md and the lint skips it.
const product = existsSync("PRODUCT.md") ? readFileSync("PRODUCT.md", "utf8") : "";
const ownerWording = (product.split(/##\s+Owner's wording/i)[1] || "").split(/\n##\s/)[0].split("\n").map((l) => l.match(/^\s*-\s+"?(.+?)"?\s*$/)?.[1]).filter(Boolean);
const lintCopy = ownerWording.reduce((text, phrase) => text.split(phrase).join(" "), copy);
const tellHits = TELLS.filter((w) => new RegExp(`\\b${w}`, "i").test(lintCopy));
check("copy lint: none of the generic AI words", tellHits.length === 0, tellHits.join(", "));

// Impeccable's deterministic detector (62 rules: AI-design tells, type, colour, layout, motion, quality), on the
// source here and on each rendered page below. It reads DESIGN.md, so fonts and colours outside the design
// contract are findings too. A deliberate exception is recorded with a reason in .impeccable/config.json:
// `npx impeccable ignores add-value <rule> <value> --reason "..."` (https://www.impeccable.style/docs/config,
// checked 2026-10-26). Exit 0 = clean, 2 = findings, 1 = couldn't scan.
const IMPECCABLE = "node_modules/.bin/impeccable";
// Async on purpose: the CDP header injection for previews runs in this process and must keep answering.
const impeccable = (args) => new Promise((done) => {
  const child = spawn(IMPECCABLE, ["detect", "--json", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", (e) => done({ status: 1, findings: [], blocking: [], ok: false, err: e.message }));
  child.on("close", (status) => {
    let findings = [];
    try {
      findings = JSON.parse(out || "[]");
    } catch {}
    // Advisories never fail on their own, except the design-system ones: a colour, radius or font size outside
    // DESIGN.md breaks the design contract (Impeccable reports those two as advisories; tested 2026-10-26).
    const blocking = findings.filter((f) => f.severity !== "advisory" || CONTRACT_RULES.has(f.antipattern));
    done({ status, findings, blocking, ok: status !== 1 && blocking.length === 0, err: err.trim().split("\n").slice(-2).join(" | ") });
  });
});
const CONTRACT_RULES = new Set(["design-system-color", "design-system-radius", "design-system-font-size", "design-system-font"]);
const findingsText = (r) => r.status === 1 ? `couldn't scan: ${r.err}`
  : [...new Set(r.blocking.map((f) => `${f.antipattern}${f.snippet ? ` (${String(f.snippet).slice(0, 70)})` : ""}`))].slice(0, 6).join("; ");
const hasImpeccable = existsSync(IMPECCABLE);
if (hasImpeccable) {
  const r = await impeccable(["src/"]);
  check("impeccable (source): no design anti-patterns, nothing outside DESIGN.md", r.ok, r.ok ? "" : findingsText(r));
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
  const auth = accessAuth(base);
  if (auth.on) {
    const r = await auth.fetch(base + "/api/health", { redirect: "manual" });
    check("access: the service token opens the protected URL", r.status === 200, `HTTP ${r.status}`);
    if (r.status !== 200) throw new Error(`the Access service token was refused (HTTP ${r.status}); check the Service Auth policy on the previews application`);
  }
  // The first request to a fresh client-editing site's home page sets up EmDash's content database and can take
  // longer than a page load's 30 s (the live self-test timed out on it on 2026-11-11; the preview check already
  // waited for it). One fetch first, allowed two minutes, so the browser checks see the site as visitors will.
  if (opt("url") && opt("url") !== true) {
    const t0 = Date.now();
    try {
      const r = await auth.fetch(base + "/", { redirect: "manual", signal: AbortSignal.timeout(120_000) });
      await r.arrayBuffer();
      if (Date.now() - t0 > 10_000) console.log(`note  the first request to / took ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      console.log(`note  no first response from / within 2 minutes (${e.name}); the page checks will say more`);
    }
  }
  browser = await launchBrowser();

  const titles = {};
  const rhythm = {};
  const cropped = { 360: [], 1280: [] };
  for (const path of pages) {
    for (const width of WIDTHS) {
      // Reduced motion: checks and screenshots see every element in its final state, whatever the scroll position
      // (scroll-driven reveals start transparent below the fold). Motion itself is checked separately below.
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      await auth.playwright(context);
      const page = await context.newPage();
      const errors = [];
      page.on("console", (m) => ownConsoleError(m) && errors.push(m.text()));
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
      // Lazy images below the fold load only when scrolled to; load them all so the full-page screenshot (used by the
      // critique rounds and by people reviewing) shows every image.
      // decode() settles once a picture is loaded and ready to paint; waiting for "load" alone left the photo panels
      // below the fold empty in the full-page screenshot (mean brightness 8 against 121 with decode(), first adopted
      // site, 2026-11-04).
      await page.evaluate(async () => {
        document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = "eager"; });
        await Promise.all([...document.images].map((img) => Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 8000))])));
      });
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
        // Photos in a card set (SPEC section 12): where some cards in a list carry a photo, most (more than half) do; a
        // type-only card is an accent, not where the photos ran out. Lists of fewer than three are left alone.
        const sets = await page.evaluate(() => [...document.querySelectorAll("main ul, main ol")].map((list) => {
          const items = [...list.children].filter((li) => li.tagName === "LI" && li.getClientRects().length);
          const pic = (li) => [...li.querySelectorAll("img")].some((img) => { const r = img.getBoundingClientRect(); return r.width >= 64 && r.height >= 64; });
          return { name: list.closest("section")?.querySelector("h1, h2")?.textContent.trim().slice(0, 40) || "a list", items: items.length, withPhoto: items.filter(pic).length };
        }).filter((x) => x.items >= 3 && x.withPhoto > 0));
        const thin = sets.filter((x) => x.withPhoto * 2 <= x.items);
        check(`photos ${path}: card sets with photos have them on most cards`, thin.length === 0, thin.map((x) => `"${x.name}" ${x.withPhoto} of ${x.items}`).join("; "));
        // A design runs through every page: a content page with no picture at all is listed (not yet a failure).
        const pictures = await page.evaluate(() => [...document.querySelectorAll("main img")].filter((i) => i.getBoundingClientRect().width >= 64).length
          + [...document.querySelectorAll("main *")].filter((e) => /url\(/.test(getComputedStyle(e).backgroundImage)).length);
        if (!pictures && !/^\/(thanks|privacy|credits|404|not-found)/.test(path)) console.log(`  note  page ${path}: no pictures yet; the design runs through every page (docs/BUILD.md step 3)`);
        // One design language (SPEC section 12): the title's treatment, compared across pages after the loop, and no
        // bare photo banner (a wide photo goes with the title or with text beside it).
        titles[path] = await titleStyle(page);
        rhythm[path] = await pictureRhythm(page);
        const banners = await bareBanners(page);
        check(`layout ${path}: no bare photo banner (a wide photo carries text or sits beside it)`, banners.length === 0, banners.join("; "));
        // Balance (SPEC section 12): no section leaves one side of the page empty.
        const lopsided = (await balance(page)).filter((b) => !b.ok);
        check(`layout ${path}: every section is balanced about the centre (neither side left empty)`, lopsided.length === 0,
          lopsided.map((b) => `"${b.name}" ${Math.round(b.share * 100)}% of the weight on the ${b.empty}, reaching ${Math.round(b.reach * 100)}% across it, from ${b.at}px down`).join("; "));
      }
      if (width === 360 || width === 1280) {
        // Crops (SPEC section 12): a crop that cuts a third or more off a picture names its focal point on that axis.
        const found = await crops(page);
        cropped[width].push(...found.map((c) => ({ ...c, path })));
        const unset = found.filter((c) => c.needs.length);
        check(`crops ${tag}: every picture cropped by a third or more has a focal point on that axis`, unset.length === 0,
          unset.map((c) => `${c.src} shows ${Math.round(c.shows[0] * 100)}%×${Math.round(c.shows[1] * 100)}%, set ${c.needs.join(" and ")}`).join("; "));
        // The logo is at least as tall as the buttons beside it (or in the phone bar).
        const fit = await logoFit(page);
        if (fit) check(`logo ${tag}: the header logo is as tall as the tallest button (composition.logo in DESIGN.md)`, fit.logo + 0.5 >= fit.tallest,
          `logo ${fit.logo}px, "${fit.label}" ${fit.tallest}px`);
      }
      // Text over a photo or gradient, measured against the picture (axe and Lighthouse can't see it). Last on the
      // page: it leaves the text transparent. scripts/lib/image-text.mjs has the method and its sources.
      if (width === 360 || width === 1280) {
        const scratch = await context.newPage();
        const rows = await measureImageText(page, scratch);
        writeFileSync(join(OUT, `image-text-${(path.slice(1) || "home").replace(/\//g, "_")}-${width}.json`), JSON.stringify(rows, null, 2));
        const bad = rows.filter((r) => !r.ok);
        check(`image text ${tag}: text over pictures meets WCAG contrast against the worst part of the picture behind it`, bad.length === 0,
          bad.length ? bad.slice(0, 4).map((r) => `"${r.text.slice(0, 30)}" ${r.ratio}:1, needs ${r.needs}:1`).join("; ") : `${rows.length} over pictures${rows.length ? `, lowest ${rows[0].ratio}:1` : ""}`);
      }
      await context.close();
    }
  }

  // ---------- 5a. One design language ----------
  // Every page title in the home page's treatment (face, weight, case, alignment; the home page may be bigger), and
  // the site sheets: the first screen of every page in one picture, which the agent and the owner review together.
  const mismatch = titleMismatches(titles, "/");
  if (MIXED) for (const m of mismatch) console.log(`  note  title ${m}`);
  else check("design: every page title has the home page's treatment (face, weight, case, alignment)", mismatch.length === 0, mismatch.join("; "));
  if (!composition.heroes) console.log("  note  design: composition.heroes isn't set in DESIGN.md, so the hero of a page added later isn't fixed (docs/BUILD.md step 3)");
  // Page flow: the home page sets how often a picture comes; no page with pictures runs much longer without one.
  const breaks = rhythmBreaks(rhythm, "/");
  if (MIXED) for (const b of breaks) console.log(`  note  rhythm ${b}`);
  else check("design: no page runs longer without a picture than the home page (plus half a screen)", breaks.length === 0, breaks.join("; "));
  for (const [width, screen] of [[1280, 900], [360, 780]]) {
    const file = await siteSheet({ out: OUT, pages: [...pages].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b))), width, screen, file: join(OUT, `site-sheet-${width}.png`) });
    if (file) console.log(`  sheet ${file}: the first screen of every page, to review the site as a whole`);
    // The crop sheet: every cropped picture with the part that shows outlined, to check each subject is in its frame.
    const crop = await cropSheet({ items: cropped[width], file: join(OUT, `crop-sheet-${width}.png`) });
    if (crop) console.log(`  sheet ${crop}: every cropped picture at ${width} px, to check each subject is in the frame`);
    writeFileSync(join(OUT, `crops-${width}.json`), JSON.stringify(cropped[width].map(({ data, ...c }) => c), null, 2));
  }

  // ---------- 5b. Phones: length budget and section heights ----------
  // The home page on a 390 x 844 phone may be at most composition.phoneBudget screens long (DESIGN.md); long
  // sections are listed so the agent can fold, hide or swipe them (each section's `phone` field), or the owner can
  // trade length for content. Every sideways strip must have its swipe cue (SwipeCue.astro), and each is listed.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce", isMobile: true, hasTouch: true });
    await auth.playwright(context);
    const page = await context.newPage();
    await page.goto(base + "/", { waitUntil: "load" });
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      sections: [...document.querySelectorAll("main section")].filter((el) => !el.parentElement.closest("section")).map((el) => ({
        name: el.querySelector("h1, h2")?.textContent.trim().slice(0, 40) || el.id || "section",
        height: Math.round(el.getBoundingClientRect().height),
      })),
      actionBar: !!document.querySelector("body > div.fixed.bottom-0 a"),
      // Links and buttons on the first screen that the fixed bar cuts in half (one showing above it, the rest under).
      cutByBar: (() => {
        const bar = document.querySelector("body > div.fixed.bottom-0");
        if (!bar) return [];
        const top = bar.getBoundingClientRect().top;
        return [...document.querySelectorAll("main a, main button")].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden")
          .filter((e) => { const r = e.getBoundingClientRect(); return r.top < top - 1 && r.bottom > top + 1; }).map((e) => e.textContent.trim().slice(0, 30));
      })(),
      // Sideways strips that really scroll here, and whether each has its swipe cue right after it.
      strips: [...document.querySelectorAll('[data-phone="swipe"], .strip')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => ({
        name: el.closest("section")?.querySelector("h1, h2")?.textContent.trim().slice(0, 40) || "section",
        cue: !!el.nextElementSibling?.classList.contains("swipe-cue"),
      })),
      h1Visible: (() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().top < 844; })(),
    }));
    const screens = m.height / 844;
    check(`phone: the home page is at most ${composition.phoneBudget} screens long`, screens <= composition.phoneBudget,
      `${screens.toFixed(1)} screens; longest sections: ${m.sections.sort((a, b) => b.height - a.height).slice(0, 3).map((x) => `${x.name} ${(x.height / 844).toFixed(1)}`).join(", ")}`);
    check("phone: the headline is on the first screen", m.h1Visible);
    if (site.nav.some((item) => item.cta)) check("phone: the main action is in the bar at the bottom of the screen", m.actionBar);
    if (m.actionBar) {
      check("phone: the action bar cuts nothing in half on the first screen", m.cutByBar.length === 0, m.cutByBar.join(", "));
      // At the very end of the page, everything must have scrolled clear of the bar (the page leaves room for it).
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      const under = await page.evaluate(() => {
        const bar = document.querySelector("body > div.fixed.bottom-0");
        const top = bar.getBoundingClientRect().top;
        const out = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim() || bar.contains(n) || !n.parentElement?.getClientRects().length) continue;
          const r = document.createRange();
          r.selectNodeContents(n);
          if ([...r.getClientRects()].some((q) => q.height > 0 && q.bottom > top + 1 && q.top < innerHeight)) out.push(n.textContent.trim().slice(0, 30));
        }
        return out;
      });
      check("phone: the end of the page scrolls clear of the action bar", under.length === 0, under.slice(0, 4).join(", "));
    }
    for (const x of m.sections) if (x.height > 844 * 1.5) console.log(`  note  phone: "${x.name}" is ${(x.height / 844).toFixed(1)} screens; consider its phone setting (collapse, hide, or swipe for a set of like items)`);
    check("phone: every sideways strip has its swipe cue", m.strips.every((x) => x.cue), m.strips.filter((x) => !x.cue).map((x) => x.name).join(", "));
    for (const x of m.strips) console.log(`  note  phone: "${x.name}" swipes sideways; keep that for a set of like items people browse`);
    await context.close();
  }

  // ---------- 5c. Motion: nothing moves for people who ask for reduced motion ----------
  if (composition.motion !== "none") {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    await auth.playwright(context);
    const page = await context.newPage();
    await page.goto(base + "/", { waitUntil: "load" });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
    await page.waitForTimeout(300);
    const running = await page.evaluate(() => document.getAnimations().filter((a) => !String(a.animationName || "").startsWith("turnstile")).length);
    check("motion: no animations run with reduced motion", running === 0, `${running} running`);
    await context.close();
    // The motion the design asks for runs: a minifier once folded `animation-timeline` into the `animation`
    // shorthand, which Chromium drops whole, so the reveal never ran on static builds (2026-11-11). And no
    // scroll-driven animation fades text: on a view() timeline, text at the bottom edge of the screen stays at that
    // frame while the visitor reads, and Lighthouse failed the faded text on contrast.
    const moving = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await auth.playwright(moving);
    const mp = await moving.newPage();
    await mp.goto(base + "/", { waitUntil: "load" });
    const mm = await mp.evaluate(() => {
      const scroll = document.getAnimations().filter((a) => a.timeline && a.timeline.constructor.name !== "DocumentTimeline");
      const fades = scroll.filter((a) => (a.effect?.target?.textContent || "").trim() && a.effect.getKeyframes().some((k) => k.opacity !== undefined && Number(k.opacity) < 1));
      return {
        supported: CSS.supports("animation-timeline", "view()"),
        targets: document.querySelectorAll(".reveal, [data-reveal] > *").length,
        names: [...new Set(scroll.map((a) => a.animationName))],
        fades: [...new Set(fades.map((a) => a.animationName))],
      };
    });
    if (mm.supported && mm.targets) check("motion: the scroll reveal runs (its CSS survived the build)", mm.names.includes("fb-rise"), mm.names.join(", ") || "no scroll-driven animation running");
    check("motion: no scroll-driven animation fades text", mm.fades.length === 0, mm.fades.join(", "));
    await moving.close();
  }

  // ---------- 6. Lighthouse (mobile) ----------
  chrome = await chromeLauncher.launch({
    chromePath: process.env.PW_CHROMIUM || process.env.CHROME_PATH || browser.browserType().executablePath(),
    chromeFlags: ["--headless=new", "--no-sandbox", ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, "--proxy-bypass-list=localhost;127.0.0.1", "--ignore-certificate-errors"] : [])],
  });
  const scores = {};
  const onCanonicalHost = new URL(base).host === site.site.canonicalHost;
  // Lighthouse gets a page we control, so the Access headers can be added to the site's own host only.
  const pptr = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  for (const path of pages) {
    // "is-crawlable" only applies where a page is meant to be indexed: an indexed site, on its canonical host
    // (local runs and previews are noindex by design), on a page that doesn't opt out (thanks, 404).
    const html = await (await auth.fetch(base + path)).text();
    const pageNoindex = /<meta name="robots" content="[^"]*noindex/i.test(html);
    // The canonical URL must be the page's own extensionless address on the canonical host (a ".html" URL
    // redirects, and search engines treat a redirecting canonical as a conflict).
    const canonical = /<link rel="canonical" href="([^"]+)"/i.exec(html)?.[1] || "";
    const expected = new URL(path, `https://${site.site.canonicalHost}`).toString();
    check(`page ${path}: canonical URL is ${expected}`, canonical === expected, canonical || "missing");
    const lhPage = await pptr.newPage();
    await auth.puppeteer(lhPage);
    const runLighthouse = async () => (await lighthouse(base + path, {
      output: "json",
      logLevel: "error",
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      skipAudits: site.site.indexing && onCanonicalHost && !pageNoindex ? [] : ["is-crawlable"],
    }, undefined, lhPage)).lhr;
    let lhr = await runLighthouse();
    // One Lighthouse run's performance score swings widely on a shared machine (0.73 and 0.99 for the same page,
    // minutes apart, 2026-10-27). Lighthouse's own guidance is to judge on the median of several runs: "the median
    // Lighthouse score of 5 runs is twice as stable as 1 run" (github.com/GoogleChrome/lighthouse/blob/main/docs/
    // variability.md, checked 2026-10-27). So when the tripwire would fail, it takes the median of 5 runs. Every
    // other Lighthouse result comes from the first run.
    if (LAUNCH && lhr.categories.performance.score < 0.9) {
      const runs = [lhr.categories.performance];
      for (let i = 0; i < 4; i++) runs.push((await runLighthouse()).categories.performance);
      runs.sort((a, b) => a.score - b.score);
      lhr = { ...lhr, categories: { ...lhr.categories, performance: runs[2] } };
    }
    await lhPage.close();
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

  // ---------- 7. Impeccable on the rendered pages ----------
  // `--cdp` scans a page already open in this browser, so previews behind Access work and the detector never
  // starts a browser of its own. Desktop and phone widths, like the research's G5 gate.
  if (hasImpeccable) {
    let n = 0;
    for (const path of pages) {
      for (const [width, height] of [[1280, 800], [390, 844]]) {
        const marker = `impeccable-scan-${++n}`;
        const page = await pptr.newPage();
        await auth.puppeteer(page);
        await page.setViewport({ width, height });
        await page.goto(`${base}${path}#${marker}`, { waitUntil: "load" });
        await new Promise((r) => setTimeout(r, 1500));
        const r = await impeccable(["--cdp", String(chrome.port), "--target", marker]);
        writeFileSync(join(OUT, `impeccable-${(path.slice(1) || "home").replace(/\//g, "_")}-${width}.json`), JSON.stringify(r.findings, null, 2));
        check(`impeccable ${path} @${width}: no design anti-patterns, nothing outside DESIGN.md`, r.ok, r.ok ? "" : findingsText(r));
        await page.close();
      }
    }
  }
  await pptr.disconnect();
  writeFileSync(join(OUT, "lighthouse.json"), JSON.stringify(scores, null, 2));
  if (!site.site.indexing) {
    const r = await auth.fetch(base + "/");
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
