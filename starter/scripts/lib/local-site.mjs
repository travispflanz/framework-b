// Runs the built site on a local Worker (wrangler dev) with local D1 and R2, for the e2e test and the QA gate.
// Turnstile test keys only; no mailer settings, so no email can be sent.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { stripJsonc } from "./jsonc.mjs";

// A throwaway EmDash key for local runs, in EmDash's own format.
function localEmdashKey() {
  return execFileSync("npx", ["emdash", "secrets", "generate"], { encoding: "utf8" }).trim().split("\n").pop().trim();
}

export async function startLocalSite({ port = 8799, name = "local" } = {}) {
  const state = `${process.cwd()}/.wrangler/${name}-state`;
  // With client editing on, the Astro build writes the deployable config to dist/server/wrangler.json, with
  // paths relative to that folder; the local copy goes next to it.
  const editing = existsSync("dist/server/wrangler.json");
  const configPath = editing ? `dist/server/.${name}.wrangler.json` : `.${name}.wrangler.jsonc`;
  const wr = JSON.parse(stripJsonc(readFileSync(editing ? "dist/server/wrangler.json" : "wrangler.jsonc", "utf8")));
  const localId = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  wr.d1_databases = wr.d1_databases.map((d, i) => ({ ...d, database_name: `${name}-${d.binding.toLowerCase()}`, database_id: localId(i) }));
  wr.r2_buckets = (wr.r2_buckets || []).map((b) => ({ ...b, bucket_name: `${name}-${b.binding.toLowerCase()}` }));
  wr.kv_namespaces = (wr.kv_namespaces || []).map((k, i) => ({ ...k, id: `local${i}` }));
  if (wr.ratelimits?.[0]) wr.ratelimits[0].namespace_id = "9001";
  wr.vars = { ...(wr.vars || {}), ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: name };
  delete wr.previews;
  writeFileSync(configPath, JSON.stringify(wr, null, 2));
  rmSync(state, { recursive: true, force: true });
  const uploads = wr.r2_buckets.find((b) => b.binding === "UPLOADS");

  const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args, "--config", configPath], { encoding: "utf8" });
  wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", state);

  const dev = spawn(
    "npx",
    ["wrangler", "dev", "--config", configPath, "--port", String(port), "--persist-to", state,
      "--var", "TURNSTILE_SECRET:1x0000000000000000000000000000000AA",
      "--var", `SIGNING_SECRET:${name}-signing-secret-at-least-32-characters`,
      ...(editing ? ["--var", "CF_ACCESS_AUDIENCE:local", "--var", `EMDASH_ENCRYPTION_KEY:${localEmdashKey()}`] : [])],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));
  let exited = false;
  dev.on("exit", () => (exited = true));

  const base = `http://localhost:${port}`;
  const stop = () => {
    try {
      process.kill(-dev.pid, "SIGTERM"); // npx, wrangler and workerd share the process group
    } catch {}
    rmSync(configPath, { force: true });
  };

  // An EmDash build is a much larger Worker, so it gets longer to start.
  for (let i = 0; i < (editing ? 240 : 60) && !exited; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        return {
          base,
          stop,
          sql: (q) => JSON.parse(wrangler("d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", q))[0].results,
          r2get: (key) => wrangler("r2", "object", "get", `${uploads.bucket_name}/${key}`, "--local", "--persist-to", state, "--pipe"),
          editing,
          state,
        };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error("wrangler dev did not start:\n" + log);
}

// Chromium for Playwright. PW_CHROMIUM points at a preinstalled browser when Playwright's own isn't downloaded.
// Behind a TLS-inspecting proxy (some cloud sandboxes), certificate errors are ignored; never in CI.
export function launchBrowser({ args = [] } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    proxy: proxy ? { server: proxy, bypass: "localhost,127.0.0.1" } : undefined,
    args: [...(proxy ? ["--ignore-certificate-errors"] : []), ...args],
  });
}

export function checker() {
  let failures = 0;
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  return { check, results, failed: () => failures };
}

// Console errors the site can't fix: the Turnstile widget runs in Cloudflare's own iframe and logs its own
// CSP refusals and console tricks there. Only messages from that origin are ignored; the page's own errors count.
export function ownConsoleError(message) {
  if (message.type() !== "error") return false;
  try {
    return !new URL(message.location().url).host.endsWith("challenges.cloudflare.com");
  } catch {
    return true;
  }
}
