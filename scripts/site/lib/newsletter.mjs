// The pure parts of the newsletter module (scripts/site/newsletter.mjs): reading an issue file, turning its
// Markdown into email HTML and text, and deciding what each subscriber needs in Resend. No network access here.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// An issue is a Markdown file in the site repo (newsletter/<date>-<slug>.md) with a small front matter:
//   ---
//   subject: What's new this month
//   preview: One line shown after the subject in the inbox (optional)
//   ---
export function parseIssue(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("The issue needs front matter with a subject (--- subject: ... ---)");
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s*(.*)$/i.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  if (!meta.subject) throw new Error("The issue's front matter needs a subject");
  if (meta.subject.length > 150) throw new Error("The subject is longer than 150 characters");
  const body = m[2].trim();
  if (!body) throw new Error("The issue has no body");
  return { subject: meta.subject, preview: meta.preview || "", body };
}

// Inline Markdown: links, bold, italics. Only http(s) and mailto links are kept.
function inline(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
}

// The Markdown an issue may use: paragraphs, ## and ### headings, - and 1. lists, links, bold, italics.
export function markdownToHtml(md) {
  const out = [];
  const blocks = md.replace(/\r\n/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(lines[0]);
    if (h && lines.length === 1) {
      const level = Math.min(Math.max(h[1].length, 2), 3);
      out.push(`<h${level} style="margin:24px 0 8px;font-size:${level === 2 ? 20 : 17}px">${inline(h[2])}</h${level}>`);
    } else if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      out.push(`<ul style="padding-left:20px">${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`);
    } else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
      out.push(`<ol style="padding-left:20px">${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`);
    } else {
      out.push(`<p style="margin:0 0 16px">${lines.map(inline).join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}

export function markdownToText(md) {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[\s(])_([^_]+)_/g, "$1$2")
    .replace(/^#{1,3}\s+/gm, "")
    .trim();
}

// The whole email. Resend replaces {{{RESEND_UNSUBSCRIBE_URL}}} per recipient and adds the one-click
// List-Unsubscribe headers to broadcasts itself (resend.com/docs, broadcasts, checked 2026-10-27).
export const UNSUBSCRIBE = "{{{RESEND_UNSUBSCRIBE_URL}}}";
export function renderIssue(issue, { siteName, postalAddress, siteUrl }) {
  if (!postalAddress?.trim()) throw new Error("A postal address is required in marketing email (CAN-SPAM)");
  const preview = issue.preview ? `<div style="display:none;max-height:0;overflow:hidden">${esc(issue.preview)}</div>` : "";
  const html =
    `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff">${preview}` +
    `<div style="max-width:600px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1f1f1f">` +
    markdownToHtml(issue.body) +
    `<hr style="border:0;border-top:1px solid #dddddd;margin:32px 0 16px">` +
    `<p style="font-size:13px;color:#555555;margin:0">${esc(siteName)}${siteUrl ? ` · <a href="${esc(siteUrl)}">${esc(siteUrl.replace(/^https?:\/\//, ""))}</a>` : ""}<br>${esc(postalAddress.trim())}<br>` +
    `You get this because you signed up on our site. <a href="${UNSUBSCRIBE}">Unsubscribe</a></p>` +
    `</div></body></html>`;
  const text = `${markdownToText(issue.body)}\n\n--\n${siteName}${siteUrl ? ` · ${siteUrl}` : ""}\n${postalAddress.trim()}\nYou get this because you signed up on our site. Unsubscribe: ${UNSUBSCRIBE}\n`;
  return { subject: issue.subject, html, text };
}

// What each subscriber needs in Resend. D1 is the system of record per site; the site's Resend segment mirrors it.
//   subscribed in D1, no contact            → create the contact in the segment
//   subscribed in D1, contact not in segment → add to the segment
//   subscribed in D1, contact unsubscribed  → the person used a newsletter's unsubscribe link: record it in D1
//   unsubscribed in D1, contact in segment  → remove from the segment (never the global flag, which other
//                                             sites in the same Resend account share)
export function syncPlan(subscribers, contacts) {
  const plan = { create: [], addToSegment: [], removeFromSegment: [], unsubscribeInD1: [], unchanged: 0 };
  for (const s of subscribers) {
    const c = contacts.get(s.email.toLowerCase());
    if (s.status === "subscribed") {
      if (!c) plan.create.push(s);
      else if (c.unsubscribed) plan.unsubscribeInD1.push(s);
      else if (!c.inSegment) plan.addToSegment.push(s);
      else plan.unchanged++;
    } else if (c?.inSegment) plan.removeFromSegment.push(s);
    else plan.unchanged++;
  }
  return plan;
}
