#!/usr/bin/env node
// Autopilot judge for style tiles (docs/SPEC.md section 12), run as it was calibrated
// (docs/research/trials.md, 2026-10-22: 15 of 16 clear human-majority pairs, 24 of 24 order-consistent):
// pairwise, first-screen crops, every pair shown both ways round in shuffled order, the judge answering only
// LEFT or RIGHT. The judge is the agent's own vision model; this script prepares the ballots and counts them.
// Any other judge model must first pass the calibration set (at least 14 of 16 clear pairs, full consistency).
//
//   node scripts/design-judge.mjs prepare [--tiles design/tiles]   → design/judge/ballot-NN.png + ballot.json
//   (the judge looks at each ballot-NN.png and writes "LEFT" or "RIGHT" into its "answer" in ballot.json)
//   node scripts/design-judge.mjs tally                            → design/judge/result.md and result.json
//
// Two views of every pair, each both ways round: "first", the first screen (1280 × 900, the calibrated view), and
// "rest", the tile below it (the colours, the type, the site's real form and the first section after the hero).
// Until 2026-11-18 the ballots showed the first screen only, so nothing below the hero (a draft's form, say) was ever
// judged (roadmap step 2).
// Rules: a tile beats another only if it wins the first screen both ways round, and the other doesn't win the rest
// both ways round; anything else (a split, one way only, or a lower half that loses both ways) is a tie. The rest of
// the tile can stop a win but never make one: that view isn't calibrated (untested against the calibration set).
// The ranking counts wins. When the top tiles tie, autopilot takes the one closer to the intake answers and
// records that.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { launchBrowser } from "./lib/local-site.mjs";

export const SCREEN = { width: 1280, height: 900 };
export const QUESTION = "Which design looks better at first glance? Answer only LEFT or RIGHT.";
export const REST_QUESTION = "Which design looks better here, below the first screen? Answer only LEFT or RIGHT.";
// The rest of a tile is judged only when there is at least this much of it (px).
const REST_MIN = 120;

// Every pair of tiles, both ways round, on each view (rest only for pairs whose tiles both have it), shuffled so
// the two orders of a pair are rarely seen back to back.
export function makeJudgeBallots(tiles, { rest = () => true, random = Math.random } = {}) {
  const list = [];
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const [a, b] = [tiles[i], tiles[j]];
      for (const view of ["first", ...(rest(a) && rest(b) ? ["rest"] : [])]) list.push({ view, left: a, right: b }, { view, left: b, right: a });
    }
  }
  for (let i = list.length - 1; i > 0; i--) {
    const k = Math.floor(random() * (i + 1));
    [list[i], list[k]] = [list[k], list[i]];
  }
  return list.map((b, n) => ({ id: String(n + 1).padStart(2, "0"), image: `ballot-${String(n + 1).padStart(2, "0")}.png`, ...b, answer: "" }));
}

// The count (see the rules above). Ballots without a view (made before 2026-11-18) are first-screen ballots.
export function tallyBallots(ballots) {
  const bad = ballots.filter((b) => !["LEFT", "RIGHT"].includes(String(b.answer).trim().toUpperCase()));
  if (bad.length) throw new Error(`ballots without a LEFT or RIGHT answer: ${bad.map((b) => b.id).join(", ")}`);
  const winnerOf = (b) => (String(b.answer).trim().toUpperCase() === "LEFT" ? b.left : b.right);
  const names = [...new Set(ballots.flatMap((b) => [b.left, b.right]))];
  const wins = Object.fromEntries(names.map((n) => [n, 0]));
  const matches = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, c] = [names[i], names[j]];
      const of = (view) => ballots.filter((b) => (b.view || "first") === view && [b.left, b.right].sort().join() === [a, c].sort().join()).map(winnerOf);
      const bothWays = (w) => (w.length === 2 && w[0] === w[1] ? w[0] : null);
      const first = bothWays(of("first"));
      const restVotes = of("rest");
      const rest = bothWays(restVotes);
      const blocked = !!first && !!rest && rest !== first;
      const winner = first && !blocked ? first : null;
      if (winner) wins[winner]++;
      matches.push({ a, b: c, winner: winner || "tie", first: first || "split", rest: restVotes.length ? rest || "split" : "not judged", blocked });
    }
  }
  const ranking = [...names].sort((x, y) => wins[y] - wins[x]);
  const top = ranking.filter((n) => wins[n] === wins[ranking[0]]);
  return { ranking: ranking.map((n) => ({ name: n, wins: wins[n] })), matches, pick: top.length === 1 ? top[0] : null, tied: top.length > 1 ? top : [], wins };
}

const page2 = (left, right, height) => `<!doctype html><html><body style="margin:0;background:#888;font:bold 28px system-ui;color:#fff">
      <div style="display:flex;gap:40px;padding:0"><div><div style="height:60px;line-height:60px;padding-left:12px">LEFT</div>${left(height)}</div>
      <div><div style="height:60px;line-height:60px;padding-left:12px">RIGHT</div>${right(height)}</div></div></body></html>`;

async function prepare(TILES, OUT) {
  const tiles = JSON.parse(readFileSync(join(TILES, "tiles.json"), "utf8")).filter((t) => t.ok).map((t) => t.name);
  if (tiles.length < 2) throw new Error("need at least two tiles that passed (run scripts/design-tiles.mjs first)");
  const file = (name) => join(TILES, name, "tile-1280.png");
  const heights = Object.fromEntries(await Promise.all(tiles.map(async (t) => [t, (await sharp(file(t)).metadata()).height])));
  const ballots = makeJudgeBallots(tiles, { rest: (t) => heights[t] - SCREEN.height >= REST_MIN });
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 2 * SCREEN.width + 40, height: SCREEN.height + 60 } });
  for (const b of ballots) {
    const img = (name) => `data:image/png;base64,${readFileSync(file(name)).toString("base64")}`;
    if (b.view === "first") {
      // First screen only (1280 × 900 of each tile), labelled LEFT and RIGHT, no draft names: as calibrated.
      const side = (name) => () => `<div style="width:1280px;height:900px;background:url(${img(name)}) top left/1280px auto no-repeat"></div>`;
      await page.setContent(page2(side(b.left), side(b.right)));
      await page.screenshot({ path: join(OUT, b.image) });
    } else {
      // The rest of each tile, from the bottom of the first screen to the end, at full size.
      const height = Math.max(heights[b.left], heights[b.right]) - SCREEN.height;
      const side = (name) => (h) => `<div style="width:1280px;height:${h}px;background:url(${img(name)}) 0 -${SCREEN.height}px/1280px auto no-repeat"></div>`;
      await page.setContent(page2(side(b.left), side(b.right), height));
      await page.screenshot({ path: join(OUT, b.image), fullPage: true });
    }
  }
  await browser.close();
  writeFileSync(join(OUT, "ballot.json"), JSON.stringify({ question: QUESTION, restQuestion: REST_QUESTION, ballots }, null, 2) + "\n");
  const rest = ballots.filter((b) => b.view === "rest").length;
  console.log(`${ballots.length} ballots in ${OUT}. For each ballot-NN.png marked "first" in ballot.json: ${QUESTION}${rest ? ` For each marked "rest" (the tile below the first screen): ${REST_QUESTION}` : ""} Write the answer into ballot.json, then run: node scripts/design-judge.mjs tally`);
}

function tally(OUT) {
  const { ballots } = JSON.parse(readFileSync(join(OUT, "ballot.json"), "utf8"));
  const result = tallyBallots(ballots);
  const { wins, ...saved } = result;
  writeFileSync(join(OUT, "result.json"), JSON.stringify(saved, null, 2) + "\n");
  const n = result.ranking.length;
  const md = [
    "# Autopilot judge",
    "",
    `Pairwise, both ways round (method: docs/research/trials.md in Framework B): the first screen (${QUESTION}) decides; the rest of the tile (${REST_QUESTION}) can only stop a win.`,
    "",
    "| Pair | First screen | Rest of the tile | Result |",
    "|---|---|---|---|",
    ...result.matches.map((m) => `| ${m.a} vs ${m.b} | ${m.first === "split" ? "split" : `${m.first} both ways`} | ${m.rest === "split" || m.rest === "not judged" ? m.rest : `${m.rest} both ways`} | ${m.winner === "tie" ? (m.blocked ? "tie (the rest of the tile went the other way)" : "tie (split, or one way only)") : `${m.winner} wins`} |`),
    "",
    result.pick ? `**Pick: ${result.pick}** (${wins[result.pick]} of ${n - 1} pairs won).` : `**Tie between ${result.tied.join(" and ")}.** Use the one closer to the intake answers, and record why in DESIGN.md.`,
    "",
  ].join("\n");
  writeFileSync(join(OUT, "result.md"), md);
  console.log(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : fallback;
  };
  const TILES = resolve(opt("tiles", "design/tiles"));
  const OUT = resolve(opt("out", "design/judge"));
  if (cmd === "prepare") await prepare(TILES, OUT);
  else if (cmd === "tally") tally(OUT);
  else {
    console.error("usage: design-judge.mjs prepare|tally [--tiles design/tiles] [--out design/judge]");
    process.exit(2);
  }
}
