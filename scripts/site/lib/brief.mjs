// The kickoff brief: the owner's one prompt turned into the answers to docs/SPEC.md section 3, each with where it
// came from. The agent writes brief.json from the prompt; this module checks it, fills every default, and turns it
// into create inputs, the site's forms and DECISIONS.md rows. The site keeps brief.json as the record of its kickoff.
//
// Who answered (`answeredBy`):
//   owner     the default: the owner's prompt gave the answers present in the input
//   agent     autopilot with no owner answers (the agent picked the idea and wrote the brief itself)
//
// Source of each answer:
//   stated    the owner said it (any field present in the input, when `answeredBy` is "owner")
//   agent     the agent chose it (any field present in the input, when `answeredBy` is "agent")
//   inferred  the agent decided it from research or the prompt; list its path in `inferred` ("forms.1.consent")
//   default   absent from the input; the framework default from SPEC section 3 applies
//
// Forms: a list of { id, purpose, kind, consent, title, submitLabel }; only `id` is required.
//   kind      "message" (someone answers it: contact, quote, booking request) or "waitlist" (a sign-up to hear news;
//             email and an optional name). Default: "waitlist" when the id, or the whole purpose, is a list's name
//             ("waitlist", "mailing list", "newsletter", "newsletter sign-up"), else "message": a purpose that only
//             mentions one ("questions about the newsletter") is a message form, so set `kind` when in doubt
//   consent   "none" (a plain message form: it adds no one to a list), or "optional" / "required" (in checkbox mode, a
//             consent box that may or must be ticked; in auto mode the line under the button subscribes either way).
//             Default: "required" for a waitlist in checkbox mode, else "optional". The site-wide `consent` is the mode
//
// Minimal input:  { "business": { "name": "Example Co" }, "owner": { "email": "owner@example.com" } }

// CRM mirror (core src/crm.js): copy each lead to the owner's Google Sheet, a webhook, or both.
export const CRM = ["none", "sheet", "webhook", "sheet+webhook"];
export const SHAPES = ["landing", "full", "hybrid"];
export const ANSWERED_BY = ["owner", "agent"];
// The same kinds as starter/src/lib/form-copy.js, and the consent values of packages/core/src/config.js (a test checks).
export const FORM_KINDS = ["message", "waitlist"];
export const FORM_CONSENT = ["none", "optional", "required"];
const FORM_ID = /^[a-z][a-z0-9-]{0,31}$/;
// A form named for a list: the id, or the whole purpose, and nothing else.
const LIST_NAME = /^(wait(ing)?[\s-]?list|mailing[\s-]?list|newsletter)([\s-]sign[\s-]?ups?)?$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GDPR_CASL = new Set(["eu", "uk", "ca", "eea"]);
// The same lists as starter/scripts/design-tokens.mjs (a test checks they match).
export const IMAGERY_STYLES = ["owner-photo", "documentary-stock", "photoreal-generated", "line-art", "flat-illustration", "watercolor", "3d", "isometric", "collage", "cartoon", "abstract", "icon-led"];
export const TREATMENTS = ["none", "duotone", "tint", "warm", "cool", "mono"];

export const slug = (name) =>
  String(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42).replace(/-+$/, "");

const get = (o, path) => path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), o);
const isBool = (v) => typeof v === "boolean";

// Returns { brief, sources, errors, warnings }. `brief` is complete: every answer has a value.
export function normalizeBrief(input) {
  const errors = [];
  const warnings = [];
  const inferred = new Set(Array.isArray(input?.inferred) ? input.inferred : []);
  const sources = {};
  // Who gave the answers present in the input: the owner (default), or the agent on autopilot with no owner answers.
  const answeredBy = input?.answeredBy ?? "owner";
  const present = answeredBy === "agent" ? "agent" : "stated";
  const pick = (path, fallback, check) => {
    const v = get(input, path);
    if (v === undefined || v === null || v === "") {
      sources[path] = "default";
      return typeof fallback === "function" ? fallback() : fallback;
    }
    if (check && !check(v)) errors.push(`${path}: ${JSON.stringify(v)} is not valid`);
    sources[path] = inferred.has(path) ? "inferred" : present;
    return v;
  };

  if (!input || typeof input !== "object") return { brief: null, sources, errors: ["the brief must be a JSON object"], warnings };
  if (input.version !== undefined && input.version !== 1) errors.push(`version ${input.version} is not supported (expected 1)`);
  if (!ANSWERED_BY.includes(answeredBy)) errors.push(`answeredBy: ${JSON.stringify(answeredBy)} is not valid (expected "owner" or "agent")`);

  const name = pick("business.name", "", (v) => typeof v === "string" && v.trim().length > 0);
  if (!name) errors.push("business.name is required");
  const email = String(pick("owner.email", "", (v) => EMAIL.test(v))).trim().toLowerCase();
  if (!email) errors.push("owner.email is required");
  // The inbox is always the owner's, even on autopilot: it is never guessed (docs/BUILD.md step 1).
  if (sources["owner.email"] === "agent") sources["owner.email"] = "stated";
  const id = pick("business.id", () => slug(name), (v) => /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(v));
  if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(id)) errors.push(`site id "${id}" must be 3-42 lowercase letters, digits or dashes, starting with a letter; set business.id`);

  const mode = pick("mode", "idea", (v) => ["idea", "launch"].includes(v));
  if (mode === "launch") errors.push("site create makes idea sites only: build it as an idea, then run site promote to put it on its domain (docs/SPEC.md section 2)");
  const region = String(pick("audienceRegion", "us", (v) => typeof v === "string")).toLowerCase();
  // Consent: "auto" (every form subscribes, US CAN-SPAM) or "checkbox" (a consent box; only a ticked box subscribes).
  const consent = pick("consent", () => (GDPR_CASL.has(region) ? "checkbox" : "auto"), (v) => ["auto", "checkbox"].includes(v));
  if (GDPR_CASL.has(region) && consent === "auto") warnings.push(`audienceRegion "${region}" with consent "auto": every form opts visitors in automatically, which GDPR and CASL generally don't allow; use consent "checkbox" or ask the owner (SPEC section 5)`);

  const forms = normalizeForms(pick("forms", () => [{ id: "contact", purpose: "contact" }], (v) => Array.isArray(v) && v.length > 0 && v.every((f) => f && typeof f === "object")), {
    consent, inferred, present, sources, errors, warnings, given: Array.isArray(input.forms) ? input.forms : [], formsInferred: inferred.has("forms"),
  });
  const newsletter = pick("newsletter", false, isBool);
  const noneSubscribe = forms.length > 0 && forms.every((f) => f.consent === "none");
  if (newsletter && noneSubscribe) warnings.push('newsletter is on, but every form has consent "none": no form collects subscribers; give a waitlist or a sign-up form a consent other than "none"');
  else if (newsletter && mode === "idea") warnings.push("newsletter on an idea site means subscriber collection only: the forms that subscribe collect them now; sending starts at launch (DECISIONS 2026-10-23)");
  const autoReply = pick("autoReply", false, isBool);
  if (autoReply && mode === "idea") warnings.push("lead auto-replies on an idea site go through the owner's Gmail (Apps Script mailer, 100 recipients a day shared by all idea sites)");

  const brief = {
    version: 1,
    answeredBy,
    business: {
      name,
      id,
      offer: pick("business.offer", ""),
      audience: pick("business.audience", ""),
      location: pick("business.location", ""),
      serviceArea: pick("business.serviceArea", []),
      phone: pick("business.phone", ""),
      postalAddress: pick("business.postalAddress", ""),
    },
    owner: { email },
    mode,
    audienceRegion: region,
    consent,
    shape: pick("shape", "landing", (v) => SHAPES.includes(v)),
    forms,
    autoReply,
    indexing: pick("indexing", false, isBool),
    editing: pick("editing", false, isBool),
    newsletter,
    crm: pick("crm", "none", (v) => CRM.includes(v)),
    design: {
      autopilot: pick("design.autopilot", true, isBool),
      // What kind of pictures the site uses (DESIGN.md `imagery`): ask the owner, or infer from the industry.
      imagery: {
        style: pick("design.imagery.style", "owner-photo", (v) => IMAGERY_STYLES.includes(v)),
        secondary: pick("design.imagery.secondary", "", (v) => v === "" || IMAGERY_STYLES.includes(v)),
        treatment: pick("design.imagery.treatment", "none", (v) => TREATMENTS.includes(v)),
      },
      words: pick("design.words", []),
      references: pick("design.references", []),
      avoid: pick("design.avoid", []),
    },
    facts: pick("facts", {}),
    claims: pick("claims", []),
    inferred: [...inferred],
  };
  if (brief.design.imagery.style === "photoreal-generated") warnings.push("design.imagery.style photoreal-generated: generated photos never show the business's own people, premises, products or work; they are listed on /credits; owner photos are better wherever the owner has them");
  if (brief.crm.includes("webhook")) warnings.push(`crm "${brief.crm}": the webhook needs its URL as the Worker secret CRM_WEBHOOK_URL (and optionally CRM_WEBHOOK_SECRET) before leads are sent to it`);
  if (!brief.business.offer) warnings.push("business.offer is empty: the hero needs a one-line offer; infer one and list it in `inferred`");
  for (const c of brief.claims) if (!c?.text || !c?.source) errors.push(`claims: every claim needs text and an owner source (${JSON.stringify(c)})`);
  return { brief, sources, errors, warnings };
}

// Each form with every setting filled: { id, purpose, kind, consent, title?, submitLabel? }. Records each form's
// kind and consent source as forms.<n>.kind and forms.<n>.consent.
function normalizeForms(list, { consent: mode, inferred, present, sources, errors, warnings, given, formsInferred }) {
  const ids = new Set();
  return (Array.isArray(list) ? list : []).map((f, i) => {
    const raw = given[i] || {};
    const source = (key) => {
      const v = raw[key];
      if (v === undefined || v === null || v === "") return "default";
      return inferred.has(`forms.${i}.${key}`) || formsInferred ? "inferred" : present;
    };
    const id = String(f?.id ?? "");
    if (!FORM_ID.test(id)) errors.push(`forms.${i}.id: ${JSON.stringify(f?.id)} must be 1-32 lowercase letters, digits or dashes, starting with a letter`);
    else if (ids.has(id)) errors.push(`forms.${i}.id: "${id}" is used twice`);
    ids.add(id);
    const purpose = typeof f?.purpose === "string" ? f.purpose : "";
    const kind = f?.kind ?? (LIST_NAME.test(id) || LIST_NAME.test(purpose.trim()) ? "waitlist" : "message");
    if (!FORM_KINDS.includes(kind)) errors.push(`forms.${i}.kind: ${JSON.stringify(kind)} is not valid (expected ${FORM_KINDS.join(" or ")})`);
    const formConsent = f?.consent ?? (kind === "waitlist" && mode === "checkbox" ? "required" : "optional");
    if (!FORM_CONSENT.includes(formConsent)) errors.push(`forms.${i}.consent: ${JSON.stringify(formConsent)} is not valid (expected ${FORM_CONSENT.join(", ")})`);
    if (kind === "waitlist" && formConsent === "none") errors.push(`forms.${i}: a waitlist with consent "none" adds no one to the list; drop the consent or make it kind "message"`);
    if (mode === "auto" && formConsent === "required") warnings.push(`forms.${i}.consent "required" only applies with consent "checkbox"; in auto mode the line under the button subscribes every visitor who sends "${id}"`);
    if (kind === "waitlist" && mode === "checkbox" && formConsent === "optional") warnings.push(`forms.${i}: a waitlist with an optional consent box takes sign-ups that can't be emailed; "required" is the default for a waitlist`);
    for (const key of ["title", "submitLabel"]) if (f?.[key] !== undefined && (typeof f[key] !== "string" || !f[key].trim())) errors.push(`forms.${i}.${key} must be text`);
    sources[`forms.${i}.kind`] = source("kind");
    sources[`forms.${i}.consent`] = source("consent");
    return { id, purpose, kind, consent: formConsent, ...(f?.title ? { title: f.title } : {}), ...(f?.submitLabel ? { submitLabel: f.submitLabel } : {}) };
  });
}

// A list form (kind "waitlist": a waitlist, a newsletter or a mailing list): an email and an optional name. Message
// forms start from the starter's contact form. Its title and button follow the list's name (listWords).
export const WAITLIST_FORM = {
  title: "Join the waitlist",
  submitLabel: "Join the waitlist",
  fields: [
    { name: "name", type: "text", label: "Your name (optional)", autocomplete: "name" },
    { name: "email", type: "email", label: "Email", required: true, autocomplete: "email" },
  ],
  thanks: "/thanks",
};

// A form's own title when the brief gives none: its purpose when that is short ("Quote request"), else its id.
const capital = (words) => words.charAt(0).toUpperCase() + words.slice(1);
const ownTitle = (f) => capital(f.purpose.trim() && f.purpose.trim().length <= 40 ? f.purpose.trim() : f.id.replace(/-/g, " "));
const idTitle = (f) => capital(f.id.replace(/-/g, " "));

// A list form's title and button from its name: a newsletter or a mailing list isn't called a waitlist.
export function listWords(f) {
  const name = `${f.id} ${f.purpose || ""}`;
  if (/news[\s-]?letter/i.test(name)) return { title: "Get the newsletter", submitLabel: "Sign up" };
  if (/mailing[\s-]?list/i.test(name)) return { title: "Join the mailing list", submitLabel: "Sign up" };
  return { title: WAITLIST_FORM.title, submitLabel: WAITLIST_FORM.submitLabel };
}

// The new site's `forms` in site.config.json, from the brief and the starter's forms (its contact form is the model for
// every message form). Only settings that differ from the defaults are written: `kind` for a waitlist, `consent`
// unless "optional". The default brief gives exactly the starter's contact form. Each form has its own title (the
// privacy page names forms by it): the brief's, else the first unused of the starter form's of the same id (or a
// list form's listWords), one from its purpose, one from its id, and that with a number. A list form's confirmation
// email (sent only when the site has a confirm mailer) says it's on the list, not that someone will reply.
export function siteForms(b, starterForms) {
  const message = starterForms.contact || Object.values(starterForms)[0];
  const used = new Set();
  return Object.fromEntries(b.forms.map((f) => {
    const list = f.kind === "waitlist";
    const form = structuredClone(list ? WAITLIST_FORM : starterForms[f.id] || message);
    if (list) {
      Object.assign(form, listWords(f));
      form.confirm = { subject: "You're on the list", text: `Thanks for signing up. We'll email you when there's news.\n\n${b.business.name}` };
    }
    const inherited = list || starterForms[f.id] ? form.title : "";
    const candidates = [inherited, ownTitle(f), idTitle(f)].filter(Boolean);
    form.title = f.title || candidates.find((t) => !used.has(t)) || `${idTitle(f)} ${used.size + 1}`;
    used.add(form.title);
    if (f.submitLabel) form.submitLabel = f.submitLabel;
    if (f.kind !== "message") form.kind = f.kind;
    else delete form.kind;
    if (f.consent !== "optional") form.consent = f.consent;
    else delete form.consent;
    form.thanks = form.thanks || "/thanks";
    return [f.id, form];
  }));
}

// A page's form sections that name a form the site doesn't have (the starter's home page names "contact") show its
// first form instead. Returns the changed page, or null when nothing changed.
export function pointFormSections(page, forms) {
  const first = Object.keys(forms)[0];
  const stale = (page.sections || []).filter((s) => s._type === "fb_form" && !forms[s.form]);
  if (!stale.length || !first) return null;
  const out = structuredClone(page);
  for (const s of out.sections) if (s._type === "fb_form" && !forms[s.form]) s.form = first;
  return out;
}

// What a form does with a visitor's address, in a few words (brief.mjs check and the DECISIONS.md rows).
export function formSummary(f, mode) {
  const kind = f.kind === "waitlist" ? "a waitlist sign-up" : "a message the owner answers";
  const consent = f.consent === "none" ? "adds no one to a list"
    : mode !== "checkbox" ? "sending it subscribes the visitor (the line under the button)"
    : f.consent === "required" ? "the consent box must be ticked to send it, and subscribes"
    : "only a ticked consent box subscribes";
  return `${kind}; ${consent}`;
}

// The reason and source columns of a DECISIONS.md row for a kickoff answer, from the sources of its paths.
export function rowSource(sources, ...paths) {
  const s = paths.map((p) => sources[p]);
  if (s.includes("stated")) return ["Kickoff", "owner"];
  if (s.includes("agent")) return ["Agent's choice", "agent"];
  if (s.every((x) => x === "default")) return ["Framework default", "inferred"];
  return ["Agent's research", "inferred"];
}

// The row for the decision to make the site at all: the owner's kickoff, or the agent's on autopilot.
export const kickoffSource = (b) => (b?.answeredBy === "agent" ? ["Agent's choice", "agent"] : ["Kickoff", "owner"]);

// Environment for scripts/site/create.mjs.
export const createInputs = (b) => ({
  SITE_ID: b.business.id,
  SITE_NAME: b.business.name,
  SITE_TAGLINE: b.business.offer || "",
  OWNER_EMAIL: b.owner.email,
  EDITING: b.editing ? "on" : "off",
  INDEXING: b.indexing ? "on" : "off",
  CRM: b.crm,
  AUTO_REPLY: b.autoReply ? "on" : "off",
  CONSENT: b.consent,
});

// A form's row: its kind and consent decide; the list of forms only when both are framework defaults. A row that is
// partly the agent's choice or research is never credited to the owner.
export function formRowSource(sources, i) {
  const own = [`forms.${i}.kind`, `forms.${i}.consent`].map((p) => sources[p]).filter((x) => x && x !== "default");
  if (!own.length) return rowSource(sources, "forms");
  if (own.includes("agent")) return ["Agent's choice", "agent"];
  if (own.includes("inferred")) return ["Agent's research", "inferred"];
  return ["Kickoff", "owner"];
}

// DECISIONS.md rows for the kickoff answers: "owner" for stated, "agent" for the agent's own choices on autopilot
// (`answeredBy: "agent"`), "inferred" for inferred or default.
export function decisionRows(b, sources, date) {
  const row = (decision, ...paths) => `| ${date} | ${decision} | ${rowSource(sources, ...paths).join(" | ")} |`;
  const noneSubscribe = b.forms.every((f) => f.consent === "none");
  return [
    row(`Business: ${b.business.name}${b.business.offer ? `, "${b.business.offer}"` : ""}`, "business.name", "business.offer"),
    ...(b.business.audience ? [row(`Audience: ${b.business.audience}`, "business.audience")] : []),
    ...(b.business.location || b.business.serviceArea.length ? [row(`Where: ${[b.business.location, b.business.serviceArea.join(", ")].filter(Boolean).join("; ")}`, "business.location", "business.serviceArea")] : []),
    row(`Mode: ${b.mode}`, "mode"),
    row(`Site shape: ${b.shape}`, "shape"),
    // An EU, UK or Canadian audience chose the consent box when the brief left `consent` out.
    row(`Opt-in: ${noneSubscribe ? "none (no form subscribes anyone)" : b.consent === "checkbox" ? "checkbox (a consent box; only a ticked box subscribes)" : "auto (a line under the button; sending a form subscribes)"}`,
      ...(sources.consent === "default" && GDPR_CASL.has(b.audienceRegion) ? ["consent", "audienceRegion"] : ["consent"])),
    ...b.forms.map((f, i) => `| ${date} | Form ${f.id}${f.purpose && f.purpose !== f.id ? ` (${f.purpose})` : ""}: ${formSummary(f, b.consent)} | ${formRowSource(sources, i).join(" | ")} |`),
    row(`Lead auto-reply: ${b.autoReply ? "on" : "off"}`, "autoReply"),
    row(`Search engines: ${b.indexing ? "indexed" : "noindex"}`, "indexing"),
    row(`Client editing (EmDash): ${b.editing ? "on" : "off"}`, "editing"),
    row(`CRM copy of each lead: ${b.crm === "none" ? "off (leads are in /admin)" : b.crm.replace("+", " and ")}`, "crm"),
    row(`Newsletter: ${b.newsletter ? (b.mode === "idea" ? "collect subscribers now, send after launch" : "on") : "off"}`, "newsletter"),
    row(`Design: ${b.design.autopilot ? "autopilot" : "intake with the owner"}${b.design.words.length ? `, "${b.design.words.join(", ")}"` : ""}`, "design.autopilot", "design.words"),
    row(`Imagery: ${b.design.imagery.style}${b.design.imagery.secondary ? ` with ${b.design.imagery.secondary}` : ""}${b.design.imagery.treatment !== "none" ? `, ${b.design.imagery.treatment} treatment` : ""}`, "design.imagery.style", "design.imagery.secondary", "design.imagery.treatment"),
  ];
}
