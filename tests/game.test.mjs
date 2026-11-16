// Tests for the text game engine (scripts/game.mjs, lib/game.mjs).
// Engine tests need data/recipes.json; quest tests also need data/quests.json
// (node scripts/setup-quests.mjs). They are skipped when the data is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, DATA_PATH } from "../lib/data.mjs";

const noData = !existsSync(DATA_PATH) && "no data/recipes.json (run node scripts/setup-data.mjs)";
const QUESTS = join(ROOT, "data", "quests.json");
const noQuests = noData || (!existsSync(QUESTS) && "no data/quests.json (run node scripts/setup-quests.mjs)");
const saves = mkdtempSync(join(tmpdir(), "gregllm-game-"));

function game(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "game.mjs"), ...args], { encoding: "utf8", env: { ...process.env, GREGLLM_SAVES: saves } });
  if (r.status === null || r.stderr) throw new Error(r.stderr);
  return { ok: r.status === 0, out: r.stdout };
}
const save = name => JSON.parse(readFileSync(join(saves, `${name}.json`), "utf8"));

test("world rules only name items that exist in the recipe data", { skip: noData }, async () => {
  const { world, rawOreId, oreItems, getDb } = await import("../lib/game.mjs");
  const db = getDb();
  const ids = [];
  for (const g of Object.values(world.gather)) ids.push(g.item, ...(g.bonus ?? []).map(b => b.item), ...(g.needsItem ? [g.needsItem] : []));
  for (const h of Object.values(world.hunt)) ids.push(...h.drops.map(d => d.item));
  ids.push(...Object.keys(world.boilers), ...Object.keys(world.generators), ...Object.keys(world.primitiveMachines), ...world.fuelMachines, world.craftingTable, world.toolStone);
  for (const m of Object.values(world.primitiveMachines)) ids.push(...Object.keys(m.structure));
  for (const id of ids) assert.ok(db.goods.has(id), `unknown item ${id}`);
  for (const v of world.veins) for (const mat of Object.keys(v.ores)) assert.ok(rawOreId(mat), `no Raw ${mat} Ore`);
  const specs = [world.toolStick, ...Object.keys(world.fuels), ...Object.values(world.toolMaterials).flatMap(m => Object.values(m.parts))];
  for (const s of specs) {
    if (s.startsWith("<")) assert.ok(oreItems(`o:${s.slice(1, -1)}`).length, `empty ore dict ${s}`);
    else assert.ok(db.goods.has(s), `unknown item ${s}`);
  }
});

test("a stone age start: gather, craft with real recipes, place, smelt", { skip: noData }, () => {
  assert.ok(game("new", "t1", "--seed", "1").ok);
  assert.match(game("gather", "log", "10").out, /Oak Log/);
  assert.match(game("gather", "gravel", "12").out, /Gravel/);
  // 3 gravel -> 1 flint is a real GTNH shapeless recipe
  assert.match(game("craft", "Flint", "4").out, /Crafted 4x Flint/);
  assert.match(game("craft", "Crafting Table").out, /Crafted 1x Crafting Table/);
  // shaped 3x3 recipes need a placed crafting table
  assert.match(game("craft", "Oak Planks", "12").out, /Crafted 12x Oak Planks/);
  assert.match(game("craft", "Wooden Pickaxe").out, /Missing|placed Crafting Table|Can't craft/i);
  assert.ok(game("place", "Crafting Table").ok);
  game("craft", "Stick", "4");
  assert.match(game("craft", "Wooden Pickaxe").out, /Crafted 1x Wooden Pickaxe/);
  const s = save("t1");
  assert.equal(s.tools.find(t => t.type === "pickaxe")?.material, "wood");
  assert.equal(s.base["i:minecraft:crafting_table:0"], 1);
  // furnace: real recipe is 3 flint + 6 cobblestone; smelting uses fuel from the inventory
  game("gather", "cobblestone", "8");
  game("gather", "gravel", "6");
  game("craft", "Flint", "2");
  assert.match(game("craft", "Furnace").out, /Crafted 1x Furnace/);
  assert.ok(game("place", "Furnace").ok);
  // GTNH removed sand -> glass smelting, and the engine follows the data
  game("gather", "sand", "2");
  assert.equal(game("process", "Glass", "2").ok, false);
  game("give", "Raw Chalcopyrite Ore", "2", "--reason", "test");
  const r = game("process", "Copper Ingot", "2");
  assert.match(r.out, /Furnace ran 2x/);
  assert.equal(save("t1").inv["i:gregtech:gt.metaitem.01:11035"], 2);
});

test("crafting refuses what the player can't afford", { skip: noData }, () => {
  game("new", "t2", "--seed", "2");
  const r = game("craft", "Steam Macerator");
  assert.equal(r.ok, false);
  assert.match(r.out, /Can't craft/);
  assert.equal(Object.keys(save("t2").inv).length, 0);
});

test("ore veins need the right mining level and drop raw ores", { skip: noData }, () => {
  game("new", "t3", "--seed", "3");
  for (let i = 0; i < 6; i++) game("explore");
  const s = save("t3");
  const hard = s.veins.find(v => v.level >= 2);
  game("give", "Flint", "3", "--reason", "test");
  game("give", "Stick", "2", "--reason", "test");
  assert.match(game("tool", "pickaxe flint").out, /Made a Flint Pickaxe/);
  if (hard) assert.match(game("mine", String(hard.n), "4").out, /can't mine/);
  game("give", "Iron Ingot", "3", "--reason", "test");
  game("give", "Stick", "2", "--reason", "test");
  game("tool", "pickaxe iron");
  const v = save("t3").veins[0];
  const r = game("mine", String(v.n), "8");
  assert.match(r.out, /Mined 8 ore blocks/);
  assert.ok(Object.keys(save("t3").inv).some(id => id.startsWith("i:gregtech:gt.metaitem.03:")), "raw ores in inventory");
});

test("steam and LV machines use steam and EU", { skip: noData }, () => {
  game("new", "t4", "--seed", "4");
  for (const [item, n] of [["Small Coal Boiler", 1], ["Steam Macerator", 1], ["Basic Macerator", 1], ["Basic Steam Turbine", 1], ["Coal", 10], ["Raw Chalcopyrite Ore", 6]]) game("give", item, String(n), "--reason", "test");
  game("place", "Small Coal Boiler");
  game("place", "Steam Macerator");
  let r = game("process", "Crushed Chalcopyrite Ore", "2");
  assert.equal(r.ok, false);
  assert.match(r.out, /steam/);
  assert.match(game("fuel", "boiler Coal", "2").out, /\+9600 L steam/);
  r = game("process", "Crushed Chalcopyrite Ore", "2");
  assert.match(r.out, /Steam Macerator ran 1x/);
  assert.equal(save("t4").steam, 9600 - 2 * 400 * 2);
  game("place", "Basic Macerator");
  assert.match(game("status").out, /Age: Steam Age/);
  game("place", "Basic Steam Turbine");
  assert.match(game("status").out, /Age: LV/);
  r = game("process", "Crushed Chalcopyrite Ore", "2");
  assert.match(r.out, /Basic Macerator ran 1x.*Used 800 EU/);
});

test("primitive multiblocks need their structure blocks", { skip: noData }, () => {
  game("new", "t5", "--seed", "5");
  game("give", "Coke Oven", "1", "--reason", "test");
  game("give", "Coke Oven Bricks", "10", "--reason", "test");
  assert.match(game("place", "Coke Oven").out, /needs: Coke Oven Bricks \(10\/25\)/);
  game("give", "Coke Oven Bricks", "15", "--reason", "test");
  game("give", "Coal", "2", "--reason", "test");
  assert.ok(game("place", "Coke Oven").ok);
  const r = game("process", "Coal Coke", "2");
  assert.match(r.out, /Coke Oven ran 2x.*2x Coal Coke, 1000 L Creosote Oil/);
});

test("quests: progress, claim, rewards and unlocks", { skip: noQuests }, () => {
  game("new", "t6", "--seed", "6");
  assert.match(game("quests").out, /Your First Night: · 0\/8 Dirt/);
  assert.equal(game("quest", "claim", "Your First Night").ok, false);
  game("gather", "dirt", "8");
  const r = game("quest", "claim", "Your First Night");
  assert.match(r.out, /Quest complete: Your First Night! Rewards: 1x Apple/);
  assert.match(r.out, /Sticks 'n Stones/);
  // info quests are ticked by the game master
  assert.match(game("quest", "tick", "Better Questing?", "1").out, /ready to claim/);
  // a choice reward needs --choice
  game("quest", "claim", "Better Questing?");
  game("gather", "gravel", "9");
  game("gather", "log", "7");
  game("quest", "claim", "Sticks 'n Stones");
  game("craft", "Flint", "3");
  game("quest", "claim", "Where's the Flint?");
  game("craft", "Crafting Table");
  assert.match(game("quest", "claim", "Crafting Time").out, /Quest complete/);
  game("quest", "tick", "Main Quests and Secondary Quests", "1");
  game("quest", "claim", "Main Quests and Secondary Quests");
  const tools = game("quest", "claim", "Tools");
  assert.match(tools.out, /isn't finished|--choice/);
  const s = save("t6");
  assert.equal(Object.keys(s.quests.done).length, 6);
});

test("quest tool tasks map to game tools", { skip: noQuests }, async () => {
  const { toolOfItem } = await import("../lib/game.mjs");
  assert.deepEqual(toolOfItem("i:gregtech:gt.metatool.01:12"), { type: "hammer" });
  assert.deepEqual(toolOfItem("i:gregtech:gt.metatool.01:24"), { type: "mortar" });
  assert.deepEqual(toolOfItem("i:TConstruct:pickaxe:0"), { type: "pickaxe" });
  assert.deepEqual(toolOfItem("i:TConstruct:pickaxeHead:2"), { type: "pickaxe", material: "iron", head: true });
  game("new", "t7", "--seed", "7");
  game("give", "Iron Ingot", "8", "--reason", "test");
  game("give", "Stick", "2", "--reason", "test");
  assert.match(game("tool", "hammer iron").out, /Made a Iron Hard Hammer|Made an? Iron Hard Hammer/);
  assert.match(game("quest", "Important Tools").out, /✓ 1\/1 Hard Hammer/);
});
