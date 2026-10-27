// Drips (docs/SPEC.md section 10): a short series of emails after someone fills in a form, one Cloudflare Workflow
// instance per lead. Launch sites only: the emails go through Resend from the site's mail.<domain>.
//
//   "drips": {
//     "forms": ["contact"],
//     "emails": [
//       { "after": "1 day", "subject": "...", "text": "..." },
//       { "after": "4 days", "subject": "...", "text": "..." }
//     ]
//   }
//
// `after` is the wait since the previous email (or since the form, for the first one): "<n> minutes|hours|days|
// weeks". `text` is plain text; a blank line starts a new paragraph and URLs become links.
// Before every email the instance reads the subscriber's status in D1 and stops if they have unsubscribed. Each
// email is marketing mail: List-Unsubscribe with one-click POST, the postal address and an unsubscribe link.
// The Resend idempotency key is `drip-<lead>-<n>`, so a retried step never sends twice.
//
// The site's Worker exports the class (`export const DripWorkflow = dripWorkflow(config)`, from index.js), and wrangler.jsonc binds
// it as DRIPS: { "name": "<site id>-drips", "binding": "DRIPS", "class_name": "DripWorkflow" }.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { parseAfter } from "./drips-config.js";
import { unsubscribeUrl } from "./mailers.js";
import { escapeHtml } from "./lib/util.js";

// The sender: drips.from (default "news") at the Resend domain of email.confirmFrom.
export function dripFrom(config) {
  const domain = String(config.email.confirmFrom || "").split("@")[1];
  return `${config.drips?.from || "news"}@${domain}`;
}

// Plain text to minimal HTML: paragraphs, line breaks and linked URLs. No images, no tracking.
export function textToHtml(text) {
  const link = (s) => s.replace(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g, (u) => `<a href="${u}">${u}</a>`);
  return String(text)
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${link(escapeHtml(p)).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// One drip email as a Resend request body.
export function dripMessage(config, n, to, unsubUrl) {
  const e = config.drips.emails[n];
  const name = config.site.name;
  const footer = ["", "--", name, config.site.postalAddress, `Unsubscribe: ${unsubUrl}`].join("\n");
  const html =
    `<div style="font-family:sans-serif;font-size:15px;line-height:1.5">${textToHtml(e.text)}` +
    `<p style="color:#555;font-size:13px">${escapeHtml(name)}<br>${escapeHtml(config.site.postalAddress)}<br>` +
    `<a href="${escapeHtml(unsubUrl)}">Unsubscribe</a></p></div>`;
  return {
    from: `${name} <${dripFrom(config)}>`,
    to: [to],
    reply_to: config.email.replyTo || config.site.ownerEmail,
    subject: e.subject,
    text: `${String(e.text).trim()}\n${footer}`,
    html,
    headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

// Called after a lead is saved. Starts one instance per lead (the lead id makes a repeat a no-op).
export async function startDrip(env, config, formId, lead) {
  if (!config.drips?.forms?.includes(formId)) return false;
  if (!env.DRIPS) {
    console.error("drips: the DRIPS Workflow binding is missing from wrangler.jsonc");
    return false;
  }
  await env.DRIPS.create({ id: `drip-${lead.id}`, params: { lead: lead.id, email: lead.email } });
  return true;
}

async function subscribed(env, config, email) {
  const row = await env.DB.prepare("SELECT status FROM subscribers WHERE site = ? AND email = ?").bind(config.site.id, email).first();
  return row?.status === "subscribed";
}

async function send(env, body, key) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`resend: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = await res.json().catch(() => ({}));
  return data.id || "";
}

// The Workflow class for a site. Step names are stable ("wait 1", "check 1", "send 1", ...) so tests and
// `wrangler workflows instances describe` can find them.
export function dripWorkflowClass(config) {
  return class DripWorkflow extends WorkflowEntrypoint {
    async run(event, step) {
      const { lead, email } = event.payload;
      const emails = config.drips?.emails || [];
      const sent = [];
      for (let i = 0; i < emails.length; i++) {
        const n = i + 1;
        const wait = parseAfter(emails[i].after);
        if (wait?.n > 0) await step.sleep(`wait ${n}`, wait.duration);
        const still = await step.do(`check ${n}`, async () => subscribed(this.env, config, email));
        if (!still) return { lead, sent, stopped: `unsubscribed before email ${n}` };
        const id = await step.do(`send ${n}`, { retries: { limit: 5, delay: "1 minute", backoff: "exponential" } }, async () => {
          const unsub = await unsubscribeUrl(this.env, config, `https://${config.site.canonicalHost}`, email);
          return send(this.env, dripMessage(config, i, email, unsub), `drip-${lead}-${n}`);
        });
        sent.push(id);
      }
      return { lead, sent };
    }
  };
}
