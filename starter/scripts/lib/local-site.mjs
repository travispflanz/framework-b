// Runs the built site on a local Worker (wrangler dev) with local D1 and R2, for the e2e test and the QA gate.
// Turnstile test keys only; no mailer settings, so no email can be sent.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

function stripJsonc(text) {
  // Removes // comments that are not inside strings, then trailing commas.
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export async function startLocalSite({ port = 8799, name = "local" } = {}) {
  const state = `.wrangler/${name}-state`;
  const configPath = `.${name}.wrangler.jsonc`;
  const wr = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));
  wr.d1_databases[0] = { ...wr.d1_databases[0], database_name: name, database_id: "00000000-0000-0000-0000-000000000000" };
  if (wr.r2_buckets?.[0]) wr.r2_buckets[0].bucket_name = `${name}-uploads`;
  if (wr.ratelimits?.[0]) wr.ratelimits[0].namespace_id = "9001";
  wr.vars = { ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: name };
  writeFileSync(configPath, JSON.stringify(wr, null, 2));
  rmSync(state, { recursive: true, force: true });

  const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args, "--config", configPath], { encoding: "utf8" });
  wrangler("d1", "migrations", "apply", "DB", "--local", "--persist-to", state);

  const dev = spawn(
    "npx",
    ["wrangler", "dev", "--config", configPath, "--port", String(port), "--persist-to", state,
      "--var", "TURNSTILE_SECRET:1x0000000000000000000000000000000AA",
      "--var", `SIGNING_SECRET:${name}-signing-secret-at-least-32-characters`],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  dev.stdout.on("data", (d) => (log += d));
  dev.stderr.on("data", (d) => (log += d));

  const base = `http://localhost:${port}`;
  const stop = () => {
    try {
      process.kill(-dev.pid, "SIGTERM"); // npx, wrangler and workerd share the process group
    } catch {}
    rmSync(configPath, { force: true });
  };

  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        return {
          base,
          stop,
          sql: (q) => JSON.parse(wrangler("d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--command", q))[0].results,
          r2get: (key) => wrangler("r2", "object", "get", `${wr.r2_buckets[0].bucket_name}/${key}`, "--local", "--persist-to", state, "--pipe"),
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
export function launchBrowser() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    executablePath: process.env.PW_CHROMIUM || undefined,
    proxy: proxy ? { server: proxy, bypass: "localhost,127.0.0.1" } : undefined,
    args: proxy ? ["--ignore-certificate-errors"] : [],
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
