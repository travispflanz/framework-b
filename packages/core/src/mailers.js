// Mail delivery after a lead is saved. D1 is written first, so a mail failure never loses a lead;
// the outcome is recorded on the lead row (notified / notify_error, confirmed / confirm_error).
//
// Mailers (see docs/SPEC.md section 6):
//   apps-script  idea sites; owner's Gmail via ops/apps-script-mailer (notification + optional auto-reply)
//   cloudflare   launch sites; owner notification via the send_email binding to the verified owner inbox
//   resend       launch sites; lead confirmation from mail.<domain>
//   none         skip

import { sign } from "./lib/crypto.js";

export async function unsubscribeUrl(env, config, origin, email) {
  const t = await sign(env.SIGNING_SECRET, `unsub:${config.site.id}:${email.toLowerCase()}`);
  return `${origin}/u?e=${encodeURIComponent(email.toLowerCase())}&t=${t}`;
}

function notifyMessage(config, form, formId, lead, origin) {
  const lines = [`New ${formId} submission on ${config.site.name}`, ""];
  for (const f of form.fields) {
    const v = lead.fields[f.name];
    const text = Array.isArray(v) ? v.join(", ") : v;
    if (text !== undefined && text !== "") lines.push(`${f.label || f.name}: ${text}`);
  }
  if (lead.upload) lines.push("", `File: ${lead.upload.name} (${lead.upload.size} bytes), uploading now. Open it from ${origin}/admin/lead/${lead.id}`);
  lines.push("", `Page: ${lead.page || "(unknown)"}`, `Lead: ${origin}/admin/lead/${lead.id}`);
  return {
    to: config.site.ownerEmail,
    subject: `[${config.site.name}] ${form.notifySubject || `New ${formId}`}: ${lead.fields.name || lead.email}`.slice(0, 200),
    text: lines.join("\n"),
    replyTo: lead.email,
  };
}

function confirmMessage(config, form, lead, unsubUrl) {
  const c = form.confirm || {};
  const subject = c.subject || `Thanks for contacting ${config.site.name}`;
  const body = c.text || `Thanks for getting in touch. We received your message and will reply soon.\n\n${config.site.name}`;
  const footer = ["", "--", config.site.name, ...(config.site.postalAddress ? [config.site.postalAddress] : []), `Unsubscribe: ${unsubUrl}`].join("\n");
  const text = `${body}\n${footer}`;
  // Minimal HTML: no images, no tracking, one link (see DECISIONS: plain transactional mail).
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html =
    `<div style="font-family:sans-serif;font-size:15px;line-height:1.5">` +
    esc(body).replace(/\n/g, "<br>") +
    `<p style="color:#555;font-size:13px">${esc(config.site.name)}${config.site.postalAddress ? "<br>" + esc(config.site.postalAddress) : ""}<br>` +
    `<a href="${esc(unsubUrl)}">Unsubscribe</a></p></div>`;
  return { to: lead.email, subject, text, html };
}

async function sendAppsScript(env, payload) {
  if (!env.MAILER_URL || !env.MAILER_SECRET) throw new Error("MAILER_URL or MAILER_SECRET not set");
  // Apps Script answers a POST with a 302 to a one-time URL; fetch follows it with a GET (fetch spec),
  // which is where the JSON result is. Untested end to end until the template self-test runs it.
  const res = await fetch(env.MAILER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.MAILER_SECRET, ...payload }),
    redirect: "follow",
  });
  const data = await res.json().catch(() => null);
  if (!data || data.ok !== true) throw new Error(`apps-script: ${data?.error || res.status}`);
  return data;
}

async function sendCloudflare(env, config, msg) {
  if (!env.EMAIL) throw new Error("EMAIL (send_email) binding missing");
  await env.EMAIL.send({
    to: msg.to,
    from: { email: config.email.notifyFrom, name: config.site.name },
    replyTo: msg.replyTo,
    subject: msg.subject,
    text: msg.text,
  });
}

async function sendResend(env, config, msg, idempotencyKey) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      from: `${config.site.name} <${config.email.confirmFrom}>`,
      to: [msg.to],
      reply_to: config.email.replyTo || config.site.ownerEmail,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    }),
  });
  if (!res.ok) throw new Error(`resend: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function record(env, id, column, error) {
  const errCol = column === "notified" ? "notify_error" : "confirm_error";
  await env.DB.prepare(`UPDATE leads SET ${column} = ?, ${errCol} = ? WHERE id = ?`)
    .bind(error ? 0 : 1, error ? String(error.message || error).slice(0, 500) : null, id)
    .run();
}

export async function deliver(env, config, formId, lead, origin) {
  const form = config.forms[formId];
  const { notify, confirm } = config.email;
  const wantsConfirm = confirm !== "none" && form.confirm?.enabled !== false;
  const notifyMsg = notify !== "none" ? notifyMessage(config, form, formId, lead, origin) : null;
  const confirmMsg = wantsConfirm ? confirmMessage(config, form, lead, await unsubscribeUrl(env, config, origin, lead.email)) : null;

  // apps-script sends both messages in one call when both use it.
  if (notify === "apps-script" || (wantsConfirm && confirm === "apps-script")) {
    const payload = { site: config.site.name };
    if (notify === "apps-script") payload.notify = notifyMsg;
    if (wantsConfirm && confirm === "apps-script") payload.reply = { ...confirmMsg, fromName: config.site.name };
    try {
      await sendAppsScript(env, payload);
      if (payload.notify) await record(env, lead.id, "notified");
      if (payload.reply) await record(env, lead.id, "confirmed");
    } catch (e) {
      if (payload.notify) await record(env, lead.id, "notified", e);
      if (payload.reply) await record(env, lead.id, "confirmed", e);
    }
  }
  if (notify === "cloudflare") {
    try {
      await sendCloudflare(env, config, notifyMsg);
      await record(env, lead.id, "notified");
    } catch (e) {
      await record(env, lead.id, "notified", e);
    }
  }
  if (wantsConfirm && confirm === "resend") {
    try {
      await sendResend(env, config, confirmMsg, `confirm-${lead.id}`);
      await record(env, lead.id, "confirmed");
    } catch (e) {
      await record(env, lead.id, "confirmed", e);
    }
  }
}
