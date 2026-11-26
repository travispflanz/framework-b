import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FORM_CONSENT, FORM_KINDS, IMAGERY_STYLES, OFFER_MAX, TREATMENTS, createInputs, decisionRows, kickoffSource, normalizeBrief, pointFormSections, siteForms, slug } from "../lib/brief.mjs";

test("a minimal brief gets every default, marked as default", () => {
  const { brief, sources, errors } = normalizeBrief({ business: { name: "Example Co" }, owner: { email: "Owner@Example.com" } });
  assert.deepEqual(errors, []);
  assert.equal(brief.business.id, "example-co");
  assert.equal(brief.owner.email, "owner@example.com");
  assert.equal(brief.mode, "idea");
  assert.equal(brief.shape, "landing");
  assert.deepEqual(brief.forms, [{ id: "contact", purpose: "contact", kind: "message", consent: "optional" }]);
  assert.equal(brief.answeredBy, "owner");
  assert.equal(brief.indexing, false);
  assert.equal(brief.editing, false);
  assert.equal(brief.design.autopilot, true);
  assert.equal(sources["business.name"], "stated");
  assert.equal(sources.indexing, "default");
  assert.equal(sources.shape, "default");
});

test("answers present are stated unless listed as inferred", () => {
  const { brief, sources } = normalizeBrief({
    business: { name: "Example Co", offer: "Clean bins at the curb." },
    owner: { email: "owner@example.com" },
    indexing: true,
    shape: "landing",
    design: { words: ["friendly", "trustworthy"] },
    inferred: ["shape", "business.offer"],
  });
  assert.equal(sources.indexing, "stated");
  assert.equal(sources.shape, "inferred");
  assert.equal(sources["business.offer"], "inferred");
  assert.equal(sources["design.words"], "stated");
  assert.deepEqual(createInputs(brief), { SITE_ID: "example-co", SITE_NAME: "Example Co", SITE_TAGLINE: "Clean bins at the curb.", OWNER_EMAIL: "owner@example.com", EDITING: "off", INDEXING: "on", CRM: "none", AUTO_REPLY: "off", CONSENT: "auto" });
});

test("required answers and bad values are errors", () => {
  assert.ok(normalizeBrief({}).errors.some((e) => e.includes("business.name")));
  assert.ok(normalizeBrief({ business: { name: "X Co" } }).errors.some((e) => e.includes("owner.email")));
  const bad = normalizeBrief({ business: { name: "Example Co" }, owner: { email: "nope" }, shape: "blog", indexing: "yes" });
  assert.ok(bad.errors.some((e) => e.startsWith("owner.email")));
  assert.ok(bad.errors.some((e) => e.startsWith("shape")));
  assert.ok(bad.errors.some((e) => e.startsWith("indexing")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, mode: "launch" }).errors.some((e) => e.includes("site promote")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, claims: [{ text: "5-star" }] }).errors.some((e) => e.startsWith("claims")));
});

test("EU, newsletter-on-idea and CRM produce warnings, not errors", () => {
  const { errors, warnings } = normalizeBrief({ business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" }, audienceRegion: "EU", newsletter: true, crm: "webhook" });
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some((w) => w.includes("GDPR"))); // an EU audience now defaults to the consent box
  assert.ok(warnings.some((w) => w.includes("subscriber collection only")));
  assert.ok(warnings.some((w) => w.includes("CRM_WEBHOOK_URL")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, crm: "hubspot" }).errors.some((e) => e.startsWith("crm")));
  assert.equal(createInputs(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, crm: "sheet" }).brief).CRM, "sheet");
  assert.equal(createInputs(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, autoReply: true }).brief).AUTO_REPLY, "on");
  // An EU audience defaults to the consent box; choosing auto there is a warning.
  const eu = normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, audienceRegion: "eu" });
  assert.equal(eu.brief.consent, "checkbox");
  assert.ok(!eu.warnings.some((w) => w.includes("GDPR")));
  assert.ok(normalizeBrief({ business: { name: "Example Co" }, owner: { email: "o@example.com" }, audienceRegion: "eu", consent: "auto" }).warnings.some((w) => w.includes("GDPR")));
});

test("decision rows record who decided each answer, and indexing as chosen", () => {
  const { brief, sources } = normalizeBrief({ business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" }, indexing: true, inferred: [] });
  const rows = decisionRows(brief, sources, "2026-10-26");
  assert.ok(rows.includes("| 2026-10-26 | Search engines: indexed | Kickoff | owner |"));
  assert.ok(rows.includes("| 2026-10-26 | Site shape: landing | Framework default | inferred |"));
});

test("slug makes a valid site id from a business name", () => {
  assert.equal(slug("Café & Bakery, Ltd."), "cafe-and-bakery-ltd");
  assert.equal(slug("  Example   Co  "), "example-co");
});

test("imagery: defaults to owner photos, checks styles, warns on generated photos, matches the starter's lists", async () => {
  const base = { business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" } };
  const plain = normalizeBrief(base);
  assert.deepEqual(plain.brief.design.imagery, { style: "owner-photo", secondary: "", treatment: "none" });
  assert.ok(decisionRows(plain.brief, plain.sources, "2026-10-28").includes("| 2026-10-28 | Imagery: owner-photo | Framework default | inferred |"));
  const chosen = normalizeBrief({ ...base, design: { imagery: { style: "photoreal-generated", secondary: "line-art", treatment: "duotone" } } });
  assert.deepEqual(chosen.errors, []);
  assert.ok(chosen.warnings.some((w) => w.includes("never show the business's own people")));
  assert.ok(decisionRows(chosen.brief, chosen.sources, "2026-10-28").includes("| 2026-10-28 | Imagery: photoreal-generated with line-art, duotone treatment | Kickoff | owner |"));
  assert.ok(normalizeBrief({ ...base, design: { imagery: { style: "oil-painting" } } }).errors.some((e) => e.startsWith("design.imagery.style")));
  const tokens = readFileSync(new URL("../../../starter/scripts/design-tokens.mjs", import.meta.url), "utf8");
  for (const [name, list] of [["IMAGERY_STYLES", IMAGERY_STYLES], ["TREATMENTS", TREATMENTS]]) {
    assert.ok(tokens.includes(`const ${name} = ${JSON.stringify(list).replace(/,/g, ", ")};`), `${name} differs from starter/scripts/design-tokens.mjs`);
  }
});

test("answeredBy agent: the agent's own choices are recorded as the agent's, not the owner's", () => {
  const base = { business: { name: "Example Co", offer: "Tools on loan." }, owner: { email: "owner@example.com" }, indexing: true, shape: "full", inferred: ["business.offer"] };
  // The default stays as before: answers present are the owner's.
  const owner = normalizeBrief(base);
  assert.equal(owner.brief.answeredBy, "owner");
  assert.ok(decisionRows(owner.brief, owner.sources, "2026-11-18").includes("| 2026-11-18 | Search engines: indexed | Kickoff | owner |"));
  assert.deepEqual(kickoffSource(owner.brief), ["Kickoff", "owner"]);
  // On autopilot with no owner answers, they are the agent's.
  const agent = normalizeBrief({ ...base, answeredBy: "agent" });
  assert.deepEqual(agent.errors, []);
  assert.equal(agent.sources.indexing, "agent");
  assert.equal(agent.sources["business.offer"], "inferred");
  assert.equal(agent.sources["owner.email"], "stated", "the inbox is always the owner's");
  const rows = decisionRows(agent.brief, agent.sources, "2026-11-18");
  assert.ok(rows.includes("| 2026-11-18 | Search engines: indexed | Agent's choice | agent |"));
  assert.ok(rows.includes("| 2026-11-18 | Site shape: full | Agent's choice | agent |"));
  assert.ok(rows.includes('| 2026-11-18 | Business: Example Co, "Tools on loan." | Agent\'s choice | agent |'));
  assert.ok(rows.includes("| 2026-11-18 | Client editing (EmDash): off | Framework default | inferred |"));
  assert.ok(!rows.some((r) => r.endsWith("| owner |")), rows.join("\n"));
  assert.deepEqual(kickoffSource(agent.brief), ["Agent's choice", "agent"]);
  assert.ok(normalizeBrief({ ...base, answeredBy: "robot" }).errors.some((e) => e.startsWith("answeredBy")));
});

test("forms: per-form kind and consent, checked, defaulted and shown in the decision rows", () => {
  const base = { business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" }, design: { imagery: { style: "documentary-stock" } } };
  const { brief, sources, errors, warnings } = normalizeBrief({ ...base, forms: [{ id: "waitlist", purpose: "early access" }, { id: "contact", purpose: "questions", consent: "none", title: "Ask us" }], inferred: ["forms.1.consent"] });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(brief.forms, [
    { id: "waitlist", purpose: "early access", kind: "waitlist", consent: "optional" },
    { id: "contact", purpose: "questions", kind: "message", consent: "none", title: "Ask us" },
  ]);
  assert.equal(sources["forms.0.kind"], "default");
  assert.equal(sources["forms.1.consent"], "inferred");
  const rows = decisionRows(brief, sources, "2026-11-18");
  assert.ok(rows.includes("| 2026-11-18 | Opt-in: auto (a line under the button; sending a form subscribes) | Framework default | inferred |"));
  assert.ok(rows.includes("| 2026-11-18 | Form waitlist (early access): a waitlist sign-up; sending it subscribes the visitor (the line under the button) | Kickoff | owner |"));
  // The owner named the contact form, but its consent is the agent's inference: the row isn't credited to the owner.
  assert.ok(rows.includes("| 2026-11-18 | Form contact (questions): a message the owner answers; adds no one to a list | Agent's research | inferred |"));
  // In checkbox mode a waitlist's box is required by default; an EU audience chose that mode.
  const eu = normalizeBrief({ ...base, audienceRegion: "eu", forms: [{ id: "list", purpose: "mailing list" }, { id: "quote" }] });
  assert.deepEqual(eu.brief.forms.map((f) => [f.kind, f.consent]), [["waitlist", "required"], ["message", "optional"]]);
  const euRows = decisionRows(eu.brief, eu.sources, "2026-11-18");
  assert.ok(euRows.includes("| 2026-11-18 | Opt-in: checkbox (a consent box; only a ticked box subscribes) | Kickoff | owner |"), euRows.join("\n"));
  assert.ok(euRows.includes("| 2026-11-18 | Form quote: a message the owner answers; only a ticked consent box subscribes | Kickoff | owner |"));
  // No form subscribes anyone.
  const plain = normalizeBrief({ ...base, forms: [{ id: "contact", consent: "none" }] });
  assert.ok(decisionRows(plain.brief, plain.sources, "2026-11-18").includes("| 2026-11-18 | Opt-in: none (no form subscribes anyone) | Framework default | inferred |"));
  // Errors and warnings.
  const err = (forms, extra = {}) => normalizeBrief({ ...base, ...extra, forms }).errors;
  assert.ok(err([{ id: "a", kind: "survey" }]).some((e) => e.startsWith("forms.0.kind")));
  assert.ok(err([{ id: "a", consent: "auto" }]).some((e) => e.startsWith("forms.0.consent")));
  assert.ok(err([{ id: "waitlist", consent: "none" }]).some((e) => e.includes("adds no one to the list")));
  assert.ok(err([{ id: "a" }, { id: "a" }]).some((e) => e.includes("used twice")));
  assert.ok(err([{ id: "Contact" }]).some((e) => e.startsWith("forms.0.id")));
  assert.ok(err([{ id: "a", title: 3 }]).some((e) => e.startsWith("forms.0.title")));
  assert.ok(err([]).some((e) => e.startsWith("forms")));
  assert.ok(normalizeBrief({ ...base, forms: [{ id: "contact", consent: "required" }] }).warnings.some((w) => w.includes('only applies with consent "checkbox"')));
  assert.ok(normalizeBrief({ ...base, consent: "checkbox", forms: [{ id: "waitlist", consent: "optional" }] }).warnings.some((w) => w.includes("can't be emailed")));
  // A form is guessed to be a waitlist only when its id, or its whole purpose, names a list.
  const kinds = (forms) => normalizeBrief({ ...base, forms }).brief.forms.map((f) => f.kind);
  assert.deepEqual(kinds([{ id: "contact", purpose: "questions about the newsletter" }, { id: "help", purpose: "not for the mailing list" }]), ["message", "message"]);
  assert.deepEqual(kinds([{ id: "newsletter" }, { id: "signup", purpose: "Newsletter sign-up" }, { id: "early", purpose: "waiting list" }, { id: "wait-list" }]), ["waitlist", "waitlist", "waitlist", "waitlist"]);
  assert.deepEqual(kinds([{ id: "early", purpose: "early access" }, { id: "early-2", purpose: "early access", kind: "waitlist" }]), ["message", "waitlist"]);
  // A newsletter needs a form that subscribes; the idea-site note no longer says every form opts people in.
  const news = (forms) => normalizeBrief({ ...base, newsletter: true, forms }).warnings;
  assert.ok(news([{ id: "contact", consent: "none" }]).some((w) => w.includes("no form collects subscribers")));
  assert.ok(!news([{ id: "contact", consent: "none" }]).some((w) => w.includes("subscriber collection only")));
  assert.ok(news([{ id: "contact", consent: "none" }, { id: "waitlist" }]).some((w) => w.includes("the forms that subscribe collect them now")));
  assert.ok(!news([{ id: "contact", consent: "none" }, { id: "waitlist" }]).some((w) => w.includes("no form collects subscribers")));
  // The lists match the starter's and core's.
  const copy = readFileSync(new URL("../../../starter/src/lib/form-copy.js", import.meta.url), "utf8");
  assert.ok(copy.includes(`export const FORM_KINDS = ${JSON.stringify(FORM_KINDS).replace(/,/g, ", ")};`), "FORM_KINDS differs from starter/src/lib/form-copy.js");
  const core = readFileSync(new URL("../../../packages/core/src/config.js", import.meta.url), "utf8");
  const coreConsent = JSON.parse(core.match(/(\[[^\]]+\])\.includes\(form\.consent\)/)[1]);
  assert.deepEqual([...FORM_CONSENT].sort(), [...coreConsent].sort(), "FORM_CONSENT differs from core's form consent values");
});

test("siteForms: the default brief gives the starter's contact form; a waitlist and a plain message form are written", () => {
  const starter = JSON.parse(readFileSync(new URL("../../../starter/site.config.json", import.meta.url), "utf8")).forms;
  const base = { business: { name: "Example Co" }, owner: { email: "o@example.com" } };
  assert.deepEqual(siteForms(normalizeBrief(base).brief, starter), starter);
  const forms = siteForms(normalizeBrief({ ...base, consent: "checkbox", forms: [{ id: "waitlist" }, { id: "contact", consent: "none", submitLabel: "Send it" }, { id: "quote", title: "Ask for a quote" }] }).brief, starter);
  assert.deepEqual(Object.keys(forms), ["waitlist", "contact", "quote"]);
  assert.equal(forms.waitlist.kind, "waitlist");
  assert.equal(forms.waitlist.consent, "required");
  assert.equal(forms.waitlist.file, undefined, "a waitlist takes no file");
  assert.deepEqual(forms.waitlist.fields.map((f) => [f.name, !!f.required]), [["name", false], ["email", true]]);
  assert.equal(forms.contact.consent, "none");
  assert.equal(forms.contact.submitLabel, "Send it");
  assert.equal(forms.contact.kind, undefined, "message is the default kind, not written");
  assert.deepEqual(forms.contact.fields, starter.contact.fields);
  assert.equal(forms.quote.title, "Ask for a quote");
  assert.equal(forms.contact.title, "Get in touch", "the contact form keeps the starter's title");
  // Every form has its own title: only the contact form takes the starter's, and only the first waitlist "Join the waitlist".
  const titled = siteForms(normalizeBrief({ ...base, forms: [{ id: "contact" }, { id: "quote", purpose: "quote request" }, { id: "book-a-visit" }, { id: "waitlist" }, { id: "newsletter" }] }).brief, starter);
  assert.deepEqual(Object.values(titled).map((f) => f.title), ["Get in touch", "Quote request", "Book a visit", "Join the waitlist", "Get the newsletter"]);
  assert.equal(forms.quote.consent, undefined, "optional is the default consent, not written");
  assert.equal(starter.contact.consent, undefined, "the starter's form is not changed");
  for (const f of Object.values(forms)) assert.equal(f.thanks, "/thanks");
  // A brief with only a waitlist: the starter home page's contact form section shows the waitlist instead.
  const home = JSON.parse(readFileSync(new URL("../../../starter/src/content/home.json", import.meta.url), "utf8"));
  const waitlistOnly = siteForms(normalizeBrief({ ...base, forms: [{ id: "waitlist" }] }).brief, starter);
  assert.equal(pointFormSections(home, waitlistOnly).sections.find((x) => x._type === "fb_form").form, "waitlist");
  assert.equal(home.sections.find((x) => x._type === "fb_form").form, "contact", "the starter's page is not changed");
  assert.equal(pointFormSections(home, starter), null, "nothing to change when the form exists");
});

test("siteForms: a list form's title, button and confirmation follow its name; no two forms share a title", () => {
  const base = { business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" } };
  const starter = JSON.parse(readFileSync(new URL("../../../starter/site.config.json", import.meta.url), "utf8")).forms;
  const forms = siteForms(normalizeBrief({ ...base, forms: [{ id: "contact" }, { id: "newsletter" }, { id: "list", purpose: "mailing list" }, { id: "early", kind: "waitlist" }] }).brief, starter);
  assert.deepEqual(Object.values(forms).map((f) => [f.title, f.submitLabel]), [["Get in touch", "Send"], ["Get the newsletter", "Sign up"], ["Join the mailing list", "Sign up"], ["Join the waitlist", "Join the waitlist"]]);
  for (const id of ["newsletter", "list", "early"]) {
    assert.equal(forms[id].confirm.subject, "You're on the list");
    assert.doesNotMatch(forms[id].confirm.text, /reply/, "a list sign-up's confirmation promises no reply");
  }
  assert.equal(forms.contact.confirm, starter.contact.confirm, "a message form keeps the starter's confirmation");
  // A purpose that repeats another form's title doesn't give two forms the same heading.
  const twice = siteForms(normalizeBrief({ ...base, forms: [{ id: "contact" }, { id: "general", purpose: "Get in touch" }, { id: "quote", purpose: "General" }] }).brief, starter);
  const titles = Object.values(twice).map((f) => f.title);
  assert.equal(new Set(titles).size, titles.length, titles.join(", "));
  assert.deepEqual(titles, ["Get in touch", "General", "Quote"]);
});

test("decision rows: a form's kind and consent decide its source, the list of forms only when both are defaults", () => {
  const base = { business: { name: "Example Co", offer: "x" }, owner: { email: "o@example.com" } };
  const date = "2026-11-19";
  // The owner asked for a contact form and an early-access list; the agent set both forms' kind and consent.
  const b = normalizeBrief({ ...base, forms: [{ id: "contact", consent: "none" }, { id: "early", purpose: "early access", kind: "waitlist", consent: "optional" }], inferred: ["forms.0.consent", "forms.1.kind", "forms.1.consent"] });
  const rows = decisionRows(b.brief, b.sources, date);
  assert.ok(rows.includes(`| ${date} | Form contact: a message the owner answers; adds no one to a list | Agent's research | inferred |`), rows.join("\n"));
  assert.ok(rows.some((r) => r.startsWith(`| ${date} | Form early (early access): a waitlist sign-up;`) && r.endsWith("| Agent's research | inferred |")), rows.join("\n"));
  // On autopilot every form row is the agent's choice; with the owner's own kind and consent, the owner's.
  const auto = normalizeBrief({ ...base, answeredBy: "agent", forms: [{ id: "contact", consent: "none" }] });
  assert.ok(decisionRows(auto.brief, auto.sources, date).some((r) => r.startsWith(`| ${date} | Form contact:`) && r.endsWith("| Agent's choice | agent |")));
  const owner = normalizeBrief({ ...base, forms: [{ id: "contact", consent: "none" }] });
  assert.ok(decisionRows(owner.brief, owner.sources, date).some((r) => r.startsWith(`| ${date} | Form contact:`) && r.endsWith("| Kickoff | owner |")));
});

test("inferred: a path that names no field is an error, one left out of the brief a warning", () => {
  const base = { business: { name: "Example Co", offer: "Seeds by post." }, owner: { email: "o@example.com" }, design: { words: ["plain"], imagery: { style: "line-art" } } };
  const typo = normalizeBrief({ ...base, inferred: ["design.word"] });
  assert.ok(typo.errors.some((e) => e.startsWith('inferred: "design.word" is not a field')), typo.errors.join("; "));
  // Without the check, the real field would read as the owner's answer.
  assert.equal(typo.sources["design.words"], "stated");
  const parent = normalizeBrief({ ...base, inferred: ["design.imagery"] });
  assert.ok(parent.errors.some((e) => e.includes("design.imagery.style")), parent.errors.join("; "));
  const absent = normalizeBrief({ ...base, inferred: ["shape"] });
  assert.deepEqual(absent.errors, []);
  assert.ok(absent.warnings.some((w) => w.startsWith('inferred: "shape" is listed but not in the brief')));
  const ok = normalizeBrief({ ...base, shape: "landing", forms: [{ id: "waitlist", purpose: "news" }], inferred: ["shape", "design.words", "forms.0.purpose", "forms.0.kind", "business.offer"] });
  assert.deepEqual(ok.errors, []);
  assert.ok(!ok.warnings.some((w) => w.startsWith("inferred:") && !w.includes("forms.0.kind")));
  assert.equal(ok.sources["design.words"], "inferred");
  assert.ok(normalizeBrief({ ...base, forms: [{ id: "contact" }], inferred: ["forms.3.kind"] }).errors.some((e) => e.includes("forms.3.kind")));
});

test("an empty list or object is absent unless the agent chose it; the imagery default and a long offer warn", () => {
  const base = { business: { name: "Example Co", offer: "Seeds by post.", serviceArea: [] }, owner: { email: "o@example.com" } };
  const { sources, warnings } = normalizeBrief({ ...base, design: { references: [], avoid: ["stock smiles"] }, facts: {}, claims: [] });
  assert.equal(sources["design.references"], "default");
  assert.equal(sources["business.serviceArea"], "default");
  assert.equal(sources.facts, "default");
  assert.equal(sources.claims, "default");
  assert.equal(sources["design.avoid"], "stated");
  assert.equal(normalizeBrief({ ...base, design: { references: [] }, inferred: ["design.references"] }).sources["design.references"], "inferred");
  // An empty list of forms is still refused, not quietly replaced by the default.
  assert.ok(normalizeBrief({ ...base, forms: [] }).errors.some((e) => e.startsWith("forms")));
  assert.ok(warnings.some((w) => w.startsWith('design.imagery.style is not set, so it is "owner-photo"')));
  assert.ok(!normalizeBrief({ ...base, design: { imagery: { style: "owner-photo" } } }).warnings.some((w) => w.startsWith("design.imagery.style")));
  const long = normalizeBrief({ ...base, business: { name: "Example Co", offer: "x".repeat(OFFER_MAX + 1) } });
  assert.ok(long.warnings.some((w) => w.startsWith(`business.offer is ${OFFER_MAX + 1} characters`)));
  assert.ok(!normalizeBrief({ ...base, business: { name: "Example Co", offer: "x".repeat(OFFER_MAX) } }).warnings.some((w) => w.startsWith("business.offer")));
});
