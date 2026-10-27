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
  if (!data || data.ok !== true) throw new Error(`The mailer answered ${res.status} ${data?.error || "(no JSON)"}. Check the web app URL, that it is deployed with access "Anyone", and that its MAILER_SECRET script property matches.`);
  return data;
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
