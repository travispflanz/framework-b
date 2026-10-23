#!/usr/bin/env node
// Checks that a site has its two uptime monitors and that UptimeRobot can read both as up.
// Usage: node scripts/site/verify-monitors.mjs <host>   (needs UPTIMEROBOT_API_KEY)
const host = process.argv[2];
const H = { authorization: `Bearer ${process.env.UPTIMEROBOT_API_KEY}` };
const list = (await (await fetch(`https://api.uptimerobot.com/v3/monitors?url=${encodeURIComponent(host)}`, { headers: H })).json()).data || [];
const mine = list.filter((m) => new URL(m.url).host === host);
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
};
check("two monitors exist for the site", mine.length === 2, mine.map((m) => m.friendlyName).join(", "));
check("homepage and /api/health are watched", ["/", "/api/health"].every((p) => mine.some((m) => new URL(m.url).pathname === p)));
check("each monitor alerts someone", mine.every((m) => (m.assignedAlertContacts || []).length > 0));
// The first check can take a few minutes; wait up to 7 minutes for both to report UP.
let statuses = [];
for (let i = 0; i < 21; i++) {
  statuses = await Promise.all(mine.map(async (m) => (await (await fetch(`https://api.uptimerobot.com/v3/monitors/${m.id}`, { headers: H })).json()).status));
  if (statuses.every((s) => s === "UP") || statuses.some((s) => s === "DOWN")) break;
  await new Promise((r) => setTimeout(r, 20000)); // stays under the Free plan's 10 requests a minute
}
check("both monitors report UP", statuses.length === 2 && statuses.every((s) => s === "UP"), statuses.join(", "));
process.exit(failures ? 1 : 0);
