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
 * Status: notifications and auto-replies proven end to end on 2026-10-27. CRM rows ("rows") untested.
 *
 * Request body (JSON):
 * {
 *   "secret": "<MAILER_SECRET>",
 *   "site": "Site name",
 *   "notify": { "to": "owner@example.com", "subject": "...", "text": "...", "replyTo": "lead@example.com" },
 *   "reply":  { "to": "lead@example.com", "subject": "...", "text": "...", "html": "...", "fromName": "..." },  // optional
 *   "rows":   { "sheet": "<site id>", "values": [ { "id": "<lead id>", ... }, ... ] }                    // optional
 * }
 * Response (JSON): { "ok": true, "sent": 2, "remaining": 96, "rows": { "added": 1, "existing": 0 } } or
 *                  { "ok": false, "error": "..." }
 *
 * "rows" is the CRM mirror (packages/core/src/crm.js): each lead becomes a row in the spreadsheet "Framework B
 * leads" in this account's Drive (created on first use; its id is kept in the script property LEADS_SHEET_ID),
 * one tab per site. A lead id the tab already has is skipped, so the same rows can be sent again safely. New
 * fields add columns at the end. Values that start with = + - or @ are stored as text, never as formulas.
 */

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var expected = PropertiesService.getScriptProperties().getProperty("MAILER_SECRET");
    if (!expected || body.secret !== expected) return json_({ ok: false, error: "unauthorized" });

    var rows = body.rows ? appendRows_(body.rows) : undefined;
    var needed = (body.notify ? 1 : 0) + (body.reply ? 1 : 0);
    if (!needed) return json_({ ok: true, sent: 0, remaining: MailApp.getRemainingDailyQuota(), rows: rows });
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
    return json_({ ok: true, sent: sent, remaining: MailApp.getRemainingDailyQuota(), rows: rows });
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

function appendRows_(rows) {
  var list = (rows && rows.values) || [];
  if (!list.length) return { added: 0, existing: 0 };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty("LEADS_SHEET_ID");
    var book = null;
    if (id) {
      try { book = SpreadsheetApp.openById(id); } catch (e) { book = null; }
    }
    if (!book) {
      book = SpreadsheetApp.create("Framework B leads");
      props.setProperty("LEADS_SHEET_ID", book.getId());
    }
    var name = clip_(rows.sheet || "leads", 90);
    var sheet = book.getSheetByName(name) || book.insertSheet(name);
    var header = sheet.getLastRow() > 0 ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : ["id"];
    list.forEach(function (v) {
      Object.keys(v).forEach(function (k) { if (header.indexOf(k) < 0) header.push(k); });
    });
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    var known = {};
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) { known[String(r[0])] = true; });
    }
    var added = 0;
    list.forEach(function (v) {
      if (!v.id || known[String(v.id)]) return;
      sheet.appendRow(header.map(function (k) { return cell_(v[k]); }));
      known[String(v.id)] = true;
      added++;
    });
    return { added: added, existing: list.length - added };
  } finally {
    lock.releaseLock();
  }
}

function cell_(v) {
  var s = v == null ? "" : String(v).slice(0, 5000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
