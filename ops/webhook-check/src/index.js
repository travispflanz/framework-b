// A webhook receiver for testing a site's CRM mirror (packages/core/src/crm.js). It checks what a real CRM
// webhook would check: the HMAC signature (x-framework-b-signature: sha256=<hex>, keyed by CRM_WEBHOOK_SECRET)
// and that the Idempotency-Key header is the lead's id. It answers 200 for a valid delivery and 401 otherwise,
// and keeps only the verdict (site, lead id, valid, time) in KV, never the lead's fields.
//
//   POST /           a delivery from a site's Worker or `site crm sync`
//   GET  /results    the last 50 verdicts; needs "Authorization: Bearer <CRM_WEBHOOK_SECRET>"
const enc = new TextEncoder();

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/results") {
      if (!same(request.headers.get("authorization") || "", `Bearer ${env.CRM_WEBHOOK_SECRET}`)) return new Response("Unauthorized", { status: 401 });
      const list = await env.RESULTS.list({ prefix: "r:" });
      const rows = await Promise.all(list.keys.slice(-50).map((k) => env.RESULTS.get(k.name, "json")));
      return Response.json(rows);
    }
    if (request.method !== "POST") return new Response("Framework B webhook check. POST a signed delivery here.\n");
    const body = await request.text();
    const signature = request.headers.get("x-framework-b-signature") || "";
    const valid = same(signature, `sha256=${await hmacHex(env.CRM_WEBHOOK_SECRET, body)}`);
    let site = null;
    let lead = null;
    try {
      const json = JSON.parse(body);
      site = json.site ?? null;
      lead = json.lead?.id ?? null;
    } catch {}
    const idempotencyKey = request.headers.get("idempotency-key");
    const ok = valid && !!lead && idempotencyKey === lead;
    const verdict = { site, lead, signatureValid: valid, idempotencyKeyMatches: idempotencyKey === lead, ok, at: new Date().toISOString() };
    await env.RESULTS.put(`r:${Date.now()}:${lead}`, JSON.stringify(verdict), { expirationTtl: 7 * 86400 });
    return Response.json(verdict, { status: ok ? 200 : 401 });
  },
};
