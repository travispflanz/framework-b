// Reads and checks site.config.json once, when the Worker module loads.
// Every brand value the runtime uses comes from here; nothing site-specific is hard-coded.

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

  cfg.optIn = { text: DEFAULT_OPT_IN_TEXT, ...(cfg.optIn || {}) };

  // CRM mirror (src/crm.js): copy each lead to the owner's Google Sheet and/or a webhook. Off unless set.
  cfg.crm = { sheet: false, webhook: false, ...(cfg.crm || {}) };
  for (const k of ["sheet", "webhook"]) if (typeof cfg.crm[k] !== "boolean") errors.push(`crm.${k} must be true or false`);

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
  }

  if (errors.length) throw new Error("site.config.json is invalid:\n- " + errors.join("\n- "));
  return cfg;
}
