// GET /u shows a confirm button (mail scanners prefetch links, so GET never changes anything).
// POST /u unsubscribes. Links are HMAC-signed per site and address.

import { verify } from "./lib/crypto.js";
import { escapeHtml, page } from "./lib/util.js";

export async function handleUnsubscribe(request, env, config) {
  const url = new URL(request.url);
  let email = url.searchParams.get("e") || "";
  let token = url.searchParams.get("t") || "";
  if (request.method === "POST") {
    const form = await request.formData();
    email = form.get("e") || email;
    token = form.get("t") || token;
  }
  email = email.toLowerCase().slice(0, 254);
  const name = escapeHtml(config.site.name);

  const valid = email && token && (await verify(env.SIGNING_SECRET, `unsub:${config.site.id}:${email}`, token));
  if (!valid) return page("Link not valid", `<h1>This link isn't valid</h1><p>Reply to any email from ${name} and we'll remove you.</p>`, 400);

  if (request.method === "POST") {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO subscribers (site, email, status, source_form, consent_text, created_at, updated_at, unsubscribed_at)
       VALUES (?, ?, 'unsubscribed', 'unsubscribe', '', ?, ?, ?)
       ON CONFLICT (site, email) DO UPDATE SET status = 'unsubscribed', updated_at = excluded.updated_at,
         unsubscribed_at = excluded.unsubscribed_at`,
    ).bind(config.site.id, email, now, now, now).run();
    return page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${escapeHtml(email)} won't get any more emails from ${name}.</p>`);
  }

  return page(
    "Unsubscribe",
    `<h1>Unsubscribe from ${name}?</h1>
<form method="post" action="/u"><input type="hidden" name="e" value="${escapeHtml(email)}">
<input type="hidden" name="t" value="${escapeHtml(token)}"><p>${escapeHtml(email)}</p>
<button type="submit">Unsubscribe</button></form>`,
  );
}
