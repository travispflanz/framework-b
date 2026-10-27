// UptimeRobot monitors for a site, through the v3 API (https://api.uptimerobot.com/v3, Bearer key).
// Endpoints and fields are from UptimeRobot's own OpenAPI spec, shipped in @uptimerobot/cli 1.0.0
// (openapi/openapi.yaml), checked 2026-10-23. The Free plan allows 50 monitors at 5-minute checks
// and 10 API requests a minute (https://uptimerobot.com/api/v3/, checked 2026-10-23).
const BASE = "https://api.uptimerobot.com/v3";

async function ur(path, { method = "GET", body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.UPTIMEROBOT_API_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = res.status === 204 ? {} : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`UptimeRobot ${method} ${path}: HTTP ${res.status} ${JSON.stringify(json?.error || json?.message || "").slice(0, 200)}`);
  return json;
}

export const uptimeEnabled = () => !!process.env.UPTIMEROBOT_API_KEY;

// Two keyword monitors, the same pair every site gets: the homepage must show the site's name, and
// /api/health must say "ok":true (the Worker and D1 are up). Alerts go to every active alert contact.
export async function addMonitors({ name, host }) {
  const contacts = ((await ur("/alert-contacts")).data || []).filter((c) => c.status === "Active");
  const assignedAlertContacts = contacts.map((c) => ({ alertContactId: c.id, threshold: 0, recurrence: 0 }));
  const base = { type: "KEYWORD", interval: 300, timeout: 30, keywordType: "ALERT_NOT_EXISTS", keywordCaseType: "CaseSensitive", httpMethodType: "GET", assignedAlertContacts };
  const made = [];
  // Idempotent: a monitor with the same name and URL is kept, not duplicated (promote finish can be rerun).
  const existing = ((await ur(`/monitors?url=${encodeURIComponent(host)}`)).data || []).map((m) => `${m.friendlyName}|${m.url}`);
  for (const m of [
    { friendlyName: `${name} - homepage`, url: `https://${host}/`, keywordValue: name },
    { friendlyName: `${name} - API + database`, url: `https://${host}/api/health`, keywordValue: '"ok":true' },
  ]) {
    if (existing.includes(`${m.friendlyName}|${m.url}`)) continue;
    made.push((await ur("/monitors", { method: "POST", body: { ...base, ...m } })).id);
  }
  return { ids: made, contacts: contacts.length };
}

// Deletes the monitors whose URL is on this host. With a site name, only that site's own pair ("<name> - ..."), so
// another site's monitors on the same host (for example a parked site's) are left alone.
export async function removeMonitors(host, { name } = {}) {
  const list = (await ur(`/monitors?url=${encodeURIComponent(host)}`)).data || [];
  const mine = list.filter((m) => {
    try {
      return new URL(m.url).host === host && (!name || String(m.friendlyName).startsWith(`${name} - `));
    } catch {
      return false;
    }
  });
  for (const m of mine) await ur(`/monitors/${m.id}`, { method: "DELETE" });
  return mine.length;
}
