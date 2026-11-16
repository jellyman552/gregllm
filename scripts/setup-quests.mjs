#!/usr/bin/env node
// Downloads the GTNH 2.9.0 quest book (BetterQuesting "DefaultQuests") from the public
// GTNewHorizons/GT-New-Horizons-Modpack repo and converts it to data/quests.json.
//
// The quest book is licensed CC BY-NC-SA 4.0 by the GTNH team. It is fetched on your machine and
// never committed here (this repo is MIT). Needs git (a sparse, blobless clone of one folder,
// about 40 MB) and Node 18+.
//
//   node scripts/setup-quests.mjs [--from <path to a DefaultQuests folder>]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/data.mjs";

const SOURCE = {
  repo: "https://github.com/GTNewHorizons/GT-New-Horizons-Modpack",
  tag: "2.9.0",
  commit: "79f9a03b5dd9e492d28998b9dee0ea1d1822a6b1",
  path: "config/betterquesting/DefaultQuests",
  license: "CC BY-NC-SA 4.0 (GTNH team)",
};
const OUT = join(ROOT, "data", "quests.json");
const CACHE = join(ROOT, "data", "modpack-quests");

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
let dir = fromIdx >= 0 ? args[fromIdx + 1] : null;

if (!dir) {
  dir = join(CACHE, SOURCE.path);
  if (!existsSync(join(dir, "QuestLinesOrder.txt"))) {
    rmSync(CACHE, { recursive: true, force: true });
    mkdirSync(join(ROOT, "data"), { recursive: true });
    console.log(`Fetching the ${SOURCE.tag} quest book from ${SOURCE.repo} (sparse git clone, about 40 MB)...`);
    const git = (...a) => execFileSync("git", a, { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
    try {
      git("-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", SOURCE.tag, "--filter=blob:none", "--sparse", SOURCE.repo, CACHE);
      git("-C", CACHE, "sparse-checkout", "set", SOURCE.path);
    } catch (e) {
      console.error("git clone failed. Install git, or download the folder yourself and pass --from <DefaultQuests folder>.");
      process.exit(1);
    }
    const head = execFileSync("git", ["-C", CACHE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (head !== SOURCE.commit) {
      console.error(`Tag ${SOURCE.tag} now points to ${head}, not the pinned ${SOURCE.commit}. Check it, then update SOURCE.commit.`);
      process.exit(1);
    }
  }
}

// --- helpers ---------------------------------------------------------------------------------
const clean = s => String(s ?? "")
  .replace(/§./g, "")
  .replace(/\[\/?(warn|note|url|quest)\]/gi, "")
  .replace(/\r/g, "")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .trim();
const qid = o => `${o["questIDHigh:4"]}:${o["questIDLow:4"]}`;
const vals = o => Object.values(o ?? {});
// BetterQuesting's base64 quest ids ("AAAA...pA==") -> our "high:low" ids.
const b64ToId = b64 => {
  const buf = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf.length !== 16) return null;
  return `${buf.readBigInt64BE(0)}:${buf.readBigInt64BE(8)}`;
};
const stack = s => {
  const ore = s["OreDict:8"] || "";
  const dmg = s["Damage:2"] ?? 0;
  const out = { id: `i:${s["id:8"]}:${dmg === 32767 ? "*" : dmg}`, count: s["Count:3"] ?? 1 };
  if (ore) out.ore = ore;
  return out;
};

// --- quest lines -------------------------------------------------------------------------------
const order = readFileSync(join(dir, "QuestLinesOrder.txt"), "utf8").split("\n").map(l => l.trim()).filter(Boolean)
  .map(l => { const i = l.indexOf(": "); return { b64: l.slice(0, i), name: l.slice(i + 2) }; });
const lines = [];
const questLines = new Map(); // quest id -> [{line, x, y}]
for (const folder of readdirSync(join(dir, "QuestLines"))) {
  const base = join(dir, "QuestLines", folder);
  const meta = JSON.parse(readFileSync(join(base, "QuestLine.json"), "utf8"));
  const p = meta["properties:10"]["betterquesting:10"];
  const id = `${meta["questLineIDHigh:4"]}:${meta["questLineIDLow:4"]}`;
  const ord = order.findIndex(o => b64ToId(o.b64) === id);
  const line = { id, key: folder.replace(/-.*$/, ""), name: clean(p["name:8"]), desc: clean(p["desc:8"]), order: ord < 0 ? 999 : ord, quests: [] };
  for (const f of readdirSync(base)) {
    if (f === "QuestLine.json") continue;
    const e = JSON.parse(readFileSync(join(base, f), "utf8"));
    const q = qid(e);
    line.quests.push(q);
    if (!questLines.has(q)) questLines.set(q, []);
    questLines.get(q).push({ line: id, x: e["x:3"], y: e["y:3"] });
  }
  lines.push(line);
}
lines.sort((a, b) => a.order - b.order);

// --- quests ------------------------------------------------------------------------------------
const quests = [];
for (const folder of readdirSync(join(dir, "Quests"))) {
  for (const f of readdirSync(join(dir, "Quests", folder))) {
    const j = JSON.parse(readFileSync(join(dir, "Quests", folder, f), "utf8"));
    const p = j["properties:10"]["betterquesting:10"];
    const id = qid(j);
    const tasks = vals(j["tasks:9"]).sort((a, b) => a["index:3"] - b["index:3"]).map(t => {
      const type = t["taskID:8"].replace("bq_standard:", "");
      const task = { type };
      if (t["requiredItems:9"]) task.items = vals(t["requiredItems:9"]).map(stack);
      if (t["requiredFluids:9"]) task.fluids = vals(t["requiredFluids:9"]).map(f => ({ id: `f:${f["FluidName:8"]}`, amount: f["Amount:3"] }));
      if (t["consume:1"]) task.consume = true;
      if (t["requireOnlyOneItem:1"]) task.anyOne = true;
      if (type === "hunt") Object.assign(task, { target: t["target:8"], amount: t["required:3"] });
      if (type === "location") Object.assign(task, { name: clean(t["name:8"]), dimension: t["dimension:3"] });
      if (type === "meeting") Object.assign(task, { target: t["target:8"] });
      return task;
    });
    const rewards = vals(j["rewards:9"]).sort((a, b) => a["index:3"] - b["index:3"]).flatMap(r => {
      const type = r["rewardID:8"].replace("bq_standard:", "");
      if (type === "item") return [{ type, items: vals(r["rewards:9"]).map(stack) }];
      if (type === "choice") return [{ type, items: vals(r["choices:9"]).map(stack) }];
      if (type === "xp") return [{ type, amount: r["amount:3"], levels: !!r["isLevels:1"] }];
      if (type === "questcompletion") { const q = b64ToId(r["questID:8"]); return q ? [{ type, quest: q }] : []; }
      return [];
    });
    quests.push({
      id,
      name: clean(p["name:8"]),
      desc: clean(p["desc:8"]),
      icon: p["icon:10"] ? stack(p["icon:10"]).id : null,
      main: !!p["isMain:1"],
      visibility: p["visibility:8"],
      questLogic: p["questLogic:8"] ?? "AND",
      taskLogic: p["taskLogic:8"] ?? "AND",
      prereqs: vals(j["preRequisites:9"]).map(qid),
      lines: questLines.get(id) ?? [],
      tasks,
      rewards,
    });
  }
}

writeFileSync(OUT, JSON.stringify({ source: SOURCE, lines, quests }));
console.log(`Wrote ${OUT}: ${quests.length} quests in ${lines.length} quest lines.`);
console.log(`The quest book is ${SOURCE.license}. Keep data/ out of git and don't redistribute it.`);
