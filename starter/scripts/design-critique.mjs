#!/usr/bin/env node
// Critique rounds (docs/SPEC.md section 8): after the hard gates pass, at most three rounds of vision-model
// critique, each with at most three located fixes, and a revision is kept only if a pairwise judge prefers it in
// both orders. The critic and the judge are the agent's own vision model; this script runs the loop and keeps
// its rules. Method and sources: docs/research/design-layer.md in Framework B ("Deterministic gates run first").
//
//   npm run build && node scripts/design-critique.mjs start
//       screenshots every page at 1280 and 390 px (first screen and full page) into design/critique/round-N/before/
//       and writes design/critique/round-N.md, the rubric to fill in.
//   node scripts/design-critique.mjs score
//       reads the filled rubric. Every dimension at 4 or more with at most one tell ends the loop. Otherwise
//       apply the listed fixes (at most three), without committing, then:
//   node scripts/design-critique.mjs compare
//       remakes what the fixes made stale (tokens.css after a DESIGN.md fix, the style guide after a change to its
//       inputs; these join the fixes), rebuilds, runs the QA gate (a failing gate reverts the fixes and ends the
//       loop), screenshots again, and
//       writes ballots: every changed page and width, before and after, both ways round, shuffled. A ballot shows
//       what the fix changed: the first screen when the change is all within it (the view the judge was calibrated
//       on), else the part of the page that changed, found by comparing the full-page screenshots row by row: a
//       window round it (a quarter of a screen above and below, one to two screens tall), or, for a change longer
//       than two screens, its first and last screen stacked. Ballots once showed only the first screen whenever
//       that changed, so a fix lower on the page (a contact page's message box) couldn't win (roadmap step 2,
//       2026-11-18). ballot.json records each ballot's view and the rows it shows. Fixes that add or take away a page
//       are refused (the round stays open to revise them): a round judges changes to the pages that were there.
//       Look at each ballot-NN.png in design/critique/round-N/ and write LEFT or RIGHT into ballot.json, then:
//   node scripts/design-critique.mjs decide
//       keeps the fixes only if "after" wins both ways round on every changed page; otherwise reverts them.
//       The loop ends after three rounds, or after a round with no accepted revision.
//
// Run it where the gates run: the scratch copy with Turnstile test keys (docs/BUILD.md step 5). The working tree
// must be clean when `score` runs (except site.config.json and wrangler.jsonc, which hold the test keys), so the
// fixes are exactly what changes after. State: design/critique/state.json lists each round's files; copy the
// accepted ones and design/critique/ back to the site's branch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import sharp from "sharp";
import { launchBrowser, startLocalSite } from "./lib/local-site.mjs";
import { leftoverPlaceholders, PLACEHOLDER } from "./lib/style-guide.mjs";
import { readInputs, STAMP, staleInputs } from "./lib/style-guide-stamp.mjs";

const DIR = "design/critique";
const STATE = join(DIR, "state.json");
export const MAX_ROUNDS = 3;
export const MAX_FIXES = 3;
export const DIMENSIONS = ["Hierarchy and clarity", "Subject-specificity", "Named tells", "Consistency with DESIGN.md", "Trust"];
const WIDTHS = [1280, 390];
const QUESTION = "Which version is better designed? Answer only LEFT or RIGHT.";
const SKIP = new Set(["/404", "/thanks", "/privacy", "/credits"]);
// Not fixes: the loop's own records and build output, and the two files fill-test-placeholders.mjs changes in the
// scratch copy the gates run in (docs/BUILD.md step 5), so test keys never count as a fix or get reverted.
const OWN = [/^design\/critique\//, /^qa-output\//, /^dist\//, /^\.wrangler\//, /^\.astro\//, /^site\.config\.json$/, /^wrangler\.jsonc$/];

const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { rounds: [], stopped: null });
const writeState = (s) => (mkdirSync(DIR, { recursive: true }), writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" });

// The rubric as written for the critic: scores, tells and fixes to fill in.
export function rubricTemplate(n, shots) {
  return [
    `# Critique round ${n}`,
    "",
    "Look at every screenshot in this round's `before/` folder, phone and desktop. Score each dimension from 1 to 5.",
    '"Named tells" scores how free the pages are of tells (5 = none); list each tell you see under Tells.',
    `List at most ${MAX_FIXES} fixes, each with where it goes (a file, a page or a section).`,
    "",
    "## Scores",
    "",
    ...DIMENSIONS.map((d) => `- ${d}: `),
    "",
    "## Tells",
    "",
    "- ",
    "",
    "## Fixes",
    "",
    "1. ",
    "",
    "## Screenshots",
    "",
    ...shots.map((s) => `- before/${s}`),
    "",
  ].join("\n");
}

// The filled rubric: { scores, tells, fixes, errors }.
export function parseRubric(md) {
  const section = (name) => (md.split(/^## /m).find((s) => s.startsWith(name)) || "").split("\n").slice(1);
  const errors = [];
  const scores = {};
  for (const d of DIMENSIONS) {
    const line = section("Scores").find((l) => l.replace(/^-\s*/, "").startsWith(`${d}:`));
    const v = Number(line?.split(":")[1]?.trim());
    if (!Number.isInteger(v) || v < 1 || v > 5) errors.push(`score "${d}" must be a whole number from 1 to 5`);
    scores[d] = v;
  }
  const tells = section("Tells").filter((l) => /^-\s+\S/.test(l)).map((l) => l.replace(/^-\s+/, "").trim());
  const fixes = section("Fixes").filter((l) => /^\d+\.\s+\S/.test(l)).map((l) => l.replace(/^\d+\.\s+/, "").trim());
  if (fixes.length > MAX_FIXES) errors.push(`at most ${MAX_FIXES} fixes a round (found ${fixes.length})`);
  return { scores, tells, fixes, errors };
}

// The stop rule after scoring: every dimension at 4 or more, and at most one tell.
export const rubricPasses = ({ scores, tells }) => DIMENSIONS.every((d) => scores[d] >= 4) && tells.length <= 1;

// The rows two screenshots of one page differ in, by trimming the rows they share at the top and at the bottom (so a
// change that makes the page longer or shorter is one region, not everything below it): { top, before, after },
// the first changed row and the end of the change (exclusive) in each. null when every row is the same; unaligned
// when the widths differ, so the rows can't be compared. a and b are raw pixels: { data, width, height, channels }.
export function changedRegion(a, b) {
  if (a.width !== b.width || a.channels !== b.channels) return { top: 0, before: a.height, after: b.height, unaligned: true };
  const row = a.width * a.channels;
  const same = (ya, yb) => a.data.compare(b.data, yb * row, (yb + 1) * row, ya * row, (ya + 1) * row) === 0;
  const min = Math.min(a.height, b.height);
  let top = 0;
  while (top < min && same(top, top)) top++;
  if (top === a.height && a.height === b.height) return null;
  let tail = 0;
  while (tail < min - top && same(a.height - 1 - tail, b.height - 1 - tail)) tail++;
  return { top, before: a.height - tail, after: b.height - tail };
}

// What a ballot shows of a changed page: { view: "first" } for the first screen,
// { view: "full" } for the whole page when the rows can't be aligned, or { view: "change", crops: { before, after } },
// each a list of { top, height } windows on that side's full-page screenshot.
export function ballotView(region, { screen, beforeHeight, afterHeight }) {
  if (region.unaligned) return { view: "full" };
  const end = Math.max(region.before, region.after);
  if (end <= screen) return { view: "first" };
  const margin = Math.round(screen / 4);
  if (end - region.top + 2 * margin <= 2 * screen) {
    // One window, at least a screen tall, the change in the middle of it when it is shorter than that. Each side keeps
    // the window within its own page, so a fix that makes the page longer or shorter near its end still shows the
    // whole change on the longer side (a shared window, clamped to the shorter page, cut it off).
    const height = Math.max(screen, end - region.top + 2 * margin);
    const centred = Math.round(region.top - (height - (end - region.top)) / 2);
    const win = (pageHeight) => ({ top: Math.max(0, Math.min(centred, pageHeight - height)), height });
    return { view: "change", crops: { before: [win(beforeHeight)], after: [win(afterHeight)] } };
  }
  // A long change (two fixes far apart, or one that moves everything): its first screen and its last. A side whose
  // own change ends within reach of the first screen (a fix that adds a long stretch shows little on the side
  // without it) gets one window as tall as the other side's two, so no rows are shown twice or out of order.
  const first = { top: Math.max(0, region.top - margin), height: screen };
  const side = (height, changeEnd) => {
    const last = { top: Math.max(0, Math.min(height, changeEnd + margin) - screen), height: screen };
    return last.top >= first.top + first.height ? [first, last] : [{ top: first.top, height: 2 * screen + GAP }];
  };
  return { view: "change", crops: { before: side(beforeHeight, region.before), after: side(afterHeight, region.after) } };
}

// One side of a "change" ballot: the windows cut from its full-page screenshot, stacked, with a dark band between
// two windows (rows left out) and grey where a window runs past the end of the page.
export const GAP = 24;
export async function cropStack(file, crops) {
  const { width, height } = await sharp(file).metadata();
  const total = crops.reduce((n, c) => n + c.height, 0) + GAP * (crops.length - 1);
  const parts = [];
  let y = 0;
  for (const [i, c] of crops.entries()) {
    if (i) {
      parts.push({ input: { create: { width, height: GAP, channels: 4, background: "#444444" } }, top: y, left: 0 });
      y += GAP;
    }
    const h = Math.min(c.height, height - c.top);
    if (h > 0) parts.push({ input: await sharp(file).extract({ left: 0, top: c.top, width, height: h }).png().toBuffer(), top: y, left: 0 });
    y += c.height;
  }
  return sharp({ create: { width, height: total, channels: 4, background: "#888888" } }).composite(parts).png().toBuffer();
}

// The commands compare runs before the build, from the files the fixes changed and the style guide's stale inputs
// (scripts/lib/style-guide-stamp.mjs): DESIGN.md's tokens, then the style guide when it has a stamp that is now old.
export function regenerateSteps(changed, staleGuideInputs) {
  const steps = [];
  if (changed.includes("DESIGN.md")) steps.push(["node", ["scripts/design-tokens.mjs"]]);
  if (staleGuideInputs.length) steps.push(["node", ["scripts/style-guide.mjs"]]);
  return steps;
}

// Why compare stopped, naming the step that failed. style-guide.mjs refuses a written section that still holds the
// template's placeholder line (and the QA gate fails one), and that once ended a round as "a hard gate failed", with
// nothing naming the line (follow-up from the 2026-11-26 reviews). `start` refuses a guide that holds the line and the
// tree is clean at score, so a line found here came from the fixes, and reverting them took it out again. `guide` is
// STYLE-GUIDE.md as the fixes left it.
export const GUIDE_STEP = "node scripts/style-guide.mjs";
export function gateFailure(n, step, guide) {
  const what = step === GUIDE_STEP ? "the style guide couldn't be rendered" : step === "npm run qa" ? "a hard gate (npm run qa) failed" : `${step || "a step"} failed`;
  const leftover = [GUIDE_STEP, "npm run qa"].includes(step) && guide ? leftoverPlaceholders(guide) : [];
  if (leftover.length) return `round ${n}: ${what} after the fixes: they left the line "${PLACEHOLDER}" in ${leftover.join(", ")} in STYLE-GUIDE.md, so they were reverted (rebuild before deploying)`;
  return `round ${n}: ${what} after the fixes, so they were reverted (rebuild before deploying)`;
}

// The pages a round's fixes add or take away, from the before and after screenshot names ("<page>-<width>-first.png").
export function pageChanges(beforeShots, afterShots) {
  const pagesIn = (list) => new Set(list.filter((f) => f.endsWith("-first.png")).map((f) => f.replace(/-\d+-first\.png$/, "")));
  const [was, now] = [pagesIn(beforeShots), pagesIn(afterShots)];
  return { added: [...now].filter((p) => !was.has(p)), removed: [...was].filter((p) => !now.has(p)) };
}

const rawPixels = async (file) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};

// Ballots for the changed screens, each shown both ways round, shuffled. Each changed item is a shot name, or
// { shot, view, crops } from ballotView.
export function makeBallots(changed, random = Math.random) {
  const list = changed.map((c) => (typeof c === "string" ? { shot: c } : c)).flatMap((c) => [
    { ...c, left: "before", right: "after" },
    { ...c, left: "after", right: "before" },
  ]);
  for (let i = list.length - 1; i > 0; i--) {
    const k = Math.floor(random() * (i + 1));
    [list[i], list[k]] = [list[k], list[i]];
  }
  return list.map((b, i) => ({ id: String(i + 1).padStart(2, "0"), image: `ballot-${String(i + 1).padStart(2, "0")}.png`, ...b, answer: "" }));
}

// Accepted only if "after" wins both ways round on every changed screen.
export function decideBallots(ballots) {
  const bad = ballots.filter((b) => !["LEFT", "RIGHT"].includes(String(b.answer).trim().toUpperCase()));
  if (bad.length) throw new Error(`ballots without a LEFT or RIGHT answer: ${bad.map((b) => b.id).join(", ")}`);
  const winner = (b) => (String(b.answer).trim().toUpperCase() === "LEFT" ? b.left : b.right);
  const shots = [...new Set(ballots.map((b) => b.shot))];
  const perShot = shots.map((shot) => {
    const w = ballots.filter((b) => b.shot === shot).map(winner);
    return { shot, result: w.length === 2 && w[0] === w[1] ? w[0] : "split" };
  });
  return { accepted: perShot.length > 0 && perShot.every((s) => s.result === "after"), perShot };
}

function pagesFromDist() {
  const dist = existsSync("dist/client") ? "dist/client" : "dist";
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".html") ? [join(d, e.name)] : []));
  const paths = walk(dist).map((f) => {
    const p = "/" + relative(dist, f).replace(/\\/g, "/").replace(/(index)?\.html$/, "");
    return p.length > 1 ? p.replace(/\/$/, "") : "/";
  });
  return [...new Set([...(dist === "dist/client" ? ["/"] : []), ...paths])].filter((p) => !SKIP.has(p)).sort();
}

async function screenshots(into) {
  mkdirSync(into, { recursive: true });
  const site = await startLocalSite({ port: 8797, name: "critique" });
  const browser = await launchBrowser();
  const shots = [];
  try {
    for (const path of pagesFromDist()) {
      for (const width of WIDTHS) {
        // Reduced motion shows every element in its final state (scroll-driven reveals start transparent below the
        // fold), and lazy images are loaded, so the full-page screenshot shows the page as a visitor ends up seeing it.
        const page = await browser.newPage({ viewport: { width, height: width > 600 ? 900 : 844 }, reducedMotion: "reduce" });
        await page.goto(site.base + path, { waitUntil: "networkidle" });
        await page.evaluate(async () => {
          const imgs = [...document.querySelectorAll('img[loading="lazy"]')];
          imgs.forEach((img) => { img.loading = "eager"; });
          await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 5000); }))));
        });
        const name = `${(path.slice(1) || "home").replace(/\//g, "_")}-${width}`;
        await page.screenshot({ path: join(into, `${name}-first.png`) });
        await page.screenshot({ path: join(into, `${name}-full.png`), fullPage: true });
        shots.push(`${name}-first.png`, `${name}-full.png`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
    site.stop();
  }
  return shots;
}

function changedFiles() {
  return git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^.* -> /, "") }))
    .filter((f) => !OWN.some((re) => re.test(f.path)));
}

function revert(files) {
  const tracked = files.filter((f) => f.code !== "??").map((f) => f.path);
  if (tracked.length) git("checkout", "HEAD", "--", ...tracked);
  for (const f of files.filter((f) => f.code === "??")) rmSync(f.path, { force: true });
}

const [cmd] = process.argv.slice(2);
const state = readState();
const round = state.rounds.at(-1);
const roundDir = (n) => join(DIR, `round-${n}`);

if (cmd === "start") {
  if (state.stopped) throw new Error(`The critique loop has ended: ${state.stopped}. Delete ${DIR}/ to start a new one.`);
  if (round && round.phase !== "done") throw new Error(`Round ${round.n} is still open (${round.phase}); finish it first.`);
  if (state.rounds.length >= MAX_ROUNDS) throw new Error(`${MAX_ROUNDS} rounds is the limit.`);
  // A guide that can't be rendered again would stop the first fix to DESIGN.md or STYLE-GUIDE.md in compare.
  const leftover = existsSync("STYLE-GUIDE.md") ? leftoverPlaceholders(readFileSync("STYLE-GUIDE.md", "utf8")) : [];
  if (leftover.length) throw new Error(`STYLE-GUIDE.md still holds the line "${PLACEHOLDER}" in ${leftover.join(", ")}: delete it, render the guide (${GUIDE_STEP}) and commit, then start.`);
  const n = state.rounds.length + 1;
  const shots = await screenshots(join(roundDir(n), "before"));
  writeFileSync(join(DIR, `round-${n}.md`), rubricTemplate(n, shots));
  state.rounds.push({ n, phase: "score" });
  writeState(state);
  console.log(`Round ${n}: ${shots.length} screenshots in ${roundDir(n)}/before. Fill in ${DIR}/round-${n}.md, then run: node scripts/design-critique.mjs score`);
} else if (cmd === "score") {
  if (round?.phase !== "score") throw new Error("Nothing to score; run start first.");
  const parsed = parseRubric(readFileSync(join(DIR, `round-${round.n}.md`), "utf8"));
  if (parsed.errors.length) throw new Error(`round-${round.n}.md:\n- ${parsed.errors.join("\n- ")}`);
  Object.assign(round, { scores: parsed.scores, tells: parsed.tells, fixes: parsed.fixes });
  if (rubricPasses(parsed)) {
    round.phase = "done";
    state.stopped = `round ${round.n} passed the rubric (every dimension 4 or more, at most one tell)`;
  } else if (!parsed.fixes.length) {
    throw new Error("The rubric doesn't pass, so list at least one fix.");
  } else {
    const dirty = changedFiles();
    if (dirty.length) throw new Error(`Commit or discard these first, so the fixes are all that changes: ${dirty.map((f) => f.path).join(", ")}`);
    round.phase = "fix";
  }
  writeState(state);
  console.log(state.stopped ? `Done: ${state.stopped}.` : `Apply these fixes (don't commit), then run: node scripts/design-critique.mjs compare\n${parsed.fixes.map((f, i) => `${i + 1}. ${f}`).join("\n")}`);
} else if (cmd === "compare") {
  if (round?.phase !== "fix") throw new Error("No fixes to compare; run score first.");
  const fixed = changedFiles();
  if (!fixed.length) throw new Error("Nothing changed since score; apply the fixes first.");
  round.files = fixed.map((f) => f.path);
  let step = `reading ${STAMP}`;
  try {
    // What a fix to DESIGN.md, STYLE-GUIDE.md or the logo makes stale (tokens, the style guide) is made again first,
    // or the QA gate fails on it and reverts the fix; the regenerated files are kept or reverted with the fixes.
    const stamp = existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, "utf8")) : null;
    const run = (c, a) => { step = [c, ...a].join(" "); execFileSync(c, a, { stdio: ["ignore", "ignore", "inherit"] }); };
    for (const [c, a] of regenerateSteps(fixed.map((f) => f.path), stamp ? staleInputs(stamp, readInputs()) : [])) run(c, a);
    step = "listing the changed files (git status)";
    round.files = changedFiles().map((f) => f.path);
    run("npm", ["run", "build"]);
    run("npm", ["run", "qa"]);
  } catch {
    // The tree was clean at score, so everything changed now is a fix or was made from one.
    const guide = existsSync("STYLE-GUIDE.md") ? readFileSync("STYLE-GUIDE.md", "utf8") : "";
    revert(changedFiles());
    Object.assign(round, { phase: "done", accepted: false });
    state.stopped = gateFailure(round.n, step, guide);
    writeState(state);
    throw new Error(state.stopped);
  }
  const after = join(roundDir(round.n), "after");
  const before = join(roundDir(round.n), "before");
  rmSync(after, { recursive: true, force: true });
  const shots = await screenshots(after);
  // A round judges changes to the pages that were there: a page the fixes add has nothing to compare with, and one
  // they take away can't be judged, so such a round is refused rather than accepted on the other pages alone.
  const { added, removed } = pageChanges(readdirSync(before), shots);
  if (added.length || removed.length) {
    writeState(state);
    throw new Error(`The fixes ${[added.length && `add ${added.join(", ")}`, removed.length && `take away ${removed.join(", ")}`].filter(Boolean).join(" and ")}. A critique round only judges changes to the pages that were there: undo that part of the fixes (add or remove pages outside the critique), then run compare again.`);
  }
  const same = (s) => readFileSync(join(before, s)).equals(readFileSync(join(after, s)));
  // Every changed page and width, judged on what changed (see the header): its first screen, or the rows that differ.
  const changed = [];
  for (const first of shots.filter((s) => s.endsWith("-first.png"))) {
    const shot = first.replace(/-first\.png$/, "");
    const full = `${shot}-full.png`;
    if (same(first) && same(full)) continue;
    const screen = Number(shot.match(/-(\d+)$/)[1]) > 600 ? 900 : 844;
    const [b, a] = await Promise.all([rawPixels(join(before, full)), rawPixels(join(after, full))]);
    const region = changedRegion(b, a);
    if (!region && same(first)) continue;
    changed.push({ shot, ...(region ? ballotView(region, { screen, beforeHeight: b.height, afterHeight: a.height }) : { view: "first" }) });
  }
  const ballots = makeBallots(changed);
  const browser = await launchBrowser();
  for (const b of ballots) {
    const png = async (side) => {
      const dir = join(roundDir(round.n), side);
      if (b.view === "change") return cropStack(join(dir, `${b.shot}-full.png`), b.crops[side]);
      return readFileSync(join(dir, `${b.shot}-${b.view === "full" ? "full" : "first"}.png`));
    };
    const img = async (side) => `data:image/png;base64,${(await png(side)).toString("base64")}`;
    const w = b.shot.endsWith("-390") ? 390 : 1280;
    const page = await browser.newPage({ viewport: { width: 2 * w + 40, height: (w > 600 ? 900 : 844) + 60 } });
    // Change windows and full pages can be long: the screenshot below is fullPage, so both sides are shown whole.
    await page.setContent(`<!doctype html><body style="margin:0;background:#888;font:bold 28px system-ui;color:#fff"><div style="display:flex;gap:40px">
      <div><div style="height:60px;line-height:60px;padding-left:12px">LEFT</div><img src="${await img(b.left)}" style="display:block;width:${w}px"></div>
      <div><div style="height:60px;line-height:60px;padding-left:12px">RIGHT</div><img src="${await img(b.right)}" style="display:block;width:${w}px"></div></div></body>`);
    await page.screenshot({ path: join(roundDir(round.n), b.image), fullPage: true });
    await page.close();
  }
  await browser.close();
  writeFileSync(join(roundDir(round.n), "ballot.json"), JSON.stringify({ question: QUESTION, ballots }, null, 2) + "\n");
  round.phase = ballots.length ? "judge" : "fix";
  writeState(state);
  if (!ballots.length) console.log("The fixes changed no page, so there is nothing to judge. Revise them and run compare again.");
  else console.log(`${ballots.length} ballots in ${roundDir(round.n)}. For each ballot-NN.png: ${QUESTION} Write the answer into ballot.json, then run: node scripts/design-critique.mjs decide`);
} else if (cmd === "decide") {
  if (round?.phase !== "judge") throw new Error("No ballots to decide; run compare first.");
  const { ballots } = JSON.parse(readFileSync(join(roundDir(round.n), "ballot.json"), "utf8"));
  const { accepted, perShot } = decideBallots(ballots);
  if (!accepted) revert(changedFiles().filter((f) => round.files.includes(f.path)));
  Object.assign(round, { phase: "done", accepted, judged: perShot });
  if (!accepted) state.stopped = `round ${round.n} produced no accepted revision`;
  else if (round.n >= MAX_ROUNDS) state.stopped = `${MAX_ROUNDS} rounds done`;
  writeState(state);
  const lines = perShot.map((s) => `- ${s.shot}: ${s.result === "after" ? "after wins both ways" : s.result === "before" ? "before wins both ways" : "split"}`);
  console.log(`${accepted ? "Accepted: commit the fixes with design/critique/." : "Reverted: the fixes didn't win both ways round on every changed screen. Rebuild before deploying."}\n${lines.join("\n")}${state.stopped ? `\nThe loop has ended: ${state.stopped}.` : "\nNext round: npm run build && node scripts/design-critique.mjs start"}`);
} else if (cmd) {
  console.error("usage: design-critique.mjs start | score | compare | decide");
  process.exit(2);
}
