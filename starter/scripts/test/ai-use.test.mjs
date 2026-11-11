// How AI was used, for the Website assets page (src/lib/ai-use.js): where each picture appears, and only the steps
// the records name.
import test from "node:test";
import assert from "node:assert/strict";
import { aiSummary, aiText, isRightsStatement, outlineText, placements, STEPS, titleOf, whereText } from "../../src/lib/ai-use.js";

const pages = {
  home: { sections: [
    { _type: "fb_hero", headline: "Big *idea*", image: { src: "top.jpg", alt: "A camera", focalY: 0.3 } },
    { _type: "fb_features", headline: "What we do", items: [{ title: "Your own **page**", image: { src: "card.jpg", alt: "A ticket booth" } }] },
    { _type: "fb_doors", items: [{ title: "For backers", image: { src: "door.jpg" } }] },
  ] },
  about: { title: "About", sections: [
    { _type: "fb_hero", headline: "About us" },
    { _type: "fb_doors", items: [{ title: "For backers", image: { src: "door.jpg" } }] },
    { _type: "fb_people", people: [{ name: "Ada Example", photo: { src: "ada.jpg" } }] },
  ] },
};

test("each picture is found on its pages, named by the card, person or door it sits in", () => {
  const p = placements(pages);
  assert.equal(whereText(p.get("top.jpg")), "the top of the Home page");
  assert.equal(p.get("top.jpg")[0].framed, true, "a focal point counts as framing");
  assert.equal(whereText(p.get("card.jpg")), "“Your own page” on Home", "headline markup comes off");
  assert.equal(whereText(p.get("door.jpg")), "“For backers” on Home and About", "one spot on two pages is said once");
  assert.equal(whereText(p.get("ada.jpg")), "“Ada Example” on About");
});

test("only the recorded steps are claimed, in the order the work was done", () => {
  const archive = { file: "src/assets/images/top.jpg", source: "stock", archive: "Library of Congress", alt: "A camera", changes: "Cropped inside the scan's borders, resized and compressed. Converted to black and white, film grain added.", treated: "Converted to black and white, film grain added.", ai: ["chose", "cropped", "treated", "alt"], spot: { what: "the camera and its tripod", chosenBy: "Example Model" } };
  assert.equal(aiText(archive, { places: [{ page: "Home", where: "top of the page", framed: true }] }),
    "Chose it from the Library of Congress, cropped it inside the scan's borders, framed it for each layout (what stays in view where a layout cuts it to fit), gave it the site's look (black and white with film grain), wrote its description for screen readers and added one spot of colour to the camera and its tripod.");
  assert.equal(aiText(archive, { places: [{ page: "Home", where: "top of the page", framed: true }], brief: true }),
    "Chose it, cropped it inside the scan's borders, framed it for each layout, gave it the site's look, wrote its description for screen readers and added one spot of colour to the camera and its tripod.",
    "brief: the entry names the source, and the summary explains framing and the look once");
  const own = { file: "src/assets/images/ada.jpg", source: "owner", alt: "Ada" };
  assert.equal(aiText(own), "", "an owner's photo with no record claims nothing");
  assert.equal(aiText({ ...own, ai: ["alt"] }), "Wrote its description for screen readers.");
  assert.equal(aiText({ file: "public/logo.svg", source: "brand", ai: ["drew"] }), "Drew it.");
  assert.equal(aiText({ source: "generated", model: "Example Diffusion 1", ai: ["generated"] }), "Made it with Example Diffusion 1.");
  assert.ok(STEPS.includes("generated"));
});

test("the summary says what was done across the pictures, and the gradient only when a picture tops a page", () => {
  const by = "Example Model";
  const images = [
    { source: "stock", archive: "Library of Congress", ai: ["chose", "cropped", "treated", "alt"], treated: "Converted to black and white, film grain added." },
    { source: "brand", ai: ["drew"] },
  ];
  const text = aiSummary(images, { by, heroes: true });
  assert.match(text, /^Example Model did this site's picture work: it chose the photographs from the Library of Congress, cropped them, gave them one look \(black and white with film grain\), wrote their descriptions for screen readers and drew the logo\./);
  assert.match(text, /No photograph was made up/);
  assert.match(text, /dark gradient/);
  assert.doesNotMatch(aiSummary(images, { by }), /gradient/);
  assert.doesNotMatch(aiSummary([...images, { source: "generated", ai: ["generated"] }], { by }), /made up/, "not said once an image is generated");
  assert.equal(aiSummary([{ source: "owner" }], { by }), "", "nothing to say without a record");
});

test("the owner's own pictures are provided, not chosen, and each spot of colour says how its outline was made", () => {
  const by = "Example Model";
  const archive = { source: "stock", archive: "Library of Congress", ai: ["chose", "treated"], treated: "Converted to black and white.", spot: { what: "a hat" } };
  const own = { source: "owner", ai: ["treated", "alt"], treated: "Converted to black and white.", spot: { what: "a T-shirt" } };
  const text = aiSummary([archive, own], { by });
  assert.match(text, /it chose the archive photographs from the Library of Congress/);
  assert.match(text, /The owner provided their own pictures; the model didn't choose those\./);
  assert.match(text, /added one spot of colour to each photograph/);
  assert.match(aiSummary([archive, { ...own, spot: undefined }], { by }), /to the photographs that say so/);
  assert.doesNotMatch(aiSummary([archive], { by }), /archive photographs|provided/, "no owner pictures, nothing to set apart");
  assert.equal(outlineText({ spot: { segmenter: "SlimSAM (Xenova/slimsam-77-uniform) with Transformers.js, kept within a box; pieces drawn by hand (quads)" } }), "Its outline was made with SlimSAM and drawn as shapes by the model itself.");
  assert.equal(outlineText({ spot: { segmenter: "lightness: lighter than its surroundings, round spots" } }), "Its outline was found as round spots of light and picked out by its tone.");
  assert.equal(outlineText({ spot: { segmenter: "SlimSAM, outlined on the colour original" } }), "Its outline was made with SlimSAM, on the colour original.");
  assert.equal(outlineText({}), "");
  assert.equal(titleOf({ title: " Filming a scene " }), "Filming a scene");
  assert.equal(titleOf({}), "the original record");
  assert.ok(isRightsStatement({ license: "No known restrictions on publication" }));
  assert.ok(!isRightsStatement({ license: "CC BY 4.0" }));
});
