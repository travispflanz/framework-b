// First-touch attribution: kept once per browser, sent with every form as attr_* fields.
// Stores only campaign tags, the first off-site referrer (no query string) and the landing path.
const KEY = "fb_attr";
try {
  if (!localStorage.getItem(KEY)) {
    const q = new URLSearchParams(location.search);
    const a = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "src", "ref"]) {
      const v = q.get(k);
      if (v) a[k] = v.slice(0, 300);
    }
    if (document.referrer) {
      const r = new URL(document.referrer);
      if (r.host !== location.host) a.referrer = r.origin + r.pathname;
    }
    a.landing = location.pathname;
    localStorage.setItem(KEY, JSON.stringify(a));
  }
} catch {
  /* storage blocked: attribution is best-effort */
}
