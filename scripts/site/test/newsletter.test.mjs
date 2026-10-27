import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, markdownToText, parseIssue, renderIssue, syncPlan, UNSUBSCRIBE } from "../lib/newsletter.mjs";

const issue = `---
subject: "Where we'll be in June"
preview: Three dates and a new booth
---
## June dates

Saturday at the **park**. Details on [our site](https://example.com/events).

- First thing
- Second _thing_

<script>alert(1)</script>
`;

test("an issue needs a subject and a body", () => {
  const i = parseIssue(issue);
  assert.equal(i.subject, "Where we'll be in June");
  assert.equal(i.preview, "Three dates and a new booth");
  assert.ok(i.body.startsWith("## June dates"));
  assert.throws(() => parseIssue("no front matter"), /front matter/);
  assert.throws(() => parseIssue("---\npreview: x\n---\nbody"), /subject/);
  assert.throws(() => parseIssue("---\nsubject: x\n---\n"), /no body/);
});

test("Markdown becomes simple email HTML, with HTML in the source escaped", () => {
  const html = markdownToHtml(parseIssue(issue).body);
  assert.match(html, /<h2[^>]*>June dates<\/h2>/);
  assert.match(html, /<strong>park<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com\/events">our site<\/a>/);
  assert.match(html, /<ul[^>]*><li>First thing<\/li><li>Second <em>thing<\/em><\/li><\/ul>/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!markdownToHtml("[x](javascript:alert(1))").includes("href"), "only http(s) and mailto links");
});

test("plain text keeps link targets", () => {
  assert.equal(markdownToText("## Hi\n\nSee [the site](https://example.com) **now**."), "Hi\n\nSee the site (https://example.com) now.");
});

test("the email carries the postal address and Resend's unsubscribe link", () => {
  const r = renderIssue(parseIssue(issue), { siteName: "Example Co", postalAddress: "PO Box 1, Town, KS", siteUrl: "https://example.com" });
  assert.equal(r.subject, "Where we'll be in June");
  for (const part of [r.html, r.text]) {
    assert.ok(part.includes("PO Box 1, Town, KS"));
    assert.ok(part.includes(UNSUBSCRIBE));
  }
  assert.throws(() => renderIssue(parseIssue(issue), { siteName: "X", postalAddress: "" }), /postal address/);
});

test("sync plan keeps D1 as the record and never touches the global unsubscribe flag", () => {
  const subs = [
    { email: "new@example.com", status: "subscribed" },
    { email: "out@example.com", status: "subscribed" },
    { email: "in@example.com", status: "subscribed" },
    { email: "elsewhere@example.com", status: "subscribed" },
    { email: "left@example.com", status: "unsubscribed" },
    { email: "gone@example.com", status: "unsubscribed" },
  ];
  const contacts = new Map([
    ["out@example.com", { unsubscribed: true, inSegment: true }],
    ["in@example.com", { unsubscribed: false, inSegment: true }],
    ["elsewhere@example.com", { unsubscribed: false, inSegment: false }],
    ["left@example.com", { unsubscribed: false, inSegment: true }],
  ]);
  const p = syncPlan(subs, contacts);
  assert.deepEqual(p.create.map((s) => s.email), ["new@example.com"]);
  assert.deepEqual(p.unsubscribeInD1.map((s) => s.email), ["out@example.com"]);
  assert.deepEqual(p.addToSegment.map((s) => s.email), ["elsewhere@example.com"]);
  assert.deepEqual(p.removeFromSegment.map((s) => s.email), ["left@example.com"]);
  assert.equal(p.unchanged, 2);
});
