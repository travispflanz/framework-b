#!/usr/bin/env node
// Autopilot judge for style tiles (docs/SPEC.md section 12), run exactly as it was calibrated
// (docs/research/trials.md, 2026-10-22: 15 of 16 clear human-majority pairs, 24 of 24 order-consistent):
// pairwise, first-screen crops, every pair shown both ways round in shuffled order, the judge answering only
// LEFT or RIGHT. The judge is the agent's own vision model; this script prepares the ballots and counts them.
// Any other judge model must first pass the calibration set (at least 14 of 16 clear pairs, full consistency).
//
//   node scripts/design-judge.mjs prepare [--tiles design/tiles]   → design/judge/ballot-NN.png + ballot.json
//   (the judge looks at each ballot-NN.png and writes "LEFT" or "RIGHT" into its "answer" in ballot.json)
//   node scripts/design-judge.mjs tally                            → design/judge/result.md and result.json
//
// Rules from the calibration: a tile beats another only if it wins both ways round; a split is a tie. The ranking
// counts wins. When the top tiles tie, autopilot takes the one closer to the intake answers and records that.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchBrowser } from "./lib/local-site.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const TILES = resolve(opt("tiles", "design/tiles"));
const OUT = resolve(opt("out", "design/judge"));
const QUESTION = "Which design looks better at first glance? Answer only LEFT or RIGHT.";

if (cmd === "prepare") {
  const tiles = JSON.parse(readFileSync(join(TILES, "tiles.json"), "utf8")).filter((t) => t.ok).map((t) => t.name);
  if (tiles.length < 2) throw new Error("need at least two tiles that passed (run scripts/design-tiles.mjs first)");
  const pairs = [];
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) pairs.push([tiles[i], tiles[j]], [tiles[j], tiles[i]]);
  // Shuffle so the two orders of a pair are not seen back to back.
  for (let i = pairs.length - 1; i > 0; i--) {
    const k = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[k]] = [pairs[k], pairs[i]];
  }
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 2 * 1280 + 40, height: 900 + 60 } });
  const ballot = [];
  for (const [n, [left, right]] of pairs.entries()) {
    const id = String(n + 1).padStart(2, "0");
    const img = (name) => `data:image/png;base64,${readFileSync(join(TILES, name, "tile-1280.png")).toString("base64")}`;
    // First screen only (1280 × 900 of each tile), labelled LEFT and RIGHT, no draft names.
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#888;font:bold 28px system-ui;color:#fff">
      <div style="display:flex;gap:40px;padding:0"><div><div style="height:60px;line-height:60px;padding-left:12px">LEFT</div>
      <div style="width:1280px;height:900px;background:url(${img(left)}) top left/1280px auto no-repeat"></div></div>
      <div><div style="height:60px;line-height:60px;padding-left:12px">RIGHT</div>
      <div style="width:1280px;height:900px;background:url(${img(right)}) top left/1280px auto no-repeat"></div></div></div></body></html>`);
    await page.screenshot({ path: join(OUT, `ballot-${id}.png`) });
    ballot.push({ id, image: `ballot-${id}.png`, left, right, answer: "" });
  }
  await browser.close();
  writeFileSync(join(OUT, "ballot.json"), JSON.stringify({ question: QUESTION, ballots: ballot }, null, 2) + "\n");
  console.log(`${ballot.length} ballots in ${OUT}. For each ballot-NN.png: ${QUESTION} Write the answer into ballot.json, then run: node scripts/design-judge.mjs tally`);
} else if (cmd === "tally") {
  const { ballots } = JSON.parse(readFileSync(join(OUT, "ballot.json"), "utf8"));
  const bad = ballots.filter((b) => !["LEFT", "RIGHT"].includes(String(b.answer).trim().toUpperCase()));
  if (bad.length) throw new Error(`ballots without a LEFT or RIGHT answer: ${bad.map((b) => b.id).join(", ")}`);
  const winnerOf = (b) => (String(b.answer).trim().toUpperCase() === "LEFT" ? b.left : b.right);
  const names = [...new Set(ballots.flatMap((b) => [b.left, b.right]))];
  const wins = Object.fromEntries(names.map((n) => [n, 0]));
  const matches = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [a, c] = [names[i], names[j]];
      const both = ballots.filter((b) => [b.left, b.right].sort().join() === [a, c].sort().join()).map(winnerOf);
      const winner = both.length === 2 && both[0] === both[1] ? both[0] : null;
      if (winner) wins[winner]++;
      matches.push({ a, b: c, winner: winner || "tie" });
    }
  }
  const ranking = names.sort((x, y) => wins[y] - wins[x]);
  const top = ranking.filter((n) => wins[n] === wins[ranking[0]]);
  const result = { ranking: ranking.map((n) => ({ name: n, wins: wins[n] })), matches, pick: top.length === 1 ? top[0] : null, tied: top.length > 1 ? top : [] };
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2) + "\n");
  const md = [
    "# Autopilot judge",
    "",
    `Pairwise, both ways round, first screens (method: docs/research/trials.md in Framework B). ${QUESTION}`,
    "",
    "| Pair | Result |",
    "|---|---|",
    ...matches.map((m) => `| ${m.a} vs ${m.b} | ${m.winner === "tie" ? "tie (split, or one way only)" : `${m.winner} wins both ways`} |`),
    "",
    result.pick ? `**Pick: ${result.pick}** (${wins[result.pick]} of ${names.length - 1} pairs won both ways).` : `**Tie between ${top.join(" and ")}.** Use the one closer to the intake answers, and record why in DESIGN.md.`,
    "",
  ].join("\n");
  writeFileSync(join(OUT, "result.md"), md);
  console.log(md);
} else {
  console.error("usage: design-judge.mjs prepare|tally [--tiles design/tiles] [--out design/judge]");
  process.exit(2);
}
