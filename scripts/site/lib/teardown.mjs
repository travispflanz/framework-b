// The mail part of teardown (scripts/site/teardown.mjs): the Resend sending key and sending domain a launch site
// leaves, and the DNS records promote added for that domain. The decisions and the record matching are pure; the
// removals call Resend and Cloudflare through fetch, so scripts/site/test/teardown.test.mjs runs them on a mock.
//
// Promote (scripts/site/promote.mjs, step 4) sets up Resend on mail.<domain> for every launch site: the Resend
// domain, its DNS records in the zone (named by resendRecordName, each with the comment RESEND_DNS_COMMENT), and a
// sending-only key "<id> sending" restricted to it. On a zone the site owns (its apex), mail.<domain> belongs with
// the zone's mail and stays. On a one-level subdomain of a zone it shares (shop.example.com in example.com),
// mail.shop.example.com and its records exist only for that site, so teardown removes them: otherwise each one
// keeps one of the 3 verified domains Resend Free allows (resend.com/docs/knowledge-base/account-quotas-and-limits,
// checked 2026-11-12).
//
// Resend API (checked 2026-11-12): GET /domains lists every domain when no limit is given (id, name, status, ...;
// resend.com/docs/api-reference/domains/list-domains); GET /domains/{id} adds records[] with record, name, type,
// ttl, status, value and, for MX, priority (resend.com/docs/api-reference/domains/get-domain); DELETE /domains/{id}
// answers { object: "domain", id, deleted: true } (resend.com/docs/api-reference/domains/delete-domain). Resend
// doesn't document what happens to a key restricted to a deleted domain, so the key is deleted first. The limit is
// 10 requests a second per team, with 429 and retry-after beyond it (resend.com/docs/api-reference/rate-limit).
import { cf, gh } from "./api.mjs";
import { DOMAIN_RE, mailAddresses, RESEND_DNS_COMMENT, resendRecordName, zoneFor } from "./promote.mjs";

const RESEND = "https://api.resend.com";
export const RESEND_RETRY = { attempts: 3, baseMs: 1000 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// One Resend API call with the full-access key. A 429 means the call was not carried out, so it is repeated
// after retry-after (at most 10 s); any other error throws.
export async function resend(path, { method = "GET", adminKey } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${RESEND}${path}`, { method, headers: { authorization: `Bearer ${adminKey}` } });
    if (res.status === 429 && attempt < RESEND_RETRY.attempts) {
      await pause(Math.min(Number(res.headers.get("retry-after")) * 1000 || RESEND_RETRY.baseMs, 10_000));
      continue;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Resend ${method} ${path}: HTTP ${res.status}${json?.message ? ` ${json.message}` : ""}`);
    return json;
  }
}

// What happens to the sending domain promote made for a launch site on <host>. zones: the account's zones, or
// null when they could not be read.
export function sendingDomainPlan(host, zones) {
  const sendingDomain = mailAddresses(host).resendDomain;
  if (!zones) return { remove: false, sendingDomain, why: "the account's zones could not be read" };
  const zone = zoneFor(host, zones);
  if (!zone) return { remove: false, sendingDomain, why: `no zone of this account holds ${host}` };
  if (zone.name === host) return { remove: false, sendingDomain, zone, why: `the site owns the zone ${zone.name}, so it belongs with the zone's mail` };
  const extra = host.split(".").length - zone.name.split(".").length;
  if (extra !== 1) return { remove: false, sendingDomain, zone, why: `${host} is ${extra} levels below ${zone.name}; promote only launches one level below a zone` };
  return { remove: true, sendingDomain, zone, why: `${host} is a subdomain of the shared zone ${zone.name}` };
}

// The DNS records promote created from Resend's list (the same names, types, values and priorities it sent).
export function expectedDnsRecords(resendRecords, { zone, sendingDomain }) {
  return (resendRecords || []).map((r) => ({
    type: String(r.type).toUpperCase(),
    name: resendRecordName(r.name, { zone, sendingDomain }).toLowerCase(),
    content: String(r.value),
    ...(r.priority !== undefined && r.priority !== null ? { priority: Number(r.priority) } : {}),
  }));
}

// Record content compared the way promote's ensureDns compares it: TXT without its quotes (and a long value split
// into quoted strings joined again), hostnames without case or a final dot.
const norm = (type, content) => {
  const v = String(content).trim().replace(/"\s+"/g, "").replace(/^"|"$/g, "");
  return type === "TXT" ? v : v.toLowerCase().replace(/\.$/, "");
};
const under = (name, domain) => name === domain || name.endsWith(`.${domain}`);

// Which of the zone's records promote added for the sending domain. Only records with promote's comment, at or
// under the sending domain, count. With Resend's list (the domain still exists), each must also match one of its
// records exactly; without it (Resend no longer has the domain), any MX, TXT or CNAME record with the comment there
// does. Returns { remove, stale }: stale ones carry the comment but match none of Resend's current records.
export function promoteDnsRecords(zoneRecords, { sendingDomain, expected = null }) {
  const remove = [];
  const stale = [];
  for (const r of zoneRecords || []) {
    const name = String(r.name).toLowerCase().replace(/\.$/, "");
    if (r.comment !== RESEND_DNS_COMMENT || !under(name, sendingDomain)) continue;
    const type = String(r.type).toUpperCase();
    const match = expected
      ? expected.some((e) => e.type === type && e.name === name && norm(type, e.content) === norm(type, r.content) && (e.priority === undefined || r.priority === undefined || Number(r.priority) === e.priority))
      : ["MX", "TXT", "CNAME"].includes(type);
    (match ? remove : stale).push(r);
  }
  return { remove, stale };
}

// Deletes the site's "<id> sending" key. Errors are reported, not thrown.
export async function removeSendingKey({ id, adminKey, did }) {
  try {
    const keys = (await resend("/api-keys", { adminKey }))?.data || [];
    for (const k of keys.filter((k) => k.name === `${id} sending`)) {
      await resend(`/api-keys/${k.id}`, { method: "DELETE", adminKey });
      did(`deleted Resend key "${k.name}"`);
    }
  } catch (e) {
    did(`Resend key not removed (${e.message})`);
  }
}

// Deletes the Resend domain, then the DNS records promote added for it. If the domain can't be deleted, its records
// stay, so the domain stays verified and a rerun matches them again. Errors are reported, not thrown.
export async function removeSendingDomain({ sendingDomain, zone, adminKey, did }) {
  let expected = null;
  try {
    const found = ((await resend("/domains", { adminKey }))?.data || []).find((d) => d.name === sendingDomain);
    if (!found) {
      did(`Resend domain ${sendingDomain} not found (already removed)`);
    } else {
      const dom = await resend(`/domains/${found.id}`, { adminKey });
      expected = expectedDnsRecords(dom?.records, { zone: zone.name, sendingDomain });
      await resend(`/domains/${found.id}`, { method: "DELETE", adminKey });
      did(`deleted Resend domain ${sendingDomain}`);
    }
  } catch (e) {
    did(`Resend domain ${sendingDomain} not removed (${e.message}); its DNS records are kept`);
    return;
  }
  try {
    const records = (await cf(`/zones/${zone.id}/dns_records?name.endswith=${encodeURIComponent(sendingDomain)}&per_page=100`)) || [];
    const { remove, stale } = promoteDnsRecords(records, { sendingDomain, expected });
    for (const r of remove) {
      try {
        await cf(`/zones/${zone.id}/dns_records/${r.id}`, { method: "DELETE" });
        did(`deleted the ${r.type} record ${r.name} promote added for ${sendingDomain}`);
      } catch (e) {
        did(`the ${r.type} record ${r.name} not removed (${e.message})`);
      }
    }
    if (!remove.length) did(`no DNS records promote added for ${sendingDomain} were left`);
    for (const r of stale) did(`kept the ${r.type} record ${r.name}: promote's comment, but not one of Resend's records for ${sendingDomain}; delete it in the dashboard if nothing uses it`);
  } catch (e) {
    did(`DNS records for ${sendingDomain} not removed (${e.message})`);
  }
}

// Teardown of a launch site on <host>: its sending key always; on a subdomain of a shared zone, also its sending
// domain and the DNS records promote added for it. Never throws.
export async function resendCleanup({ id, host, zones, adminKey, did }) {
  const plan = sendingDomainPlan(host, zones);
  if (!adminKey) {
    if (plan.remove) did(`Resend domain ${plan.sendingDomain} not removed: no RESEND_ADMIN_KEY. Remove it later with MAIL_DOMAIN=${plan.sendingDomain}`);
    return plan;
  }
  await removeSendingKey({ id, adminKey, did });
  if (plan.remove) await removeSendingDomain({ sendingDomain: plan.sendingDomain, zone: plan.zone, adminKey, did });
  else did(`Resend domain ${plan.sendingDomain} kept: ${plan.why}`);
  return plan;
}

// A leftover sending domain, removed on its own: MAIL_DOMAIN must be mail.<host> and CONFIRM exactly
// "delete mail.<host>". Pure, so it refuses before any API call.
export function leftoverRequest(mailDomain, confirm) {
  const d = String(mailDomain || "").trim().toLowerCase().replace(/\.$/, "");
  if (!d.startsWith("mail.") || !DOMAIN_RE.test(d) || d.split(".").length < 4) {
    throw new Error(`Refusing: MAIL_DOMAIN must be mail.<site host> for a site on a subdomain of a zone, like mail.shop.example.com (got "${d}")`);
  }
  if (confirm !== `delete ${d}`) throw new Error(`Refusing: set CONFIRM to "delete ${d}" (the owner's approval to delete this Resend domain and the DNS records promote added for it)`);
  return { sendingDomain: d, host: d.slice("mail.".length) };
}

// Why a leftover's host is still in use, or null. A launch site is live on its Custom Domain; a parked one keeps
// its Worker and its repo's site.config.json but has no Custom Domain, so every Worker's site repo is read too.
export async function hostInUse({ accountPath, host, siteId, login }) {
  const attached = ((await cf(`${accountPath}/workers/domains?hostname=${encodeURIComponent(host)}`)) || []).filter((d) => d.hostname === host);
  if (attached.length) return `${host} is still the Custom Domain of the Worker ${attached[0].service}`;
  const scripts = (await cf(`${accountPath}/workers/scripts`)) || [];
  if (scripts.some((s) => s.id === siteId)) return `the Worker ${siteId} still exists: tear the site down without MAIL_DOMAIN instead`;
  for (const s of scripts) {
    const file = await gh(`/repos/${login}/site-${s.id}/contents/site.config.json`, { allow404: true });
    const cfg = file?.content ? JSON.parse(Buffer.from(file.content, "base64").toString("utf8")) : null;
    if (cfg?.site?.mode === "launch" && cfg.site.canonicalHost === host) return `the site ${s.id} (its Worker still exists, perhaps parked) is launched on ${host}`;
  }
  return null;
}

// The leftover path: checks, then removes the "<siteId> sending" key if it is still there, the Resend domain and
// the DNS records promote added for it. Throws "Refusing: ..." when any check fails, before deleting anything.
// The confirmation and the name are checked before any API call.
export async function removeLeftover({ mailDomain, confirm, siteId, account, adminKey, did }) {
  const { sendingDomain, host } = leftoverRequest(mailDomain, confirm);
  if (!adminKey) throw new Error("Refusing: removing a Resend domain needs the ops secret RESEND_ADMIN_KEY");
  const plan = sendingDomainPlan(host, await cf(`/zones?account.id=${account}&per_page=50`));
  if (!plan.remove) throw new Error(`Refusing: ${sendingDomain} isn't a subdomain site's sending domain (${plan.why})`);
  const login = (await gh("/user")).login;
  const busy = await hostInUse({ accountPath: `/accounts/${account}`, host, siteId, login });
  if (busy) throw new Error(`Refusing: ${busy}`);
  did(`leftover ${sendingDomain} of ${siteId}: no Worker or site uses ${host}`);
  await removeSendingKey({ id: siteId, adminKey, did });
  await removeSendingDomain({ sendingDomain, zone: plan.zone, adminKey, did });
}
