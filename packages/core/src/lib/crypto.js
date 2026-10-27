// HMAC signing for unsubscribe links and upload tickets. Uses the SIGNING_SECRET Worker secret.

const enc = new TextEncoder();
const keyCache = new Map();

function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error("SIGNING_SECRET missing or shorter than 32 characters");
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function sign(secret, message) {
  const key = await hmacKey(secret);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// Constant-time comparison of two strings of possibly different length.
export function safeEqual(a, b) {
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  if (x.length !== y.length) {
    crypto.subtle.timingSafeEqual(x, x);
    return false;
  }
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function verify(secret, message, signature) {
  return safeEqual(await sign(secret, message), signature);
}

// Hex HMAC-SHA256, for signing webhook bodies (CRM mirror). The receiver recomputes it with the shared secret.
export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
