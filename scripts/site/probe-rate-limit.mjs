#!/usr/bin/env node
// Probes a throwaway self-test site's form rate limit (the Workers rate limiting binding SUBMIT_LIMITER, 5 a minute
// per site and address): sends quick form posts with no Turnstile token, one after another, and counts the answers.
// The limiter runs before Turnstile (packages/core/src/forms.js), so a post either uses up the allowance and is
// refused by Turnstile (403 turnstile_missing) or is refused by the limiter (429 rate_limited). No post carries a
// token, so none can store a lead, send mail or start an upload.
//
// Usage: node scripts/site/probe-rate-limit.mjs --url https://selftest-<id>.<subdomain>.workers.dev
//          [--after lead.json ...] [--max 30] [--out probe.json] [--require-limit]
//   --after          live-lead.mjs outputs: wait until a period (60 s) has passed since the last of them was sent, so
//                    the leads' own posts don't count towards the probe's (a missing file counts as sent just now)
//   --max            most posts to send (default 30); it stops after the third 429
//   --require-limit  fail when no post was limited (off while the binding's behaviour on the Free plan is unproven)
// Refuses any host but selftest-*.<subdomain>.workers.dev (and, when SITE_ID is set, that site's own), or a local
// Worker at http://localhost or http://127.0.0.1. Fails when a post without a token is accepted, or when no answer
// came from the limiter or Turnstile (the probe did not reach them). Writes a summary for the job.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const PERIOD_MS = 60_000;
const STOP_AFTER_LIMITED = 3;
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
  return out;
};

export function allowedTarget(raw, siteId) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)) return true;
  if (u.protocol !== "https:" || u.pathname !== "/" || u.search) return false;
  const m = u.hostname.match(/^(selftest-[a-z0-9-]+)\.[a-z0-9-]+\.workers\.dev$/);
  return !!m && (!siteId || m[1] === siteId);
}

// One answer: "passed" (the limiter let it through, Turnstile refused it), "limited", "accepted" (a post without a
// token got through: a bug), or "other".
export function classify(status, error) {
  if (status === 429 && error === "rate_limited") return "limited";
  if (status === 403 && error === "turnstile_missing") return "passed";
  if (status >= 200 && status < 300) return "accepted";
  return "other";
}

export function verdict(results, { requireLimit = false } = {}) {
  const count = (k) => results.filter((r) => r.kind === k).length;
  const counts = { passed: count("passed"), limited: count("limited"), accepted: count("accepted"), other: count("other") };
  const first = results.findIndex((r) => r.kind === "limited");
  const firstLimited = first >= 0 ? first + 1 : null;
  let fail = null;
  if (counts.accepted) fail = `${counts.accepted} post(s) without a Turnstile token were accepted`;
  else if (!counts.passed && !counts.limited) fail = "no answer came from the rate limiter or Turnstile";
  else if (requireLimit && !counts.limited) fail = "the rate limiter limited none of the posts";
  return { counts, firstLimited, fail };
}

// "403 turnstile_missing ×5, 429 rate_limited ×3"
export function sequence(results) {
  const runs = [];
  for (const r of results) {
    const label = `${r.status} ${r.error || ""}`.trim();
    if (runs.length && runs.at(-1).label === label) runs.at(-1).n++;
    else runs.push({ label, n: 1 });
  }
  return runs.map((x) => `${x.label} ×${x.n}`).join(", ");
}

async function main() {
  const base = (arg("url") || "").replace(/\/$/, "");
  if (!allowedTarget(`${base}/`, process.env.SITE_ID)) {
    throw new Error(`refusing ${base || "(no --url)"}: only a throwaway selftest-* site on workers.dev${process.env.SITE_ID ? ` (${process.env.SITE_ID})` : ""}, or a local Worker`);
  }
  const max = Number(arg("max") || 30);
  if (!Number.isInteger(max) || max < 1 || max > 50) throw new Error("--max must be 1 to 50");
  const requireLimit = argv.includes("--require-limit");

  // The leads were posted from this runner's address too, and count towards the same key: wait them out. A lead file
  // that is missing or has no time (its step failed after posting, perhaps) counts as posted just now.
  const sentAt = (f) => {
    try {
      const t = Date.parse(JSON.parse(readFileSync(f, "utf8")).sentAt);
      return Number.isFinite(t) ? t : Date.now();
    } catch {
      return Date.now();
    }
  };
  const sent = list("after").map(sentAt);
  if (sent.length) {
    const wait = Math.max(...sent) + PERIOD_MS + 1_000 - Date.now();
    if (wait > 0) {
      console.log(`Waiting ${Math.ceil(wait / 1000)} s, a full period after the last lead was posted`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // The first form on the contact page (or the home page), as live-lead.mjs uses.
  let action = null;
  for (const path of ["/contact", "/"]) {
    const html = await (await fetch(base + path)).text();
    action = html.match(/action="(\/api\/submit\/[a-z][a-z0-9-]{0,31})"/)?.[1];
    if (action) break;
  }
  if (!action) throw new Error("no form found on /contact or /");

  const headers = {
    origin: base, // the Worker's origin check comes first; a browser on the site sends the same
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "framework-b-selftest rate-limit probe (throwaway self-test site)",
  };
  const results = [];
  const started = Date.now();
  for (let i = 0; i < max; i++) {
    const t = Date.now();
    let status = 0;
    let error = "network";
    try {
      const res = await fetch(base + action, { method: "POST", headers, body: "{}" });
      status = res.status;
      error = (await res.json().catch(() => ({}))).error || "";
    } catch {}
    results.push({ n: i + 1, status, error, kind: classify(status, error), ms: Date.now() - t, at: t - started });
    if (results.filter((r) => r.kind === "limited").length >= STOP_AFTER_LIMITED) break;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const { counts, firstLimited, fail } = verdict(results, { requireLimit });

  const lines = [
    `### Rate limit probe: ${new URL(base).host}`,
    "",
    `- ${results.length} posts to \`${action}\` with no Turnstile token, one after another, in ${seconds} s (limit: 5 a minute per site and address)`,
    `- Let through by the limiter and refused by Turnstile (403): ${counts.passed}; limited (429): ${counts.limited}; other: ${counts.other}; accepted: ${counts.accepted}`,
    firstLimited ? `- First 429 at post ${firstLimited}` : "- No 429: the rate limiter limited none of these posts",
    `- Answers: ${sequence(results)}`,
    fail ? `- **Failed:** ${fail}` : !counts.limited ? "- Reported only: the binding's limit on the Free plan is approximate and unproven (docs/SPEC.md)" : "",
    "",
  ].filter((l) => l !== "");
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n\n");
  if (!counts.limited && !fail && process.env.GITHUB_ACTIONS) console.log(`::warning title=Rate limit probe::No 429 in ${results.length} posts to ${new URL(base).host}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ url: base, action, max, seconds: Number(seconds), counts, firstLimited, fail, results }, null, 2));
  process.exit(fail ? 1 : 0);
}

if (process.argv[1]?.endsWith("probe-rate-limit.mjs")) await main();
