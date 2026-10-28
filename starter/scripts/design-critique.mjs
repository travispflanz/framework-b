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
//       rebuilds, runs the QA gate (a failing gate reverts the fixes and ends the loop), screenshots again, and
//       writes ballots: every changed page and width (its first screen if that changed, else the full page),
//       before and after, both ways round, shuffled.
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
import { launchBrowser, startLocalSite } from "./lib/local-site.mjs";

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

// Ballots for the changed screens, each shown both ways round, shuffled.
export function makeBallots(changed, random = Math.random) {
  const list = changed.flatMap((shot) => [
    { shot, left: "before", right: "after" },
    { shot, left: "after", right: "before" },
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
  const files = changedFiles();
  if (!files.length) throw new Error("Nothing changed since score; apply the fixes first.");
  round.files = files.map((f) => f.path);
  try {
    execFileSync("npm", ["run", "build"], { stdio: ["ignore", "ignore", "inherit"] });
    execFileSync("npm", ["run", "qa"], { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    revert(files);
    Object.assign(round, { phase: "done", accepted: false });
    state.stopped = `round ${round.n}: a hard gate failed after the fixes, so they were reverted (rebuild before deploying)`;
    writeState(state);
    throw new Error(state.stopped);
  }
  const after = join(roundDir(round.n), "after");
  const shots = await screenshots(after);
  // A changed page is judged on its first screen when that changed (the calibrated view), else on the full page.
  const differs = (s) => {
    const b = join(roundDir(round.n), "before", s);
    return !existsSync(b) || !readFileSync(b).equals(readFileSync(join(after, s)));
  };
  const changed = shots.filter((s) => s.endsWith("-first.png")).map((s) => (differs(s) ? s : s.replace("-first.png", "-full.png"))).filter((s) => {
    const b = join(roundDir(round.n), "before", s);
    return !existsSync(b) || !readFileSync(b).equals(readFileSync(join(after, s)));
  });
  const ballots = makeBallots(changed);
  const browser = await launchBrowser();
  for (const b of ballots) {
    const img = (side) => `data:image/png;base64,${readFileSync(join(roundDir(round.n), side, b.shot)).toString("base64")}`;
    const w = b.shot.includes("-390-") ? 390 : 1280;
    const page = await browser.newPage({ viewport: { width: 2 * w + 40, height: (w > 600 ? 900 : 844) + 60 } });
    // Full pages can be long: the screenshot below is fullPage, so both whole pages are shown.
    await page.setContent(`<!doctype html><body style="margin:0;background:#888;font:bold 28px system-ui;color:#fff"><div style="display:flex;gap:40px">
      <div><div style="height:60px;line-height:60px;padding-left:12px">LEFT</div><img src="${img(b.left)}" style="display:block;width:${w}px"></div>
      <div><div style="height:60px;line-height:60px;padding-left:12px">RIGHT</div><img src="${img(b.right)}" style="display:block;width:${w}px"></div></div></body>`);
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
