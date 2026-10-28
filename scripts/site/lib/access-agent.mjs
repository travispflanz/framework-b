// How checks get through Cloudflare Access to a site's previews, without any long-lived secret.
//
// - One reusable Service Auth policy per account, "framework-b agent": decision non_identity, include
//   any_valid_service_token. It is attached to each site's "<id> previews" application next to the owner's
//   email policy. Only account administrators can create service tokens, so this admits nothing else.
// - Each check mints its own service token that lives for a few minutes, uses it only on the preview's own host
//   (starter/scripts/lib/access-auth.mjs), and deletes it at the end. A token left behind by a crashed run
//   expires on its own.
//
// Needs the deploy token with Access: Apps and Policies Edit and Access: Service Tokens Edit (docs/TOKENS.md).
// API: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ and
// https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/ (checked 2026-10-23).
import { cf } from "./api.mjs";

export const AGENT_POLICY = "framework-b agent";
const TOKEN_PREFIX = "framework-b check";

export async function ensureAgentPolicy(A) {
  const all = (await cf(`${A}/access/policies`)) || [];
  const found = all.find((p) => p.name === AGENT_POLICY && p.reusable);
  if (found) return found;
  return cf(`${A}/access/policies`, {
    method: "POST",
    body: { name: AGENT_POLICY, decision: "non_identity", include: [{ any_valid_service_token: {} }] },
  });
}

// Adds the agent policy to an Access application, keeping its existing policies and settings. Returns true when
// it changed the application. A PUT with the application's own type, name, destinations and session duration
// keeps its other policies and its audience tag (checked on a throwaway application, 2026-10-23).
export async function attachAgentPolicy(A, appId, policy) {
  const app = await cf(`${A}/access/apps/${appId}`);
  const policies = app.policies || [];
  if (policies.some((p) => p.id === policy.id)) return false;
  const next = [...policies.map((p, i) => ({ id: p.id, precedence: p.precedence ?? i + 1 })), { id: policy.id, precedence: policies.length + 1 }];
  await cf(`${A}/access/apps/${appId}`, {
    method: "PUT",
    body: { type: app.type, name: app.name, destinations: app.destinations, session_duration: app.session_duration, policies: next },
  });
  return true;
}

export async function previewsApp(A, siteId, name = `${siteId} previews`) {
  const apps = (await cf(`${A}/access/apps`)) || [];
  return apps.find((a) => a.name === name) || null;
}

// Waits until Access accepts a new service token on a URL (it refuses one for a few seconds until Access has it
// everywhere, seen 2026-10-26), up to two minutes. Returns the seconds it took.
export async function waitForToken(url, token, timeoutMs = 120_000) {
  const headers = { "CF-Access-Client-Id": token.clientId, "CF-Access-Client-Secret": token.clientSecret };
  const t0 = Date.now();
  for (;;) {
    const r = await fetch(`${url}/api/health`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.status === 200) return Math.round((Date.now() - t0) / 1000);
    if (Date.now() - t0 > timeoutMs) throw new Error(`Access still refuses the new service token after ${timeoutMs / 1000} s (last: HTTP ${r?.status ?? "no response"}); is the "${AGENT_POLICY}" policy on the previews application?`);
    await new Promise((res) => setTimeout(res, 3000));
  }
}

// A short-lived service token. The secret is only in memory and only returned to the caller.
export async function mintCheckToken(A, label, duration = "30m") {
  const t = await cf(`${A}/access/service_tokens`, { method: "POST", body: { name: `${TOKEN_PREFIX} ${label}`.slice(0, 100), duration } });
  return { id: t.id, clientId: t.client_id, clientSecret: t.client_secret };
}

export async function deleteCheckToken(A, id) {
  await cf(`${A}/access/service_tokens/${id}`, { method: "DELETE", allow404: true });
}

// Deletes check tokens that have outlived any run (a run that crashed before its cleanup).
export async function sweepCheckTokens(A, olderThanMinutes = 60) {
  const all = (await cf(`${A}/access/service_tokens`)) || [];
  const cutoff = Date.now() - olderThanMinutes * 60_000;
  const stale = all.filter((t) => t.name?.startsWith(TOKEN_PREFIX) && Date.parse(t.created_at) < cutoff);
  for (const t of stale) await deleteCheckToken(A, t.id);
  return stale.length;
}
