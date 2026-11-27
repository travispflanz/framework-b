// Unit tests for where the e2e test looks for a form (scripts/lib/form-pages.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formPaths } from "../lib/form-pages.mjs";

const site = {
  home: { sections: [{ _type: "fb_hero" }, { _type: "fb_form", form: "waitlist" }] },
  about: { sections: [{ _type: "fb_hero" }, { _type: "fb_text" }] },
  apply: { sections: [{ _type: "fb_hero" }, { _type: "site_application", panel: { form: "apply" } }] },
  contact: { sections: [{ _type: "fb_hero" }, { _type: "fb_form", form: "contact" }] },
};
const read = (slug) => site[slug];
const pages = Object.keys(site);

test("a form section's page comes first, then the home page and /contact, then every content page", () => {
  assert.deepEqual(formPaths(pages, "contact", read), ["/contact", "/", "/about", "/apply"]);
  assert.deepEqual(formPaths(pages, "waitlist", read), ["/", "/contact", "/about", "/apply"]);
});

test("a form a site's own section draws is looked for on that section's page first", () => {
  assert.deepEqual(formPaths(pages, "apply", read), ["/apply", "/", "/contact", "/about"]);
});

test("a form no page names is still looked for on every page, so 'not on any page' is true", () => {
  assert.deepEqual(formPaths(pages, "quote", read), ["/", "/contact", "/about", "/apply"]);
  assert.deepEqual(formPaths([], "quote", read), ["/", "/contact"]);
  assert.deepEqual(formPaths(["empty"], "quote", () => ({})), ["/", "/contact", "/empty"]);
});
