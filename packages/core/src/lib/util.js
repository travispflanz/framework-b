// Small helpers shared by the core Worker. No dependencies.

export const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// A minimal HTML page for Worker-rendered screens (unsubscribe, admin). Never indexed.
export function page(title, bodyHtml, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}
a{color:#0b57d0}button{font:inherit;padding:.5rem 1rem}pre{white-space:pre-wrap}</style></head>
<body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}

export function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// Spreadsheet formula injection guard: prefix cells that start with = + - @ tab or CR.
export function csv(rows) {
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// Keep a file name readable but safe as an R2 key segment and a download name.
export function safeFileName(name) {
  const cleaned = String(name || "file")
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 100);
  return cleaned || "file";
}
