// Verifies the Cloudflare Access JWT on admin requests, so /admin stays closed even if the
// Access application is misconfigured. Fails closed when ACCESS_TEAM_DOMAIN or ACCESS_AUD is unset.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

let jwksCache = { url: "", keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s) {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodePart(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function getKeys(teamDomain, force = false) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  if (!force && jwksCache.url === url && jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const { keys } = await res.json();
  jwksCache = { url, keys, fetchedAt: Date.now() };
  return keys;
}

export async function verifyAccessJwt(request, env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) return { ok: false, reason: "access_not_configured" };

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, reason: "no_token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: "alg" };

  let keys = await getKeys(teamDomain);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getKeys(teamDomain, true); // keys rotate; refetch once
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: "unknown_kid" };

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, reason: "signature" };

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, reason: "aud" };
  if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: "iss" };
  if (typeof payload.exp !== "number" || payload.exp < now) return { ok: false, reason: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return { ok: false, reason: "not_yet_valid" };

  return { ok: true, email: payload.email || "" };
}

// For tests only.
export function _resetJwksCache() {
  jwksCache = { url: "", keys: null, fetchedAt: 0 };
}
