// What the generated privacy and thanks pages (src/pages/privacy.astro, src/pages/thanks.astro) say about the site's
// forms, worked out from site.config.json so the copy follows what each form actually does.
//   kind     "message" (the default): someone answers it, as with a contact, quote or booking request.
//            "waitlist": a sign-up to hear news; nobody answers it one to one.
//   consent  whether sending it subscribes anyone, as packages/core/src/forms.js decides: "none" never does; in auto
//            mode (`optIn.mode`) every other form does; in checkbox mode only a ticked box does, and a "required" box
//            must be ticked to send the form at all.
// Plain words only: the QA gate's copy lint reads these pages. Tested in scripts/test/form-copy.test.mjs.

// The same kinds as framework-b's scripts/site/lib/brief.mjs (its test checks they match).
export const FORM_KINDS = ["message", "waitlist"];

// Each form as { id, title, kind, subscribes ("always", "if-ticked" or "never"), file, confirms, thanks }. Takes the
// config as loaded by core's loadConfig, or as written.
export function describeForms(config) {
  const checkbox = config.optIn?.mode === "checkbox";
  const confirmMailer = (config.email?.confirm || "none") !== "none";
  return Object.entries(config.forms || {}).map(([id, f]) => {
    const consent = f.consent || "optional";
    return {
      id,
      title: f.title || id,
      kind: f.kind === "waitlist" ? "waitlist" : "message",
      subscribes: consent === "none" ? "never" : !checkbox || consent === "required" ? "always" : "if-ticked",
      file: !!f.file && f.file.enabled !== false,
      confirms: confirmMailer && f.confirm?.enabled !== false,
      thanks: f.thanks || "/thanks",
    };
  });
}

// One form's use of what it collects, after its title ("Join the waitlist: to email you when there's news.").
const USE = {
  message: {
    always: "to answer you, and to send you occasional emails.",
    "if-ticked": "to answer you, and, if you tick the box, to send you occasional emails.",
    never: "to answer you. It doesn't add you to any mailing list.",
  },
  waitlist: {
    always: "to email you when there's news.",
    "if-ticked": "to email you when there's news, if you tick the box.",
    never: "to keep your place on the waitlist. It doesn't add you to any mailing list.",
  },
};
// The same, when every form does the same thing.
const ALL = {
  message: {
    always: (n) => `To answer you, and to send you occasional emails. ${n > 1 ? "Every form signs" : "Sending the form signs"} you up for those emails.`,
    "if-ticked": () => "To answer you, and, if you tick the box on the form, to send you occasional emails. Only a ticked box signs you up.",
    never: () => "Only to answer you. Sending a form doesn't add you to any mailing list.",
  },
  waitlist: {
    always: () => "To email you when there's news. Joining the waitlist signs you up for those emails.",
    "if-ticked": () => "To email you when there's news, if you tick the box on the form. Only a ticked box signs you up.",
    never: () => "To keep your place on the waitlist. It doesn't add you to any mailing list.",
  },
};

// The privacy page's "How we use it": { text } when every form does the same thing, else { intro, forms: [{ title,
// text }], after } with one line per form.
export function privacyUse(config) {
  const forms = describeForms(config);
  const anyList = forms.some((f) => f.subscribes !== "never");
  const same = new Set(forms.map((f) => `${f.kind} ${f.subscribes} ${f.confirms}`)).size <= 1;
  if (same) {
    const f = forms[0] || { kind: "message", subscribes: "never", confirms: false };
    return {
      text: [
        ALL[f.kind][f.subscribes](forms.length),
        anyList && "Each one has an unsubscribe link, and you can unsubscribe at any time.",
        f.confirms && "After you send a form, you get one confirmation email.",
      ].filter(Boolean).join(" "),
    };
  }
  return {
    intro: "It depends on the form:",
    forms: forms.map((f) => ({ title: f.title, text: `${USE[f.kind][f.subscribes]}${f.confirms ? " You get one confirmation email." : ""}` })),
    after: anyList ? "Every email we send to a list has an unsubscribe link, and you can unsubscribe at any time." : "",
  };
}

// The thanks page for the forms that send visitors to `path` (a form's `thanks`, "/thanks" by default):
// { title, lines, file }. `file` is true when one of them takes a file (the page then explains a failed upload).
export function thanksCopy(config, path = "/thanks") {
  const all = describeForms(config);
  const here = all.filter((f) => f.thanks === path);
  const forms = here.length ? here : all;
  const lists = forms.filter((f) => f.kind === "waitlist");
  const messages = forms.filter((f) => f.kind === "message");
  const sure = lists.every((f) => f.subscribes === "always");
  const file = forms.some((f) => f.file);
  if (lists.length && !messages.length) {
    return sure
      ? { title: "You're on the list", lines: ["We'll email you when there's news."], file }
      : { title: "Thanks, we got it", lines: ["If you ticked the box, we'll email you when there's news."], file };
  }
  if (!lists.length) return { title: "Thanks, we got it", lines: ["We'll reply soon."], file };
  return {
    title: "Thanks, we got it",
    lines: [
      "If you sent us a message, we'll reply soon.",
      sure ? "If you joined the waitlist, we'll email you when there's news." : "If you joined the waitlist and ticked the box, we'll email you when there's news.",
    ],
    file,
  };
}
