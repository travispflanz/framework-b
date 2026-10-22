// Server-side Turnstile check. https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(env, token, ip, expectedHostname, extraHostnames = []) {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: "turnstile_not_configured" };
  if (!token || typeof token !== "string" || token.length > 2048) return { ok: false, reason: "turnstile_missing" };

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  body.append("idempotency_key", crypto.randomUUID());

  let data;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body });
    data = await res.json();
  } catch {
    return { ok: false, reason: "turnstile_unreachable" };
  }
  if (!data || data.success !== true) return { ok: false, reason: "turnstile_failed" };
  // A token minted on another hostname must not be accepted here. The documented test secret keys accept
  // only the dummy token, and their reported hostname varies (docs say "localhost"; a live call on 2026-10-22
  // returned "example.com"), so the hostname check is skipped for them.
  // https://developers.cloudflare.com/turnstile/troubleshooting/testing/
  if (expectedHostname && !isTestSecret(env.TURNSTILE_SECRET)) {
    const allowed = new Set([expectedHostname, ...extraHostnames]);
    if (!allowed.has(data.hostname)) return { ok: false, reason: "turnstile_hostname" };
  }
  return { ok: true };
}

export function isTestSecret(secret) {
  return /^[123]x0+AA$/.test(String(secret || ""));
}
