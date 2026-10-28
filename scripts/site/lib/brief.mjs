// The kickoff brief: the owner's one prompt turned into the answers to docs/SPEC.md section 3, each with where it
// came from. The agent writes brief.json from the prompt; this module checks it, fills every default, and turns it
// into create inputs and DECISIONS.md rows. The site keeps brief.json as the record of its kickoff.
//
// Source of each answer:
//   stated    the owner said it (the default for any field present in the input)
//   inferred  the agent decided it from research or the prompt; list its path in `inferred`
//   default   absent from the input; the framework default from SPEC section 3 applies
//
// Minimal input:  { "business": { "name": "Example Co" }, "owner": { "email": "owner@example.com" } }

// CRM mirror (core src/crm.js): copy each lead to the owner's Google Sheet, a webhook, or both.
export const CRM = ["none", "sheet", "webhook", "sheet+webhook"];
export const SHAPES = ["landing", "full", "hybrid"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GDPR_CASL = new Set(["eu", "uk", "ca", "eea"]);

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
  const pick = (path, fallback, check) => {
    const v = get(input, path);
    if (v === undefined || v === null || v === "") {
      sources[path] = "default";
      return typeof fallback === "function" ? fallback() : fallback;
    }
    if (check && !check(v)) errors.push(`${path}: ${JSON.stringify(v)} is not valid`);
    sources[path] = inferred.has(path) ? "inferred" : "stated";
    return v;
  };

  if (!input || typeof input !== "object") return { brief: null, sources, errors: ["the brief must be a JSON object"], warnings };
  if (input.version !== undefined && input.version !== 1) errors.push(`version ${input.version} is not supported (expected 1)`);

  const name = pick("business.name", "", (v) => typeof v === "string" && v.trim().length > 0);
  if (!name) errors.push("business.name is required");
  const email = String(pick("owner.email", "", (v) => EMAIL.test(v))).trim().toLowerCase();
  if (!email) errors.push("owner.email is required");
  const id = pick("business.id", () => slug(name), (v) => /^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(v));
  if (!/^[a-z][a-z0-9-]{1,40}[a-z0-9]$/.test(id)) errors.push(`site id "${id}" must be 3-42 lowercase letters, digits or dashes, starting with a letter; set business.id`);

  const mode = pick("mode", "idea", (v) => ["idea", "launch"].includes(v));
  if (mode === "launch") errors.push("site create makes idea sites only: build it as an idea, then run site promote to put it on its domain (docs/SPEC.md section 2)");
  const region = String(pick("audienceRegion", "us", (v) => typeof v === "string")).toLowerCase();
  // Consent: "auto" (every form subscribes, US CAN-SPAM) or "checkbox" (a consent box; only a ticked box subscribes).
  const consent = pick("consent", () => (GDPR_CASL.has(region) ? "checkbox" : "auto"), (v) => ["auto", "checkbox"].includes(v));
  if (GDPR_CASL.has(region) && consent === "auto") warnings.push(`audienceRegion "${region}" with consent "auto": every form opts visitors in automatically, which GDPR and CASL generally don't allow; use consent "checkbox" or ask the owner (SPEC section 5)`);

  const forms = pick("forms", () => [{ id: "contact", purpose: "contact" }], (v) => Array.isArray(v) && v.length > 0 && v.every((f) => f && /^[a-z][a-z0-9-]*$/.test(f.id || "")));
  const newsletter = pick("newsletter", false, isBool);
  if (newsletter && mode === "idea") warnings.push("newsletter on an idea site means subscriber collection only: forms already opt people in; sending starts at launch (DECISIONS 2026-10-23)");
  const autoReply = pick("autoReply", false, isBool);
  if (autoReply && mode === "idea") warnings.push("lead auto-replies on an idea site go through the owner's Gmail (Apps Script mailer, 100 recipients a day shared by all idea sites)");

  const brief = {
    version: 1,
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
      words: pick("design.words", []),
      references: pick("design.references", []),
      avoid: pick("design.avoid", []),
    },
    facts: pick("facts", {}),
    claims: pick("claims", []),
    inferred: [...inferred],
  };
  if (brief.crm.includes("webhook")) warnings.push(`crm "${brief.crm}": the webhook needs its URL as the Worker secret CRM_WEBHOOK_URL (and optionally CRM_WEBHOOK_SECRET) before leads are sent to it`);
  if (!brief.business.offer) warnings.push("business.offer is empty: the hero needs a one-line offer; infer one and list it in `inferred`");
  for (const c of brief.claims) if (!c?.text || !c?.source) errors.push(`claims: every claim needs text and an owner source (${JSON.stringify(c)})`);
  return { brief, sources, errors, warnings };
}

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

// DECISIONS.md rows for the kickoff answers ("owner" for stated, "inferred" for inferred or default).
export function decisionRows(b, sources, date) {
  const who = (...paths) => (paths.some((p) => sources[p] === "stated") ? "owner" : "inferred");
  const why = (...paths) => (paths.some((p) => sources[p] === "stated") ? "Kickoff" : paths.every((p) => sources[p] === "default") ? "Framework default" : "Agent's research");
  const row = (decision, ...paths) => `| ${date} | ${decision} | ${why(...paths)} | ${who(...paths)} |`;
  return [
    row(`Business: ${b.business.name}${b.business.offer ? `, "${b.business.offer}"` : ""}`, "business.name", "business.offer"),
    ...(b.business.audience ? [row(`Audience: ${b.business.audience}`, "business.audience")] : []),
    ...(b.business.location || b.business.serviceArea.length ? [row(`Where: ${[b.business.location, b.business.serviceArea.join(", ")].filter(Boolean).join("; ")}`, "business.location", "business.serviceArea")] : []),
    row(`Mode: ${b.mode}`, "mode"),
    row(`Site shape: ${b.shape}`, "shape"),
    row(`Forms: ${b.forms.map((f) => f.id).join(", ")} (${b.consent === "checkbox" ? "a consent box; only a ticked box subscribes" : "every form opts visitors in"})`, "forms", "consent"),
    row(`Lead auto-reply: ${b.autoReply ? "on" : "off"}`, "autoReply"),
    row(`Search engines: ${b.indexing ? "indexed" : "noindex"}`, "indexing"),
    row(`Client editing (EmDash): ${b.editing ? "on" : "off"}`, "editing"),
    row(`CRM copy of each lead: ${b.crm === "none" ? "off (leads are in /admin)" : b.crm.replace("+", " and ")}`, "crm"),
    row(`Newsletter: ${b.newsletter ? (b.mode === "idea" ? "collect subscribers now, send after launch" : "on") : "off"}`, "newsletter"),
    row(`Design: ${b.design.autopilot ? "autopilot" : "intake with the owner"}${b.design.words.length ? `, "${b.design.words.join(", ")}"` : ""}`, "design.autopilot", "design.words"),
  ];
}
