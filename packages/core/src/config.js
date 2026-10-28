// Reads and checks site.config.json once, when the Worker module loads.
// Every brand value the runtime uses comes from here; nothing site-specific is hard-coded.
import { dripErrors } from "./drips-config.js";

const FIELD_TYPES = new Set(["text", "email", "tel", "url", "textarea", "select", "checkbox", "hidden"]);
const MAILERS = new Set(["none", "apps-script", "cloudflare", "resend"]);

export const DEFAULT_UPLOAD_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const HARD_UPLOAD_MAX_BYTES = 95 * 1024 * 1024; // Cloudflare Free/Pro plans reject request bodies over 100 MB
export const DEFAULT_OPT_IN_TEXT = "You'll get occasional emails from us. Unsubscribe anytime.";
export const DEFAULT_CONSENT_LABEL = "Email me occasional news. Unsubscribe anytime.";

export function loadConfig(raw) {
  const errors = [];
  const cfg = structuredClone(raw || {});
  const site = cfg.site || {};

  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(site.id || "")) errors.push("site.id must be lowercase letters, digits and dashes");
  if (!site.name) errors.push("site.name is required");
  if (!["idea", "launch"].includes(site.mode)) errors.push('site.mode must be "idea" or "launch"');
  if (!site.canonicalHost) errors.push("site.canonicalHost is required");
  if (!site.ownerEmail) errors.push("site.ownerEmail is required");
  if (site.mode === "launch" && !site.postalAddress) errors.push("site.postalAddress is required in launch mode (CAN-SPAM)");
  site.indexing = site.indexing ?? site.mode === "launch";
  cfg.site = site;

  const email = (cfg.email = { notify: "none", confirm: "none", ...(cfg.email || {}) });
  if (!MAILERS.has(email.notify)) errors.push(`email.notify must be one of ${[...MAILERS].join(", ")}`);
  if (!MAILERS.has(email.confirm)) errors.push(`email.confirm must be one of ${[...MAILERS].join(", ")}`);
  if (email.notify === "resend") errors.push("email.notify cannot be resend; owner notifications use cloudflare or apps-script");
  if (email.confirm === "cloudflare") errors.push("email.confirm cannot be cloudflare on the Free plan; use resend or apps-script");
  if (email.notify === "cloudflare" && !email.notifyFrom) errors.push("email.notifyFrom is required for the cloudflare mailer");
  if (email.confirm === "resend" && !email.confirmFrom) errors.push("email.confirmFrom is required for the resend mailer");
  if (site.mode === "idea" && (email.notify === "cloudflare" || email.confirm === "resend")) {
    errors.push("idea sites have no domain to send from; use apps-script or none");
  }

  // Opt-in. "auto" (default): every form subscribes the visitor, with one line under the button (US CAN-SPAM).
  // "checkbox": a consent box; only a ticked box subscribes, and an unsubscribed address is subscribed again only by
  // ticking it. Use it for audiences in the EU, UK or Canada (GDPR, CASL) or when the owner wants explicit consent.
  // A form's `consent` is "required" (the box must be ticked to send) or "optional" (default) in checkbox mode.
  cfg.optIn = { mode: "auto", text: DEFAULT_OPT_IN_TEXT, label: DEFAULT_CONSENT_LABEL, ...(cfg.optIn || {}) };
  if (!["auto", "checkbox"].includes(cfg.optIn.mode)) errors.push('optIn.mode must be "auto" or "checkbox"');

  // /go: the entry point for printed QR codes and campaign links. It redirects to `go.to` (default "/") and keeps the
  // query string, so utm_* and src are recorded as attribution by the page's form script. Keep it working forever.
  cfg.go = { to: "/", ...(cfg.go || {}) };
  if (!/^\/(?!\/)/.test(cfg.go.to)) errors.push('go.to must be a path on this site, starting with "/"');

  // An adopted site's older unsubscribe links (src/unsubscribe.js): the name of the Worker secret that signed them.
  // Default LEGACY_UNSUB_SECRET; an adopted Worker keeps its own secret, whose value can't be read back or renamed.
  cfg.legacyUnsubSecret = cfg.legacyUnsubSecret ?? "LEGACY_UNSUB_SECRET";
  if (!/^[A-Z][A-Z0-9_]*$/.test(cfg.legacyUnsubSecret)) errors.push("legacyUnsubSecret must be a Worker secret name (A-Z, 0-9, _)");

  // CRM mirror (src/crm.js): copy each lead to the owner's Google Sheet and/or a webhook. Off unless set.
  cfg.crm = { sheet: false, webhook: false, ...(cfg.crm || {}) };
  for (const k of ["sheet", "webhook"]) if (typeof cfg.crm[k] !== "boolean") errors.push(`crm.${k} must be true or false`);

  // Drips (src/drips.js): an email series after a form, launch sites only. Checked after the forms below.
  const forms = cfg.forms || {};
  if (!Object.keys(forms).length) errors.push("forms: define at least one form");
  for (const [formId, form] of Object.entries(forms)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(formId)) errors.push(`forms.${formId}: id must be lowercase letters, digits and dashes`);
    const fields = form.fields || [];
    const names = new Set();
    for (const f of fields) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(f.name || "")) errors.push(`forms.${formId}: bad field name "${f.name}"`);
      if (f.name?.startsWith("attr_") || f.name?.startsWith("file_") || ["cf-turnstile-response", "website"].includes(f.name)) {
        errors.push(`forms.${formId}: field name "${f.name}" is reserved`);
      }
      if (!FIELD_TYPES.has(f.type)) errors.push(`forms.${formId}.${f.name}: unknown type "${f.type}"`);
      if (f.type === "select" && !Array.isArray(f.options)) errors.push(`forms.${formId}.${f.name}: select needs options`);
      if (names.has(f.name)) errors.push(`forms.${formId}: duplicate field "${f.name}"`);
      names.add(f.name);
      f.maxLength = f.maxLength || (f.type === "textarea" ? 5000 : 200);
    }
    const emailField = fields.find((f) => f.name === "email");
    if (!emailField || emailField.type !== "email" || !emailField.required) {
      errors.push(`forms.${formId}: every form needs a required "email" field of type email (auto opt-in)`);
    }
    if (form.file) {
      form.file = { enabled: true, maxBytes: DEFAULT_UPLOAD_MAX_BYTES, types: DEFAULT_UPLOAD_TYPES, ...form.file };
      if (form.file.maxBytes > HARD_UPLOAD_MAX_BYTES) errors.push(`forms.${formId}.file.maxBytes exceeds ${HARD_UPLOAD_MAX_BYTES}`);
    } else {
      form.file = { enabled: false };
    }
    form.thanks = form.thanks || "/thanks";
    form.consent = form.consent || "optional";
    if (!["required", "optional"].includes(form.consent)) errors.push(`forms.${formId}.consent must be "required" or "optional"`);
    if (fields.some((f) => f.name === "consent")) errors.push(`forms.${formId}: field name "consent" is reserved for the opt-in box`);
  }

  errors.push(...dripErrors(cfg));

  if (errors.length) throw new Error("site.config.json is invalid:\n- " + errors.join("\n- "));
  return cfg;
}
