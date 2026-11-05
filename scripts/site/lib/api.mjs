// Thin clients for the Cloudflare and GitHub REST APIs, used by the site scripts.
// Tokens come from the environment and are never printed.

const CF = "https://api.cloudflare.com/client/v4";
const GH = "https://api.github.com";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function env(name, { required = true } = {}) {
  const v = process.env[name];
  if (required && !v) throw new Error(`Missing environment variable ${name}`);
  return v || "";
}

// GET requests are retried on 429, 5xx and network failures with exponential backoff and jitter, as Cloudflare
// advises for its API ("Retry failed API requests that return 429 or 5xx status codes with exponential backoff and
// random jitter", Cloudflare Tunnel docs, "Tunnels for platforms", checked 2026-11-05). A preview check once failed on
// one 500 ("12001 Internal server error") while polling Workers Builds. Writes are not retried: they may have landed.
export const RETRY = { attempts: 4, baseMs: 2000 };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (status) => status === 429 || status >= 500;

export async function cf(path, { method = "GET", body, token = env("CLOUDFLARE_API_TOKEN"), allow404 = false } = {}) {
  let res;
  for (let attempt = 1; ; attempt++) {
    const retry = method === "GET" && attempt < RETRY.attempts;
    try {
      res = await fetch(`${CF}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (!retry) throw e;
      await pause(RETRY.baseMs * 2 ** (attempt - 1) * (1 + Math.random()));
      continue;
    }
    if (!(retry && transient(res.status))) break;
    await pause(RETRY.baseMs * 2 ** (attempt - 1) * (1 + Math.random()));
  }
  const json = await res.json().catch(() => null);
  if (allow404 && res.status === 404) return null;
  if (!res.ok || json?.success === false) {
    const msg = json?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new ApiError(`Cloudflare ${method} ${path.replace(/\/accounts\/[0-9a-f]{32}/, "/accounts/…")}: ${msg}`, res.status, json);
  }
  return json?.result ?? json;
}

export async function gh(path, { method = "GET", body, token = env("GH_SITES_TOKEN"), allow404 = false } = {}) {
  const res = await fetch(`${GH}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "framework-b-site-scripts",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  const json = res.status === 204 ? {} : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(`GitHub ${method} ${path}: HTTP ${res.status} ${json?.message || ""}`.trim(), res.status, json);
  return json;
}

export function log(step, detail = "") {
  console.log(`• ${step}${detail ? `: ${detail}` : ""}`);
}
