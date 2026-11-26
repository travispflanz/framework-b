// One retry for what the network, not the site, gets wrong during a QA run. Production QA on a test site failed twice
// on one page before passing unchanged (2026-11-25): a page load that timed out waiting for "load" (a form page also
// loads Turnstile from Cloudflare), and Lighthouse's robots-txt audit, while robots.txt answered 200 in under a second
// and three more Lighthouse runs on the page passed it. A real fault happens again on the retry and still fails;
// every retry is printed, so a flaky page is seen.

// A page load that failed on the way (a timeout or a network error), not a page that answered.
export const isTransientLoadError = (e) => e?.name === "TimeoutError" || /Timeout \d+ms exceeded|net::ERR_/.test(String(e?.message || ""));

const firstLine = (s) => String(s || "").split("\n")[0].trim();

// page.goto, loaded once more after a transient failure; `note` hears about the retry.
export async function gotoWithRetry(page, url, options, note = () => {}) {
  try {
    return await page.goto(url, options);
  } catch (e) {
    if (!isTransientLoadError(e)) throw e;
    note(`${url}: ${firstLine(e.message)}; loading it once more`);
    return page.goto(url, options);
  }
}

// Why a Lighthouse result is worth one more run: the page itself didn't load (a runtime error), or an audit failed
// because a fetch failed (robots.txt, in the case seen) or a server answered 5xx. Returns the reasons; none means keep it.
const FETCH = /fetch of .+ failed|failed to fetch|unable to (download|load|fetch)|net::ERR_|timed? ?out/i;
export function transientAudits(lhr) {
  if (lhr?.runtimeError) return [`${lhr.runtimeError.code || "runtime error"}: ${firstLine(lhr.runtimeError.message)}`];
  return Object.values(lhr?.audits || {})
    .filter((a) => (a.score !== null && a.score < 1) || a.scoreDisplayMode === "error")
    .filter((a) => FETCH.test(`${a.explanation || ""} ${a.errorMessage || ""}`) || /HTTP status: 5\d\d/.test(a.displayValue || ""))
    .map((a) => `${a.id}: ${firstLine(a.explanation || a.errorMessage || a.displayValue)}`);
}
