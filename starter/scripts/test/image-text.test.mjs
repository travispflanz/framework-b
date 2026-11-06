// The QA gate's text-over-image contrast check (scripts/lib/image-text.mjs): the maths, and a real browser run
// proving it catches light text on a bright picture and passes the same text on a scrim.
//   node --test scripts/test/image-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { launchBrowser } from "../lib/local-site.mjs";
import { _histogramsInPage, BINS, contrast, histogram, isLarge, judge, luminance, measureImageText, parseColor, required } from "../lib/image-text.mjs";

test("luminance and contrast follow WCAG", () => {
  assert.equal(contrast(luminance(255, 255, 255), luminance(0, 0, 0)), 21);
  assert.equal(Math.round(contrast(luminance(255, 255, 255), luminance(0x76, 0x76, 0x76)) * 100) / 100, 4.54);
  assert.equal(contrast(0.2, 0.5), contrast(0.5, 0.2), "order doesn't matter");
});

test("computed colours parse in the forms browsers return", () => {
  assert.deepEqual(parseColor("rgb(246, 244, 240)"), { r: 246, g: 244, b: 240, a: 1 });
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0.5)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor("color(srgb 0 0 0 / 0.62)"), { r: 0, g: 0, b: 0, a: 0.62 });
  assert.equal(parseColor("canvastext"), null);
});

test("large text is 24 px, or 18.5 px bold, and needs 3:1", () => {
  assert.equal(isLarge(24, 400), true);
  assert.equal(isLarge(19, 700), true);
  assert.equal(isLarge(19, 600), false);
  assert.equal(required(16, 400), 4.5);
  assert.equal(required(40, 800), 3);
});

const fill = (n, rgb) => Array.from({ length: n }, () => rgb).flat();

test("light text is judged against the lightest part of the background, ignoring specks", () => {
  const white = { r: 255, g: 255, b: 255, a: 1 };
  assert.equal(Math.round(judge(histogram(fill(1000, [0, 0, 0])), white).ratio), 21);
  // 0.5% bright specks (film grain) don't decide; 5% of a bright area does.
  const specks = histogram([...fill(995, [10, 10, 10]), ...fill(5, [250, 250, 250])]);
  assert.ok(judge(specks, white).ratio > 15);
  const area = histogram([...fill(950, [10, 10, 10]), ...fill(50, [230, 230, 230])]);
  assert.ok(judge(area, white).ratio < 1.5);
});

test("dark text is judged against the darkest part, and translucent text is blended first", () => {
  const black = { r: 0, g: 0, b: 0, a: 1 };
  const j = judge(histogram([...fill(950, [250, 250, 250]), ...fill(50, [40, 40, 40])]), black);
  assert.equal(j.light, false);
  assert.ok(j.ratio < 2);
  const faint = judge(histogram(fill(100, [0, 0, 0])), { r: 255, g: 255, b: 255, a: 0.3 });
  assert.ok(faint.ratio < 4.5 && faint.ratio > 1);
  assert.equal(judge({ n: 0 }, black), null);
});

// A bright and a dark picture, and text over and beside them.
const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="800" height="400" fill="${fill}"/></svg>`;
const PAGE = `<!doctype html><html lang="en"><head><title>Image text</title><style>
  body { margin: 0; font: 18px/1.4 sans-serif; background: #fff; color: #111; }
  .panel { position: relative; width: 800px; height: 400px; margin-bottom: 20px; }
  .panel img { position: absolute; inset: 0; width: 100%; height: 100%; }
  .panel p { position: relative; margin: 0; padding: 40px; color: #f6f4f0; }
  .scrim { background: rgba(0, 0, 0, 0.62); display: inline-block; }
  .fixed { position: fixed; top: 0; left: 0; color: #f6f4f0; }
  .strip { display: flex; gap: 10px; overflow-x: auto; width: 400px; padding: 0; margin: 0; list-style: none; }
  .strip li { position: relative; flex: 0 0 82%; height: 200px; }
  .strip img { position: absolute; inset: 0; width: 100%; height: 100%; }
  .strip p { position: relative; margin: 0; padding: 20px; color: #f6f4f0; }
</style></head><body><main>
  <div class="panel" id="bright"><img src="/bright.svg" alt=""><p id="loose">Loose light text on a bright picture</p><a href="#main" style="position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;color:#f6f4f0">Screen readers only</a></div>
  <div class="panel"><img src="/bright.svg" alt=""><p><span class="scrim">Light text on a scrim over a bright picture</span></p></div>
  <div class="panel"><img src="/dark.svg" alt=""><p>Light text on a dark picture</p></div>
  <p>Ordinary text beside no picture at all</p>
  <ul class="strip">${[1, 2, 3].map((n) => `<li><img src="/bright.svg" alt=""><p>Strip card ${n} on a bright picture</p></li>`).join("")}</ul>
  <div class="fixed">A fixed bar over the first picture</div>
</main></body></html>`;

test("in a browser: loose text on a bright picture fails (also in a sideways strip), the scrim and the dark picture pass, other text is skipped", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/bright.svg") { res.setHeader("content-type", "image/svg+xml"); return res.end(svg("#e8e8e8")); }
    if (req.url === "/dark.svg") { res.setHeader("content-type", "image/svg+xml"); return res.end(svg("#1a1a1a")); }
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
    const scratch = await context.newPage();
    const rows = await measureImageText(page, scratch);
    const by = (t) => rows.find((r) => r.text.startsWith(t));
    assert.equal(rows.length, 6, JSON.stringify(rows));
    for (const n of [1, 2, 3]) assert.equal(by(`Strip card ${n}`)?.ok, false, `strip card ${n} is measured even off screen`);
    assert.equal(by("Loose").ok, false);
    assert.ok(by("Loose").ratio < 1.5);
    assert.equal(by("Light text on a scrim").ok, true);
    assert.equal(by("Light text on a dark").ok, true);
    assert.ok(rows[0].ratio <= rows[rows.length - 1].ratio, "worst first");
    assert.equal(by("Ordinary"), undefined);
    assert.equal(by("A fixed bar"), undefined);
    assert.equal(by("Screen readers only"), undefined, "text in a 1 px box (sr-only) can't be seen and isn't measured");

    // The browser's histogram matches the Node one for the same pixels.
    const png = await scratch.evaluate(() => {
      const c = document.createElement("canvas"); c.width = 4; c.height = 1;
      const x = c.getContext("2d");
      ["#000000", "#767676", "#e8e8e8", "#ffffff"].forEach((col, i) => { x.fillStyle = col; x.fillRect(i, 0, 1, 1); });
      return c.toDataURL("image/png").split(",")[1];
    });
    const [inBrowser] = await scratch.evaluate(_histogramsInPage, { png, boxes: [[{ x: 0, y: 0, w: 4, h: 1 }]], bins: BINS });
    assert.deepEqual(inBrowser.hist, histogram([0, 0, 0, 0x76, 0x76, 0x76, 0xe8, 0xe8, 0xe8, 255, 255, 255]).hist);
  } finally {
    await browser.close();
    server.close();
  }
});
