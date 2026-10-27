#!/usr/bin/env node
// Connects an existing site to the account's Apps Script mailer (ops/apps-script-mailer), for sites created before
// the ops repo had MAILER_URL and MAILER_SECRET. New sites get it from `site create` automatically.
//
//   node scripts/site/mailer.mjs --site <site checkout> [--check-only]
//
// 1. Sends one test notification to the site owner through the mailer, which proves the web app, its secret
//    and the Gmail quota end to end.
// 2. Stores MAILER_URL and MAILER_SECRET as secrets on the site's Worker and on its Previews base configuration.
// 3. Switches site.config.json to email.notify "apps-script" when it was "none". The caller commits that on a branch
//    and opens a pull request; notifications start when the owner merges it.
// --check-only does step 1 alone. Inputs (environment): MAILER_URL, MAILER_SECRET, CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID. Nothing secret is printed.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, log } from "./lib/api.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SITE = resolve(arg("site", "."));
const CHECK_ONLY = process.argv.includes("--check-only");
const configPath = join(SITE, "site.config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const { id, name, ownerEmail } = config.site;
const url = env("MAILER_URL");
const secret = env("MAILER_SECRET");
const lines = [];
const done = (step, detail = "") => {
  lines.push(`- ${step}${detail ? `: ${detail}` : ""}`);
  log(step, detail);
};

// The mailer answers a POST with a 302 to a one-time URL that holds the JSON result; fetch follows it with a GET
// (the same path packages/core/src/mailers.js takes).
async function callMailer(payload) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret, ...payload }), redirect: "follow" });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) {
    console.log(await diagnose());
    throw new Error(`The mailer answered ${res.status} ${data?.error || "(no JSON)"}. See the diagnosis above.`);
  }
  return data;
}

// What's wrong with a failing mailer URL, without printing the URL itself (it holds the deployment id).
async function diagnose() {
  const out = [];
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return "- MAILER_URL isn't a URL.";
  }
  if (url !== url.trim()) out.push("- MAILER_URL has spaces or a line break around it.");
  out.push(`- Host: ${u.host}; path ends with "${u.pathname.split("/").pop()}"`);
  if (u.host !== "script.google.com") out.push("- Expected the host script.google.com (Deploy → Manage deployments → Web app URL).");
  if (/\/dev$/.test(u.pathname)) out.push('- This is the test deployment ("/dev"), which only works signed in as the owner. Use the Web app URL that ends in "/exec".');
  if (!/\/exec$/.test(u.pathname)) out.push('- The Web app URL should end in "/exec".');
  if (/\/u\/\d+\//.test(u.pathname)) out.push('- The URL has "/u/<n>/" in it (copied while signed in to several Google accounts). Remove that part, or copy it from Manage deployments.');
  if (/^\/a\/macros\//.test(u.pathname)) out.push('- This is a Google Workspace URL ("/a/macros/<domain>"), which requires a sign-in in that domain. Deploy from a personal Gmail account, or allow "Anyone".');
  const first = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual" });
  out.push(`- POST answered ${first.status}${first.headers.get("location") ? ` with a redirect to ${new URL(first.headers.get("location")).host}` : ""}.`);
  const get = await fetch(u, { redirect: "follow" });
  const body = (await get.text()).slice(0, 2000);
  out.push(`- GET answered ${get.status}${/framework-b-mailer/.test(body) ? " with the mailer's own reply, so the deployment is reachable" : /accounts\.google\.com|ServiceLogin|Sign in/i.test(body) ? " with a Google sign-in page: the web app's access isn't \"Anyone\"" : ""}.`);
  if (first.status === 403 || get.status === 403) out.push('- 403 from Google means the web app refuses anonymous callers: Deploy → Manage deployments → edit (pencil) → Who has access: "Anyone" → Version: New version → Deploy. The /exec URL stays the same.');
  return out.join("\n");
}

try {
  const r = await callMailer({
    site: name,
    notify: {
      to: ownerEmail,
      subject: `[${name}] Mailer test: lead notifications are connected`,
      text: `This is a test from Framework B. When this site gets a lead, the notification will arrive like this one.\n\nSite: https://${config.site.canonicalHost}\nNothing to do.`,
    },
  });
  done("mailer", `test notification sent to the site owner (${r.remaining} of today's Gmail quota left)`);
  if (CHECK_ONLY) process.exit(0);

  const wrangler = existsSync(join(SITE, "node_modules/.bin/wrangler")) ? join(SITE, "node_modules/.bin/wrangler") : "wrangler";
  const put = (args, value) => execFileSync(wrangler, args, { cwd: SITE, input: value, stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, CI: "1" } });
  for (const [k, v] of [["MAILER_URL", url], ["MAILER_SECRET", secret]]) {
    put(["secret", "put", k, "--name", id], v);
    put(["preview", "base-config", "secret", "put", k], v);
  }
  done("secrets", `MAILER_URL and MAILER_SECRET stored on Worker ${id} and its previews`);

  if (config.email?.notify === "none" || !config.email?.notify) {
    config.email = { ...(config.email || {}), notify: "apps-script" };
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    done("site.config.json", 'email.notify switched to "apps-script" (takes effect when the pull request is merged)');
  } else {
    done("site.config.json", `email.notify stays "${config.email.notify}"`);
  }
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Mailer for ${id}\n\n${lines.join("\n")}\n`);
}
