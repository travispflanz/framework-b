#!/usr/bin/env node
// Sends a newsletter issue to a site's subscribers through Resend Broadcasts (docs/SPEC.md section 10). Runs in the
// owner's private ops repo ("site newsletter" workflow), never in a Worker.
//
//   node scripts/site/newsletter.mjs --site <site checkout> --issue newsletter/<date>-<slug>.md --mode test|send
//                                    [--to <email>] [--force]
//
// An issue is a Markdown file in the site's repo, written on a branch and merged by the owner (scripts/site/lib/
// newsletter.mjs has the format). Modes:
//   test  sends the issue to one inbox (default: the site owner). Before the site has a domain it goes from
//         Resend's test sender, which only delivers to the Resend account's own address
//         (resend.com/docs/knowledge-base/403-error-resend-dev-domain, checked 2026-10-27).
//   send  launch mode only. Mirrors the site's subscribers from D1 into the site's Resend segment ("<id>
//         newsletter"), records in D1 anyone who used a newsletter's unsubscribe link, then creates and sends
//         one broadcast from news@mail.<domain>. Resend adds the one-click unsubscribe headers to broadcasts.
//         An issue already sent (a broadcast with the same name) is refused unless --force.
// Resend Free: marketing email to up to 1,000 contacts a month, 10 API requests a second, 3 verified domains
// (resend.com/docs/knowledge-base/account-quotas-and-limits, checked 2026-10-27).
//
// Inputs (environment): RESEND_ADMIN_KEY (full access: contacts and broadcasts need it), and for send:
// CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID. Status: untested end to end until the first real issue.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, env, log } from "./lib/api.mjs";
import { parseIssue, renderIssue, syncPlan, UNSUBSCRIBE } from "./lib/newsletter.mjs";

const FRAMEWORK = resolve(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const { stripJsonc } = await import(join(FRAMEWORK, "starter/scripts/lib/jsonc.mjs"));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = resolve(arg("site", "."));
const issuePath = arg("issue", "");
const mode = arg("mode", "test");
const FORCE = process.argv.includes("--force");
if (!issuePath) throw new Error("--issue <path in the site repo> is required");
if (!["test", "send"].includes(mode)) throw new Error('--mode must be "test" or "send"');

const config = JSON.parse(readFileSync(join(SITE, "site.config.json"), "utf8"));
const issue = parseIssue(readFileSync(join(SITE, issuePath), "utf8"));
const { id, name: siteName, ownerEmail, mode: siteMode, canonicalHost, postalAddress } = config.site;
const launched = siteMode === "launch" && !!config.email?.confirmFrom;
const sendingDomain = launched ? config.email.confirmFrom.split("@")[1] : null;
const from = launched ? `${siteName} <news@${sendingDomain}>` : `${siteName} <onboarding@resend.dev>`;
const siteUrl = `https://${canonicalHost}`;
const broadcastName = `${id} ${basename(issuePath).replace(/\.md$/, "")}`.slice(0, 100);
const lines = [];
const done = (step, detail = "") => {
  lines.push(`- ${step}${detail ? `: ${detail}` : ""}`);
  log(step, detail);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resend allows 10 requests a second per team; 120 ms between calls stays under it.
let last = 0;
async function resend(path, { method = "GET", body, allow404 = false } = {}) {
  const gap = Date.now() - last;
  if (gap < 120) await sleep(120 - gap);
  last = Date.now();
  const res = await fetch(`https://api.resend.com${path}`, {
    method,
    headers: { authorization: `Bearer ${env("RESEND_ADMIN_KEY")}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  const json = await res.json().catch(() => null);
  if (res.status === 429) {
    await sleep(1500);
    return resend(path, { method, body, allow404 });
  }
  if (!res.ok) throw new Error(`Resend ${method} ${path.replace(/[^/]+@[^/]+/, "<email>")}: HTTP ${res.status} ${json?.message || ""}`.trim());
  return json;
}
async function listAll(path) {
  const all = [];
  let after = "";
  for (;;) {
    const page = await resend(`${path}${path.includes("?") ? "&" : "?"}limit=100${after ? `&after=${after}` : ""}`);
    all.push(...(page.data || []));
    if (!page.has_more || !page.data?.length) return all;
    after = page.data[page.data.length - 1].id;
  }
}

async function test() {
  const to = (arg("to", "") || ownerEmail).trim();
  const rendered = renderIssue(issue, { siteName, siteUrl, postalAddress: postalAddress || "(Your postal address goes here before the first real send)" });
  // A test is a single email, not a broadcast, so Resend doesn't fill in the unsubscribe link.
  const fill = (s) => s.replaceAll(UNSUBSCRIBE, `${siteUrl}/#unsubscribe-link-added-on-real-sends`);
  const r = await resend("/emails", { method: "POST", body: { from, to: [to], subject: `[Test] ${rendered.subject}`, html: fill(rendered.html), text: fill(rendered.text) } });
  done("test sent", `"${rendered.subject}" from ${from.replace(/^.*</, "<")} to the requested inbox (Resend id ${r.id})`);
  if (!launched) done("note", "the site has no domain yet, so Resend's test sender only delivers to the Resend account's own address");
}

async function send() {
  if (!launched) throw new Error("Sending needs launch mode with Resend set up (promote with RESEND_ADMIN_KEY). Use --mode test until then.");
  if (!postalAddress?.trim()) throw new Error("site.postalAddress is empty; marketing email needs it (CAN-SPAM)");
  const rendered = renderIssue(issue, { siteName, siteUrl, postalAddress });
  const already = (await listAll("/broadcasts")).find((b) => b.name === broadcastName);
  if (already && !FORCE) throw new Error(`This issue was already sent (broadcast ${already.id}). Pass --force to send it again.`);

  // Subscribers and first names from D1, the system of record.
  const wrangler = JSON.parse(stripJsonc(readFileSync(join(SITE, "wrangler.jsonc"), "utf8")));
  const dbId = wrangler.d1_databases.find((d) => d.binding === "DB")?.database_id;
  const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
  const query = async (sql, params = []) => (await cf(`${A}/d1/database/${dbId}/query`, { method: "POST", body: { sql, params } }))[0]?.results || [];
  const subscribers = (await query("SELECT email, status FROM subscribers WHERE site = ?", [id])).map((s) => ({ ...s, email: s.email.toLowerCase() }));
  const firstNames = new Map();
  for (const l of await query("SELECT email, name, fields_json FROM leads WHERE site = ? ORDER BY created_at", [id])) {
    let f = {};
    try {
      f = JSON.parse(l.fields_json || "{}");
    } catch {}
    const first = (f.first_name || (l.name || "").split(/\s+/)[0] || "").trim();
    if (first) firstNames.set(l.email.toLowerCase(), first.slice(0, 50));
  }

  // The site's segment, then each subscriber's contact in Resend.
  const segName = `${id} newsletter`;
  let segment = (await listAll("/segments")).find((s) => s.name === segName);
  if (!segment) segment = await resend("/segments", { method: "POST", body: { name: segName } });
  const contacts = new Map();
  for (const s of subscribers) {
    const c = await resend(`/contacts/${encodeURIComponent(s.email)}`, { allow404: true });
    if (!c) continue;
    const segs = (await resend(`/contacts/${c.id}/segments`)).data || [];
    contacts.set(s.email, { id: c.id, unsubscribed: !!c.unsubscribed, inSegment: segs.some((g) => g.id === segment.id) });
  }
  const plan = syncPlan(subscribers, contacts);
  for (const s of plan.create) {
    await resend("/contacts", { method: "POST", body: { email: s.email, ...(firstNames.get(s.email) ? { first_name: firstNames.get(s.email) } : {}), unsubscribed: false, segments: [{ id: segment.id }] } });
  }
  for (const s of plan.addToSegment) await resend(`/contacts/${contacts.get(s.email).id}/segments/${segment.id}`, { method: "POST" });
  for (const s of plan.removeFromSegment) await resend(`/contacts/${contacts.get(s.email).id}/segments/${segment.id}`, { method: "DELETE" });
  const now = new Date().toISOString();
  for (const s of plan.unsubscribeInD1) {
    // The person used an unsubscribe link in an earlier issue; D1 records it the same way /u does.
    await query("UPDATE subscribers SET status = 'unsubscribed', updated_at = ?, unsubscribed_at = ? WHERE site = ? AND email = ? AND status = 'subscribed'", [now, now, id, s.email]);
  }
  const recipients = subscribers.filter((s) => s.status === "subscribed").length - plan.unsubscribeInD1.length;
  done("subscribers", `${recipients} to send to; ${plan.create.length} added to Resend, ${plan.addToSegment.length} added to the segment, ${plan.removeFromSegment.length} removed (unsubscribed on the site), ${plan.unsubscribeInD1.length} unsubscribed through a newsletter and recorded in D1`);
  if (recipients < 1) {
    done("not sent", "nobody is subscribed");
    return;
  }
  const b = await resend("/broadcasts", { method: "POST", body: { segment_id: segment.id, from, reply_to: ownerEmail, subject: rendered.subject, html: rendered.html, text: rendered.text, name: broadcastName, send: true } });
  done("sent", `broadcast ${b.id} "${rendered.subject}" to segment "${segName}" from news@${sendingDomain}`);
}

try {
  if (mode === "test") await test();
  else await send();
} finally {
  const text = `## Newsletter: ${issue.subject} (${mode})\n\n${lines.join("\n")}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
