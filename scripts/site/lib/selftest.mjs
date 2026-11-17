// The live self-test's own pieces (.github/workflows/site-selftest.yml), kept in scripts so that a self-test run with
// `framework_ref` set to a branch tests them before they merge:
// - a self-test site takes bigger files than the default, so the live lead can send one over 10 MB (create.mjs);
// - the probe that checks the per-IP rate limit on the live site (verify-lead.mjs).

// A self-test site: its id starts with selftest- (the ids `site selftest` makes, which teardown removes without a
// confirmation) and it runs the Turnstile test keys. Its forms take files up to 20 MB, so the self-test can send one
// between the 10 MB default (packages/core/src/config.js) and that cap. Every other site keeps the default.
export const SELFTEST_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const isSelftestSite = (id, turnstileMode) => turnstileMode === "test" && /^selftest-/.test(id);

export function selftestUploads(config) {
  for (const form of Object.values(config.forms || {})) {
    if (!form.file) continue;
    form.file.maxBytes = SELFTEST_UPLOAD_MAX_BYTES;
    if (form.file.hint) form.file.hint = form.file.hint.replace(/\b\d+ MB\b/, `${SELFTEST_UPLOAD_MAX_BYTES / 1024 / 1024} MB`);
  }
  return config;
}

// Posts to a live form endpoint, one after another, until the per-IP rate limit answers. Core checks the limiter
// before it reads the body or Turnstile (packages/core/src/forms.js), and these posts carry no Turnstile token, so
// each post the limiter lets through is refused with 403 turnstile_missing: nothing is stored, no mail is sent and
// Turnstile's siteverify is never called. A post the limiter stops gets 429 rate_limited.
//
// The limit is approximate: counts are kept per Cloudflare location and are eventually consistent, so "requests can
// exceed your configured limit before those updates arrive"
// (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, checked 2026-11-17). The probe
// therefore passes on the first 429 however many posts got through first, and fails only when every one of
// `attempts` posts (eight times the limit by default) got past the limiter within one period. Anything else (an
// unexpected answer, a network error, a burst slower than a period) is inconclusive.
export async function probeRateLimit({ url, form, limit = 5, periodSeconds = 60, attempts = limit * 8, gapMs = 200, fetchImpl = fetch, now = Date.now }) {
  const endpoint = new URL(`/api/submit/${encodeURIComponent(form)}`, url).toString();
  const origin = new URL(url).origin;
  const answers = [];
  const start = now();
  let limitedAt = 0;
  for (let i = 1; i <= attempts; i++) {
    let status = 0;
    let error = "";
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { origin, "content-type": "application/json", accept: "application/json" },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      status = res.status;
      error = String((await res.json().catch(() => null))?.error || "");
    } catch (e) {
      error = e?.name === "TimeoutError" ? "timeout" : "network error";
    }
    answers.push({ status, error });
    if (status === 429 && error === "rate_limited") {
      limitedAt = i;
      break;
    }
    if (i < attempts && gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  const elapsedMs = now() - start;
  const allowed = answers.filter((a) => a.status === 403 && a.error.startsWith("turnstile_")).length;
  const counts = {};
  for (const a of answers) {
    const k = `${a.status || "no answer"} ${a.error || "(no error code)"}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const seen = Object.entries(counts).map(([k, n]) => `${k} ×${n}`).join(", ");
  const secs = (elapsedMs / 1000).toFixed(1);
  let result;
  let detail;
  if (limitedAt) {
    result = "pass";
    detail = `post ${limitedAt} was refused with 429 rate_limited after ${allowed} got through, in ${secs} s (limit ${limit} per ${periodSeconds} s per address, approximate)`;
  } else if (allowed === attempts && elapsedMs < periodSeconds * 1000) {
    result = "fail";
    detail = `all ${attempts} posts got past the limiter in ${secs} s, ${attempts / limit} times the limit of ${limit} per ${periodSeconds} s`;
  } else {
    result = "inconclusive";
    detail = allowed === attempts
      ? `all ${attempts} posts got through, but over ${secs} s, longer than one ${periodSeconds} s period`
      : `no 429 in ${answers.length} posts, and not every post reached the limiter check (${seen})`;
  }
  return { result, detail, endpoint, sent: answers.length, limitedAt, allowed, elapsedMs, answers: seen };
}
