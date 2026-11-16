#!/usr/bin/env node
// GTNH text game: one command per call, state saved in saves/<name>.json.
// Claude is the game master: see .claude/skills/gregtech-game/SKILL.md.
//
//   node scripts/game.mjs <command> [words...] [N] [--save name] [--recipe id] [--choice N] ...
import { commands, loadState, saveState, MUTATING, GameError } from "../lib/game.mjs";

const HELP = `Commands:
  new <name> [--seed N]          start a new world
  status | inv [text] | log      look at the player
  gather <thing> [N]             dirt, gravel, sand, clay, log, cobblestone, sugar cane, cactus, sticky resin
  hunt <animal> [N]              cow, sheep, pig, chicken, spider, zombie, skeleton, creeper
  explore                        search for an ore vein (10 min)
  mine <vein#> [N]               mine N ore blocks (default 16)
  craft <item> [N] [--recipe id] hand crafting (N = items wanted), incl. mortar grinding
  tool <type> [material]         list or make a tool (pickaxe, axe, hammer, file, wrench, saw, mortar, ...)
  place <machine> [N]            build a machine, boiler, furnace or crafting table
  pickup <machine> [N]
  fuel <boiler|furnace> <item> [N]
  process <item> [N] [--recipe id]   run a machine recipe
  howto <item>                   every way to get an item, marked with what you can do now
  find <text>                    search item names
  quests [--line key] [--all]    open quests in the starter lines
  quest <name>                   one quest in full
  quest claim <name> [--choice N]
  quest tick <name> <task#> [--force --reason "..."]
  give|take <item> [N] --reason "..."   game master only, logged
  wait <minutes>`;

const argv = process.argv.slice(2);
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) flags[k] = true; else { flags[k] = v; i++; }
  } else pos.push(a);
}
const cmd = pos.shift();
if (!cmd || cmd === "help" || !commands[cmd]) { console.log(HELP); process.exit(cmd && cmd !== "help" ? 1 : 0); }
const args = { ...flags };
if (pos.length > 1 && /^\d+$/.test(pos[pos.length - 1]) && cmd !== "mine" || (cmd === "mine" && pos.length > 1)) args.n = Number(pos.pop());
args.rest = pos.join(" ");
if (cmd === "new") args.name = args.rest || "world";

try {
  const state = cmd === "new" ? null : loadState(flags.save);
  const out = commands[cmd](state, args);
  const s = out.state ?? state;
  if (MUTATING.has(cmd)) saveState(s);
  console.log(out.text);
} catch (e) {
  if (e instanceof GameError) { console.log(e.message); process.exit(1); }
  throw e;
}
