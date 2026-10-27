// Cloudflare Access service-token auth for checks against a protected URL (a site's previews).
//
// The token headers go only to the checked URL's own origin. Requests to other hosts (Turnstile, fonts,
// anything a page loads) never see them. This works with Access's "strict service token authentication", where
// Access issues no CF_Authorization cookie and every request has to carry the headers
// (https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/,
// checked 2026-10-23).
//
//   const auth = accessAuth(baseUrl);        // reads ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET
//   auth.on                                  // false when either is unset: every helper is then a no-op
//   await auth.fetch(url, init)              // fetch, with the headers when url is on the base origin
//   await auth.playwright(context)           // Playwright BrowserContext: adds them to same-origin requests
//   await auth.puppeteer(page)               // Puppeteer Page (Lighthouse): same, through CDP Fetch interception
export function accessAuth(base, env = process.env) {
  const id = env.ACCESS_CLIENT_ID || "";
  const secret = env.ACCESS_CLIENT_SECRET || "";
  const origin = new URL(base).origin;
  const on = !!(id && secret);
  const headers = on ? { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret } : {};
  const sameOrigin = (url) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };

  return {
    on,
    origin,
    sameOrigin,
    fetch(url, init = {}) {
      if (!on || !sameOrigin(url)) return fetch(url, init);
      return fetch(url, { ...init, headers: { ...(init.headers || {}), ...headers } });
    },
    async playwright(context) {
      if (!on) return;
      await context.route((url) => url.origin === origin, (route) =>
        route.continue({ headers: { ...route.request().headers(), ...headers } }));
    },
    async puppeteer(page) {
      if (!on) return;
      const cdp = await page.createCDPSession();
      // Only requests matching the pattern pause; everything else is never intercepted.
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/*`, requestStage: "Request" }] });
      cdp.on("Fetch.requestPaused", (e) => {
        if (!sameOrigin(e.request.url)) return cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
        const merged = { ...e.request.headers, ...headers };
        return cdp.send("Fetch.continueRequest", {
          requestId: e.requestId,
          headers: Object.entries(merged).map(([name, value]) => ({ name, value: String(value) })),
        }).catch(() => {});
      });
    },
  };
}
