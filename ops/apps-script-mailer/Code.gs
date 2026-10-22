/**
 * Framework B mailer for idea-mode sites (sites on workers.dev, with no domain of their own).
 *
 * A Framework B Worker POSTs JSON here after it has saved a lead in D1. This script sends:
 *   1. a notification to the owner (always), and
 *   2. an auto-reply to the lead (only when the site turned it on).
 * Mail goes out from the Gmail account that owns this script.
 *
 * Quota: personal Gmail accounts get 100 recipients a day across all MailApp sends
 * (https://developers.google.com/apps-script/guides/services/quotas).
 *
 * Status: written 2026-10-22, NOT yet tested end to end. The template self-test must prove it.
 *
 * Request body (JSON):
 * {
 *   "secret": "<MAILER_SECRET>",
 *   "site": "Site name",
 *   "notify": { "to": "owner@example.com", "subject": "...", "text": "...", "replyTo": "lead@example.com" },
 *   "reply":  { "to": "lead@example.com", "subject": "...", "text": "...", "html": "...", "fromName": "..." }   // optional
 * }
 * Response (JSON): { "ok": true, "sent": 2, "remaining": 96 } or { "ok": false, "error": "..." }
 */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var expected = PropertiesService.getScriptProperties().getProperty("MAILER_SECRET");
    if (!expected || body.secret !== expected) return json_({ ok: false, error: "unauthorized" });

    var needed = (body.notify ? 1 : 0) + (body.reply ? 1 : 0);
    if (MailApp.getRemainingDailyQuota() < needed) return json_({ ok: false, error: "quota_exhausted" });

    var sent = 0;
    if (body.notify && valid_(body.notify.to)) {
      MailApp.sendEmail({
        to: body.notify.to,
        subject: clip_(body.notify.subject, 200),
        body: clip_(body.notify.text, 20000),
        replyTo: valid_(body.notify.replyTo) ? body.notify.replyTo : undefined,
        name: clip_(body.site || "Website", 80)
      });
      sent++;
    }
    if (body.reply && valid_(body.reply.to)) {
      MailApp.sendEmail({
        to: body.reply.to,
        subject: clip_(body.reply.subject, 200),
        body: clip_(body.reply.text, 20000),
        htmlBody: body.reply.html ? clip_(body.reply.html, 40000) : undefined,
        name: clip_(body.reply.fromName || body.site || "Website", 80)
      });
      sent++;
    }
    return json_({ ok: true, sent: sent, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err).slice(0, 300) });
  }
}

function doGet() {
  return json_({ ok: true, service: "framework-b-mailer" });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function valid_(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clip_(s, n) {
  return String(s == null ? "" : s).slice(0, n);
}
