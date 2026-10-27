// Validation for the drips block in site.config.json (src/drips.js has the runtime). Kept apart from drips.js so
// config.js, which the Astro build also loads in Node, never imports the Workers runtime.

export const DURATION_RE = /^(\d{1,3}) (minute|hour|day|week)s?$/;
export const MAX_DRIP_EMAILS = 10;

// The wait as a Workflows duration string and in days (for the 365-day sleep limit).
export function parseAfter(after) {
  const m = DURATION_RE.exec(String(after || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  const days = n * { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7 }[m[2]];
  return { n, duration: `${n} ${m[2]}${n === 1 ? "" : "s"}`, days };
}

// Errors in the drips block, for config.js. An empty list means it is valid.
export function dripErrors(cfg) {
  const d = cfg.drips;
  if (d === undefined) return [];
  const errors = [];
  if (!d || typeof d !== "object") return ["drips must be an object"];
  if (cfg.site?.mode !== "launch") errors.push("drips need launch mode (they send from the site's own domain)");
  if (cfg.email?.confirm !== "resend") errors.push('drips need email.confirm "resend" (they use the same Resend domain)');
  if (!Array.isArray(d.forms) || !d.forms.length) errors.push("drips.forms must list at least one form id");
  else for (const f of d.forms) if (!cfg.forms?.[f]) errors.push(`drips.forms: no form "${f}"`);
  if (!Array.isArray(d.emails) || !d.emails.length) errors.push("drips.emails must list at least one email");
  else {
    if (d.emails.length > MAX_DRIP_EMAILS) errors.push(`drips.emails: at most ${MAX_DRIP_EMAILS}`);
    d.emails.forEach((e, i) => {
      const where = `drips.emails[${i}]`;
      const a = parseAfter(e?.after);
      if (!a) errors.push(`${where}.after must look like "2 days" (minutes, hours, days or weeks)`);
      else if (a.days > 365) errors.push(`${where}.after is longer than 365 days`);
      if (!e?.subject || String(e.subject).length > 200) errors.push(`${where}.subject is required (200 characters at most)`);
      if (!e?.text || String(e.text).length > 20000) errors.push(`${where}.text is required (20,000 characters at most)`);
    });
  }
  if (d.from !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(d.from)) errors.push("drips.from is the part before the @ (letters, digits, dot, dash, underscore)");
  return errors;
}
