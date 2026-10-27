// The pure parts of promote (scripts/site/promote.mjs): what an idea site's files become in launch mode, the
// www → apex redirect rule, and where Resend's DNS records go. No network access here, so it is unit-tested.

export const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Names of the per-site launch resources (docs/SPEC.md section 2: own prod and staging databases, own bucket).
export function launchNames(id) {
  return { db: `${id}-prod`, stagingDb: `${id}-staging`, uploads: `${id}-uploads` };
}

// Mail addresses on the domain. Owner notifications go out through Cloudflare's send_email binding from
// notify@<domain> (Email Routing on the zone); lead auto-replies go through Resend on mail.<domain>.
export function mailAddresses(domain) {
  return { notifyFrom: `notify@${domain}`, resendDomain: `mail.${domain}`, confirmFrom: `hello@mail.${domain}` };
}

// The zone a hostname belongs to: the longest zone name it ends with. Promote takes the zone apex itself or a
// subdomain of it (for example a site on shop.example.com inside the owner's example.com zone).
export function zoneFor(hostname, zones) {
  return [...zones].filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] || null;
}

// How owner notifications go out on launch. Cloudflare's send_email binding needs Email Routing on the zone, which
// takes over the zone apex's MX records. Promote only turns it on when the site owns the whole zone and the apex
// has no other mail provider; otherwise (a subdomain, or a zone whose apex already receives mail elsewhere) it
// keeps the account's Apps Script mailer, and with no mailer configured, notifications stay off.
const CLOUDFLARE_MX = /(^|\.)mx\.cloudflare\.net\.?$/i;
export function notifyPlan({ ownsZone, apexMx = [], mailer = false }) {
  const otherMail = apexMx.filter((h) => !CLOUDFLARE_MX.test(h));
  if (ownsZone && !otherMail.length) return { notify: "cloudflare", why: "the site owns the zone and its apex has no other mail provider" };
  const why = ownsZone ? `the apex already receives mail through ${otherMail.join(", ")}` : "the site is on a subdomain of a zone it shares";
  return mailer ? { notify: "apps-script", why: `${why}, so Email Routing stays off and the account's Apps Script mailer sends them` } : { notify: "none", why: `${why}, and no Apps Script mailer is configured (MAILER_URL, MAILER_SECRET)` };
}

// site.config.json in launch mode. Indexing follows the launch default (on) unless the owner chose otherwise.
export function launchConfig(config, { domain, postalAddress, resend, notify = "cloudflare", indexing = true }) {
  if (!DOMAIN_RE.test(domain)) throw new Error(`"${domain}" is not a domain name`);
  if (!postalAddress?.trim()) throw new Error("A postal address is required in launch mode (CAN-SPAM)");
  if (!["cloudflare", "apps-script", "none"].includes(notify)) throw new Error(`unknown notify mailer "${notify}"`);
  const mail = mailAddresses(domain);
  const out = structuredClone(config);
  out.site = { ...out.site, mode: "launch", canonicalHost: domain, postalAddress: postalAddress.trim(), indexing };
  out.email = { ...out.email, notify, confirm: resend ? "resend" : "none" };
  if (notify === "cloudflare") out.email.notifyFrom = mail.notifyFrom;
  else delete out.email.notifyFrom;
  if (resend) out.email.confirmFrom = mail.confirmFrom;
  else delete out.email.confirmFrom;
  return out;
}

// wrangler.jsonc in launch mode: the domain as a Custom Domain, the site's own databases and bucket, and the
// send_email binding restricted to the owner's verified inbox (only when Cloudflare sends the notifications). Everything else (assets, vars, EmDash bindings,
// rate limits) is kept. workers_dev stays on: the twin answers with noindex (core headers).
export function launchWrangler(wrangler, { id, domain, owner, db, stagingDb, sendEmail = true }) {
  const names = launchNames(id);
  const out = structuredClone(wrangler);
  const swapDb = (list, value) => (list || []).map((d) => (d.binding === "DB" ? { ...d, ...value } : d));
  const swapBucket = (list, value) => (list || []).map((b) => (b.binding === "UPLOADS" ? { ...b, ...value } : b));
  out.workers_dev = true;
  out.routes = [{ pattern: domain, custom_domain: true }];
  out.d1_databases = swapDb(out.d1_databases, { database_name: names.db, database_id: db });
  out.r2_buckets = swapBucket(out.r2_buckets, { bucket_name: names.uploads });
  if (sendEmail) out.send_email = [{ name: "EMAIL", destination_address: owner }];
  else delete out.send_email;
  if (out.previews) out.previews = { ...out.previews, d1_databases: swapDb(out.previews.d1_databases, { database_name: names.stagingDb, database_id: stagingDb }) };
  return out;
}

// The www → apex Single Redirect (Rulesets API, phase http_request_dynamic_redirect; checked 2026-10-27:
// https://developers.cloudflare.com/rules/url-forwarding/single-redirects/create-api/). It needs www to be a
// proxied DNS record, which promote creates when missing.
export const REDIRECT_REF = "framework_b_www_to_apex";
export function redirectRule(domain) {
  return {
    ref: REDIRECT_REF,
    description: `Framework B: www.${domain} to ${domain}`,
    expression: `(http.host eq "www.${domain}")`,
    action: "redirect",
    action_parameters: {
      from_value: {
        status_code: 301,
        target_url: { expression: `concat("https://${domain}", http.request.uri.path)` },
        preserve_query_string: true,
      },
    },
  };
}

// Adds or replaces our rule in the zone's redirect entrypoint, keeping every other rule as it was.
// Fields the API adds on read (id, version, last_updated) are dropped from the rules sent back.
export function mergeRedirectRules(existing, rule) {
  const keep = (existing || []).filter((r) => r.ref !== rule.ref).map(({ id, version, last_updated, ...r }) => r);
  return [...keep, rule];
}

// The DNS name for a record Resend asks for. Resend gives names relative to a zone (for example
// "resend._domainkey" or "send"); for a sending subdomain like mail.example.com they may already carry the
// subdomain ("resend._domainkey.mail"). Untested against a live subdomain: the record must end up under the
// sending domain, so a name that doesn't is placed under it.
export function resendRecordName(name, { zone, sendingDomain }) {
  const n = String(name).replace(/\.$/, "");
  if (n === "@" || n === "") return sendingDomain;
  const fqdn = n.endsWith(zone) ? n : `${n}.${zone}`;
  return fqdn === sendingDomain || fqdn.endsWith(`.${sendingDomain}`) ? fqdn : `${n}.${sendingDomain}`;
}

// The settings no API reaches, posted to the owner after promote (docs/ONE-TIME-SETUP.md, "Per launch site").
// Dashboard links use Cloudflare's documented "?to=/:account/:zone/..." form, which asks for the domain.
export function ownerChecklist(domain, zone = domain) {
  return [
    `Crawler Hints on: https://dash.cloudflare.com/?to=/:account/:zone/caching/configuration → pick ${zone} → Crawler Hints → On`,
    `Search Console: https://search.google.com/search-console → Add property → Domain → ${zone} (it covers its subdomains). Put the TXT record it gives you in Cloudflare DNS (https://dash.cloudflare.com/?to=/:account/:zone/dns/records), verify, then Sitemaps → submit https://${domain}/sitemap-index.xml`,
    "Bing Webmaster Tools: https://www.bing.com/webmasters → Import from Google Search Console",
    `Registrar auto-renew: https://dash.cloudflare.com/?to=/:account/domains → ${zone} → choose auto-renew on or off`,
  ];
}
