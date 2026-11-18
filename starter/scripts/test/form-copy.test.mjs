// The generated privacy and thanks copy (src/lib/form-copy.js) follows what the site's forms do: no sign-up wording
// when no form subscribes anyone, list wording for a waitlist, one line per form when they differ, and thanks copy
// for a waitlist sign-up, a message, or both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../core/src/config.js";
import { describeForms, privacyUse, thanksCopy } from "../../src/lib/form-copy.js";

const starter = JSON.parse(readFileSync(new URL("../../site.config.json", import.meta.url), "utf8"));
const WAITLIST = {
  kind: "waitlist", title: "Join the waitlist", submitLabel: "Join the waitlist",
  fields: [{ name: "name", type: "text", label: "Your name (optional)" }, { name: "email", type: "email", label: "Email", required: true }],
};
// A site from the starter with these changes to its forms (and optIn or email), loaded as the pages load it.
const site = ({ forms = {}, optIn, email } = {}) => {
  const raw = structuredClone(starter);
  raw.forms = Object.fromEntries(Object.entries({ ...raw.forms, ...forms }).filter(([, f]) => f));
  if (optIn) raw.optIn = optIn;
  if (email) raw.email = email;
  return loadConfig(raw);
};
const text = (use) => [use.text, use.intro, ...(use.forms || []).map((f) => `${f.title}: ${f.text}`), use.after].filter(Boolean).join(" ");
// The QA gate's copy lint (scripts/qa.mjs): none of its generic AI words in anything these pages say.
const TELLS = JSON.parse(readFileSync(new URL("../qa.mjs", import.meta.url), "utf8").match(/const TELLS = (\[[^\]]+\]);/)[1]);
const lint = (s) => TELLS.filter((w) => new RegExp(`\\b${w}`, "i").test(s));

test("the starter's contact form: answers and signs up, as before", () => {
  const config = site();
  assert.deepEqual(describeForms(config), [{ id: "contact", title: "Get in touch", kind: "message", subscribes: "always", file: true, confirms: false, thanks: "/thanks" }]);
  assert.equal(privacyUse(config).text, "To answer you, and to send you occasional emails. Sending the form signs you up for those emails. Each one has an unsubscribe link, and you can unsubscribe at any time.");
  assert.deepEqual(thanksCopy(config), { title: "Thanks, we got it", lines: ["We'll reply soon."], file: true });
  const confirming = privacyUse(site({ email: { notify: "apps-script", confirm: "apps-script" } })).text;
  assert.ok(confirming.endsWith("After you send a form, you get one confirmation email."), confirming);
});

test("a plain message form (consent none): no sign-up or unsubscribe wording", () => {
  const config = site({ forms: { contact: { ...starter.forms.contact, consent: "none" } } });
  const use = privacyUse(config);
  assert.equal(use.text, "Only to answer you. Sending a form doesn't add you to any mailing list.");
  assert.doesNotMatch(use.text, /signs you up|unsubscribe|occasional emails/);
  assert.deepEqual(thanksCopy(config).lines, ["We'll reply soon."]);
  // The same in checkbox mode: no box, no list.
  assert.equal(privacyUse(site({ forms: { contact: { ...starter.forms.contact, consent: "none" } }, optIn: { mode: "checkbox" } })).text, use.text);
});

test("a waitlist on its own: list wording, and a thanks page that doesn't promise a reply", () => {
  const config = site({ forms: { contact: null, waitlist: WAITLIST } });
  assert.equal(privacyUse(config).text, "To email you when there's news. Joining the waitlist signs you up for those emails. Each one has an unsubscribe link, and you can unsubscribe at any time.");
  const thanks = thanksCopy(config);
  assert.deepEqual(thanks, { title: "You're on the list", lines: ["We'll email you when there's news."], file: false });
  assert.doesNotMatch(thanks.lines.join(" "), /reply/);
  // With an optional consent box, only a ticked box puts someone on the list.
  const optional = site({ forms: { contact: null, waitlist: { ...WAITLIST, consent: "optional" } }, optIn: { mode: "checkbox" } });
  assert.deepEqual(thanksCopy(optional), { title: "Thanks, we got it", lines: ["If you ticked the box, we'll email you when there's news."], file: false });
  assert.match(privacyUse(optional).text, /^To email you when there's news, if you tick the box on the form\. Only a ticked box signs you up\./);
  // A waitlist that takes a file keeps the failed-upload note.
  assert.equal(thanksCopy(site({ forms: { contact: null, waitlist: { ...WAITLIST, file: { label: "A file" } } } })).file, true);
});

test("a waitlist beside a plain message form: one line per form, and thanks copy for both", () => {
  const config = site({ forms: { contact: { ...starter.forms.contact, consent: "none" }, waitlist: WAITLIST } });
  assert.deepEqual(privacyUse(config), {
    intro: "It depends on the form:",
    forms: [
      { title: "Get in touch", text: "to answer you. It doesn't add you to any mailing list." },
      { title: "Join the waitlist", text: "to email you when there's news." },
    ],
    after: "Every email we send to a list has an unsubscribe link, and you can unsubscribe at any time.",
  });
  assert.deepEqual(thanksCopy(config), {
    title: "Thanks, we got it",
    lines: ["If you sent us a message, we'll reply soon.", "If you joined the waitlist, we'll email you when there's news."],
    file: true,
  });
  // A form with its own thanks page leaves /thanks to the others.
  const own = site({ forms: { contact: { ...starter.forms.contact, consent: "none" }, waitlist: { ...WAITLIST, thanks: "/on-the-list" } } });
  assert.deepEqual(thanksCopy(own, "/thanks").lines, ["We'll reply soon."]);
  assert.equal(thanksCopy(own, "/on-the-list").title, "You're on the list");
});

test("checkbox mode: an optional box is explained per form, a required one signs up", () => {
  const config = site({ forms: { waitlist: { ...WAITLIST, consent: "required" } }, optIn: { mode: "checkbox" } });
  assert.deepEqual(privacyUse(config).forms, [
    { title: "Get in touch", text: "to answer you, and, if you tick the box, to send you occasional emails." },
    { title: "Join the waitlist", text: "to email you when there's news." },
  ]);
  assert.equal(thanksCopy(config).lines[1], "If you joined the waitlist, we'll email you when there's news.");
});

test("none of the copy uses the copy lint's words", () => {
  const configs = [
    site(),
    site({ forms: { contact: { ...starter.forms.contact, consent: "none" } } }),
    site({ forms: { contact: null, waitlist: WAITLIST } }),
    site({ forms: { contact: { ...starter.forms.contact, consent: "none" }, waitlist: WAITLIST }, email: { notify: "apps-script", confirm: "apps-script" } }),
    site({ forms: { waitlist: { ...WAITLIST, consent: "optional" } }, optIn: { mode: "checkbox" } }),
  ];
  assert.ok(TELLS.length > 10, "the copy lint's word list wasn't found in scripts/qa.mjs");
  for (const config of configs) {
    const all = `${text(privacyUse(config))} ${Object.values(thanksCopy(config)).flat().join(" ")}`;
    assert.deepEqual(lint(all), [], all);
  }
});
