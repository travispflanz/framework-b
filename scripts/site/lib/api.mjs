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

export async function cf(path, { method = "GET", body, token = env("CLOUDFLARE_API_TOKEN"), allow404 = false } = {}) {
  const res = await fetch(`${CF}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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
