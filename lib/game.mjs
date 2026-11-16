// Game engine for the GTNH text game. Claude runs it as game master through scripts/game.mjs.
// Recipes come from data/recipes.json (real GTNH 2.9.0 data), quests from data/quests.json (the
// GTNH 2.9.0 quest book), and everything the data lacks (world, veins, tools, fuel, power) from
// game/world.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, load, name as itemName, resolve, search } from "./data.mjs";

export const SAVES = process.env.GREGLLM_SAVES ?? join(ROOT, "saves");
export const QUESTS_PATH = join(ROOT, "data", "quests.json");
export const world = JSON.parse(readFileSync(join(ROOT, "game", "world.json"), "utf8"));

// ---------------------------------------------------------------------------------------------
// Random numbers (seeded, stored in the save so a game replays the same way)
function rand(s) {
  s.rng = (s.rng + 0x6d2b79f5) >>> 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (s, a, b) => a + Math.floor(rand(s) * (b - a + 1));
const pickWeighted = (s, entries) => {
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rand(s) * total;
  for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
  return entries[entries.length - 1][0];
};

// ---------------------------------------------------------------------------------------------
// Game context: recipe db, quests, save
export class GameError extends Error {}
const fail = msg => { throw new GameError(msg); };

let quests = null;
export function loadQuests() {
  if (quests) return quests;
  if (!existsSync(QUESTS_PATH)) return null;
  const d = JSON.parse(readFileSync(QUESTS_PATH, "utf8"));
  const byId = new Map(d.quests.map(q => [q.id, q]));
  const lineByKey = new Map(d.lines.map(l => [l.key, l]));
  const lineById = new Map(d.lines.map(l => [l.id, l]));
  return quests = { ...d, byId, lineByKey, lineById };
}

export function newState(saveName, seed = Date.now() % 2147483647) {
  return {
    version: 1, name: saveName, seed, rng: seed >>> 0, time: 0,
    inv: {}, fluids: {}, tools: [], base: {}, steam: 0, eu: 0, furnaceBurn: 0,
    veins: [], nextVein: 1,
    quests: { done: {}, ticked: {} },
    stats: { crafted: {}, kills: {}, toolsMade: {} },
    xp: 0, log: [], gm: [],
  };
}

export const savePath = n => join(SAVES, `${n.replace(/[^\w.-]/g, "_")}.json`);
export function currentSaveName() {
  const p = join(SAVES, ".current");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : null;
}
export function loadState(n) {
  n ??= currentSaveName();
  if (!n) fail("No game yet. Start one with: node scripts/game.mjs new <name>");
  if (!existsSync(savePath(n))) fail(`No save called "${n}".`);
  return JSON.parse(readFileSync(savePath(n), "utf8"));
}
export function saveState(s) {
  mkdirSync(SAVES, { recursive: true });
  writeFileSync(savePath(s.name), JSON.stringify(s, null, 1));
  writeFileSync(join(SAVES, ".current"), s.name);
}

// ---------------------------------------------------------------------------------------------
// Items, ore dictionary and inventory
let db = null;
export const getDb = () => (db ??= load());

// A "spec" is an item id (i:mod:name:dmg, with * as any damage), a fluid id, or an ore dict
// entry written <name> or o:name.
const oreKey = spec => spec.startsWith("<") ? `o:${spec.slice(1, -1)}` : spec.startsWith("o:") ? spec : null;
// The export only lists ore dictionary entries that some recipe uses, so others (plateSteel,
// woodStick, ...) are rebuilt from GregTech naming: plateSteel -> "Steel Plate".
const PREFIX_NAMES = { plate: "Plate", ingot: "Ingot", dust: "Dust", stick: "Rod", nugget: "Nugget", gear: "Gear", screw: "Screw", ring: "Ring", foil: "Foil", block: "Block", gem: "", ore: "Ore", bolt: "Bolt", wireGt01: "Wire" };
const oreCache = new Map();
export function oreItems(ore) {
  const d = getDb();
  if (d.oreDicts.has(ore)) return d.oreDicts.get(ore).items;
  if (oreCache.has(ore)) return oreCache.get(ore);
  const key = ore.slice(2);
  let ids = [];
  const extra = world.extraOreDict?.[key];
  if (extra) ids = extra;
  else {
    const m = key.match(/^([a-z]+(?:Gt01)?)([A-Z].*)$/);
    if (m && m[1] in PREFIX_NAMES) {
      const mat = m[2].replace(/([a-z])([A-Z])/g, "$1 $2");
      const want = PREFIX_NAMES[m[1]] ? `${mat} ${PREFIX_NAMES[m[1]]}` : mat;
      ids = [...d.goods.values()].filter(g => g.name === want && g.id.startsWith("i:")).map(g => g.id);
    }
  }
  oreCache.set(ore, ids);
  return ids;
}
export function matches(spec, id) {
  const ore = oreKey(spec);
  if (ore) return oreItems(ore).includes(id);
  if (spec.endsWith(":*")) return id.startsWith(spec.slice(0, -1)) && !id.slice(spec.length - 1).includes(":");
  return spec === id;
}

export function label(id) {
  if (id.startsWith("<")) return `any ${id.slice(1, -1)}`;
  if (id.startsWith("o:ig~")) {
    const names = [...new Set((getDb().oreDicts.get(id)?.items ?? []).map(i => decode(getDb().goods.get(i)?.name ?? i)))];
    return names.length > 2 ? `${names.slice(0, 2).join(" or ")} or similar` : names.join(" or ");
  }
  if (id.startsWith("o:")) return `any ${id.slice(2)}`;
  const t = toolOfItem(id);
  if (t) return `${t.material ? cap(t.material) + " " : ""}${world.tools[t.type]?.name ?? t.type}${t.head ? " head" : ""}`;
  const g = getDb().goods.get(id) ?? getDb().goods.get(id.replace(/:\*$/, ":0"));
  if (g) return decode(g.name);
  const parts = id.split(":");
  return `${parts[2] ?? id} (${parts[1] ?? "?"}, not in the recipe data)`;
}
const cap = s => s[0].toUpperCase() + s.slice(1);

// GregTech tool items (gt.metatool.01:<n>) and Tinkers' tools/heads -> game tool types.
export function toolOfItem(id) {
  const m = id.match(/^i:gregtech:gt\.metatool\.01:(\d+)/);
  if (m) {
    const type = Object.keys(world.tools).find(k => world.tools[k].gt === Number(m[1]));
    return type ? { type } : null;
  }
  const t = id.match(/^i:TConstruct:(\w+):(\d+|\*)/);
  if (t) {
    if (world.tinkersTools[t[1]]) return { type: world.tinkersTools[t[1]] };
    if (world.tinkersHeads[t[1]]) return { type: world.tinkersHeads[t[1]], material: world.tinkersMaterials[t[2]] ?? null, head: true };
  }
  return null;
}

export function count(s, spec) {
  const vt = world.vanillaTools[spec];
  if (vt) return s.tools.filter(t => t.type === vt[0] && t.material === vt[1]).length;
  if (spec.startsWith("f:")) return world.freeFluids.includes(spec) ? Infinity : (s.fluids[spec] ?? 0);
  const tool = toolOfItem(spec);
  if (tool && !tool.head) return s.tools.filter(t => t.type === tool.type).length;
  let n = 0;
  for (const [id, c] of Object.entries(s.inv)) if (matches(spec, id)) n += c;
  return n;
}
export function add(s, id, n) {
  if (!n) return;
  const bag = id.startsWith("f:") ? s.fluids : s.inv;
  bag[id] = (bag[id] ?? 0) + n;
  if (bag[id] <= 0) delete bag[id];
}
// Removes n matching items, taking from the largest stacks first. Returns false if short.
export function take(s, spec, n) {
  if (n <= 0) return true;
  if (spec.startsWith("f:")) {
    if (world.freeFluids.includes(spec)) return true;
    if ((s.fluids[spec] ?? 0) < n) return false;
    add(s, spec, -n);
    return true;
  }
  if (count(s, spec) < n) return false;
  const stacks = Object.entries(s.inv).filter(([id]) => matches(spec, id)).sort((a, b) => b[1] - a[1]);
  for (const [id, c] of stacks) {
    const k = Math.min(c, n);
    add(s, id, -k);
    n -= k;
    if (!n) break;
  }
  return true;
}

// Resolve player text to an item id. Accepts ids, <oredict>, exact names, then fuzzy search.
export function findItem(text, { prefer } = {}) {
  const d = getDb();
  if (d.goods.has(text) || text.startsWith("<")) return text;
  const lower = text.toLowerCase();
  const exact = [...d.goods.values()].filter(g => g.name?.toLowerCase() === lower);
  if (exact.length) {
    const score = g => (prefer?.(g.id) ? 1e6 : 0) + (g.id.startsWith("i:minecraft:") ? 1e5 : 0) + (g.id.startsWith("i:gregtech:") ? 5e4 : 0)
      + (d.producers.get(g.id)?.length ?? 0) + (d.consumers.get(g.id)?.length ?? 0);
    return exact.sort((a, b) => score(b) - score(a))[0].id;
  }
  return resolve(d, text);
}

// ---------------------------------------------------------------------------------------------
// Tools
export function bestTool(s, type) {
  return s.tools.filter(t => t.type === type).sort((a, b) => b.level - a.level || b.durability - a.durability)[0] ?? null;
}
function useTool(s, type, uses, events) {
  let left = uses;
  while (left > 0) {
    const t = bestTool(s, type);
    if (!t) return false;
    const k = Math.min(left, t.durability);
    t.durability -= k;
    left -= k;
    if (t.durability <= 0) {
      s.tools.splice(s.tools.indexOf(t), 1);
      events.push(`Your ${toolLabel(t)} broke.`);
    }
  }
  return true;
}
export const toolLabel = t => `${cap(t.material)} ${world.tools[t.type]?.name ?? t.type}`;
function giveTool(s, type, material) {
  const m = world.toolMaterials[material] ?? world.toolMaterials.iron;
  const t = { type, material, level: m.level, durability: m.durability, max: m.durability };
  s.tools.push(t);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Time
export function clock(s) {
  const t = s.time + 300; // a new game starts at 06:00
  const day = Math.floor(t / 1200) + 1;
  const mins = Math.floor(((t % 1200) / 1200) * 24 * 60);
  const hh = String(Math.floor(mins / 60)).padStart(2, "0"), mm = String(mins % 60).padStart(2, "0");
  return { day, text: `Day ${day}, ${hh}:${mm}`, night: mins >= 19 * 60 || mins < 5 * 60 };
}
const fmtDur = sec => sec < 90 ? `${Math.round(sec)}s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`;
function pass(s, sec) { s.time += sec; }
function log(s, text) { s.log.push(`[${clock(s).text}] ${text}`); if (s.log.length > 60) s.log.shift(); }

// ---------------------------------------------------------------------------------------------
// Machines
const uniq = rs => [...new Map((rs ?? []).map(r => [r.id, r])).values()];
const producersOf = id => uniq(getDb().producers.get(id));
// Recycling recipes (taking a finished machine or part apart). Only arc furnace ones are flagged
// in the data, so also catch single-input recipes whose input is a machine, casing or pipe.
// Voltage tier of a recipe (0 = LV or below). Uses the EU/t, since a few recipes carry a wrong tier.
export const recipeTier = r => Math.max(r.gt?.voltageTier ?? 0, r.gt?.voltage > 32 ? Math.ceil(Math.log(r.gt.voltage / 32) / Math.log(4)) : 0);
const isRecycle = r => {
  if (r.gt?.metadata?.recycle) return true;
  const ins = r.itemIn ?? [];
  if (ins.length !== 1 || (r.fluidIn ?? []).length || (r.oreDictIn ?? []).length) return false;
  const id = ins[0].id;
  return /gt\.blockmachines|gt\.blockcasings/.test(id) || /Pipe|Casing|Hull|Firebox|Tank|Valve|Machine|Boiler/.test(getDb().goods.get(id)?.name ?? "");
};
const typeName = r => getDb().recipeTypes[r.type]?.name ?? "?";
const isCraftingType = r => /^Crafting \((Shaped|Shapeless)\)$/.test(typeName(r));
const crafters = r => getDb().recipeTypes[r.type]?.multiblocks ?? [];

// What a placed block is, for the game.
export function machineInfo(id) {
  const n = itemName(getDb(), id);
  if (world.boilers[id]) return { kind: "boiler", name: n, ...world.boilers[id] };
  if (world.generators[id]) return { kind: "generator", name: n, ...world.generators[id] };
  if (world.primitiveMachines[id]) return { kind: "primitive", name: n, ...world.primitiveMachines[id] };
  if (world.fuelMachines.includes(id)) return { kind: "fuel", name: n };
  if (id === world.craftingTable) return { kind: "table", name: n };
  for (const [prefix, cfg] of Object.entries(world.steamMachines)) {
    if (n.startsWith(prefix + " ") && id.includes("gt.blockmachines")) return { kind: "steam", name: n, prefix, ...cfg };
  }
  for (const [prefix, tier] of Object.entries(world.electricPrefixes)) {
    if (n.startsWith(prefix + " ") && id.includes("gt.blockmachines")) {
      const roman = n.match(/ (I{1,3}|IV)$/)?.[1];
      const extra = roman ? ({ I: 1, II: 1, III: 2, IV: 3 })[roman] : 0;
      return { kind: "electric", name: n, tier: tier + extra };
    }
  }
  return { kind: "other", name: n };
}
const isPlaceable = id => {
  const d = getDb();
  if (world.boilers[id] || world.generators[id] || world.primitiveMachines[id] || world.fuelMachines.includes(id) || id === world.craftingTable) return true;
  return d.recipeTypes.some(t => t.multiblocks?.includes(id));
};
const powerTier = s => Math.max(-1, ...Object.keys(s.base).filter(id => world.generators[id]).map(id => world.generators[id].tier));

export function age(s) {
  const kinds = Object.keys(s.base).map(machineInfo);
  const pt = powerTier(s);
  if (pt >= 1) return world.ages[3];
  if (pt >= 0 && kinds.some(k => k.kind === "electric")) return world.ages[2];
  if (kinds.some(k => k.kind === "steam" || k.kind === "boiler")) return world.ages[1];
  return world.ages[0];
}

// ---------------------------------------------------------------------------------------------
// Recipes: what a recipe needs, and whether the player can do it now
function inputsOf(r) {
  const items = [], tools = [], kept = [];
  for (const e of r.itemIn ?? []) {
    const tool = world.singleUseTools[e.id];
    if (tool) tools.push(tool);
    else if (e.amount === 0) { if (!e.id.startsWith("i:gregtech:gt.integrated_circuit:")) kept.push(e.id); }
    else items.push([e.id, e.amount]);
  }
  for (const e of r.oreDictIn ?? []) items.push([e.id, e.amount]);
  for (const e of r.fluidIn ?? []) items.push([e.id, e.amount]);
  // merge duplicates (shaped recipes list one entry per slot)
  const merged = new Map();
  for (const [id, a] of items) merged.set(id, (merged.get(id) ?? 0) + a);
  return { items: [...merged], tools: [...new Set(tools)], kept };
}
const outputOf = (r, id) => [...(r.itemOut ?? []), ...(r.fluidOut ?? [])].filter(e => e.id === id).reduce((a, e) => a + e.amount * (e.chance ?? 1), 0);
function needsTable(r) {
  const slots = (r.itemIn ?? []).concat(r.oreDictIn ?? []).map(e => e.slot ?? 0);
  if (slots.length > 4) return true;
  return typeName(r).includes("Shaped") && slots.some(x => ![0, 1, 3, 4].includes(x));
}

// Missing pieces for `times` runs of recipe r: [{what, have, need}]
function missingFor(s, r, times) {
  const { items, tools, kept } = inputsOf(r);
  const miss = [];
  for (const [id, a] of items) { const have = count(s, id); if (have < a * times) miss.push({ what: label(id), have, need: a * times }); }
  for (const t of tools) if (!bestTool(s, t)) miss.push({ what: `a ${world.tools[t].name} (tool)`, have: 0, need: 1 });
  for (const id of kept) if (count(s, id) < 1) miss.push({ what: `${label(id)} (not consumed)`, have: 0, need: 1 });
  return miss;
}
function consume(s, r, times, events) {
  const { items, tools } = inputsOf(r);
  for (const [id, a] of items) take(s, id, a * times) || fail(`Not enough ${label(id)}.`);
  for (const t of tools) useTool(s, t, times, events);
}
function produce(s, r, times) {
  const got = {};
  for (const e of [...(r.itemOut ?? []), ...(r.fluidOut ?? [])]) {
    let n = 0;
    if (e.chance && e.chance < 1) { for (let i = 0; i < times; i++) if (rand(s) < e.chance) n += e.amount; }
    else n = e.amount * times;
    if (!n) continue;
    const vt = world.vanillaTools[e.id];
    if (vt) { for (let i = 0; i < n; i++) giveTool(s, vt[0], vt[1]); s.stats.toolsMade[vt[0]] = (s.stats.toolsMade[vt[0]] ?? 0) + n; }
    else add(s, e.id, n);
    got[e.id] = (got[e.id] ?? 0) + n;
    s.stats.crafted[e.id] = (s.stats.crafted[e.id] ?? 0) + n;
  }
  return got;
}
const listGot = got => Object.entries(got).map(([id, n]) => `${n}${id.startsWith("f:") ? " L" : "x"} ${label(id)}`).join(", ");

// Mortar grinding (game rule; the recipe export has no mortar recipes).
function mortarRecipe(target) {
  const d = getDb();
  const tname = itemName(d, target);
  const rule = world.mortar.find(m => m.out === target || (oreKey(m.out) && matches(m.out, target)));
  if (rule) return { id: `mortar:${rule.in}`, mortar: true, itemIn: [{ id: rule.in, amount: 1 }], itemOut: [{ id: target, amount: rule.amount }] };
  const m = tname.match(/^(.*) Dust$/);
  if (!m || !target.startsWith("i:gregtech:")) return null;
  const src = [...d.goods.values()].find(g => g.id.startsWith("i:gregtech:gt.metaitem.01:") && (g.name === `${m[1]} Ingot` || g.name === m[1]));
  return src ? { id: `mortar:${src.id}`, mortar: true, itemIn: [{ id: src.id, amount: 1 }], itemOut: [{ id: target, amount: 1 }] } : null;
}

// ---------------------------------------------------------------------------------------------
// Commands. Each returns text for the game master; the CLI saves the state afterwards.
export const commands = {};

commands.new = (s, args) => {
  const st = newState(args.name, args.seed ? Number(args.seed) : undefined);
  add(st, "i:minecraft:stick:0", 0);
  log(st, "You wake up in a forest with nothing but your hands.");
  return { state: st, text: `New world "${st.name}" (seed ${st.seed}). ${clock(st).text}. You have nothing but your hands.\nQuests: ${loadQuests() ? "the GTNH 2.9.0 quest book is loaded." : "not installed (run node scripts/setup-quests.mjs)."}` };
};

commands.status = s => {
  const c = clock(s), a = age(s);
  const lines = [`${s.name}: ${c.text}${c.night ? " (night)" : ""}. Age: ${a.name}.`];
  const inv = Object.entries(s.inv).sort((x, y) => y[1] - x[1]);
  lines.push(`Inventory (${inv.length} kinds): ${inv.slice(0, 25).map(([id, n]) => `${n}x ${label(id)}`).join(", ") || "empty"}${inv.length > 25 ? ", ..." : ""}`);
  const fl = Object.entries(s.fluids);
  if (fl.length) lines.push(`Fluids: ${fl.map(([id, n]) => `${n} L ${label(id)}`).join(", ")}`);
  lines.push(`Tools: ${s.tools.map(t => `${toolLabel(t)} (${t.durability}/${t.max})`).join(", ") || "none"}`);
  const base = Object.entries(s.base);
  lines.push(`Base: ${base.map(([id, n]) => `${n}x ${label(id)}`).join(", ") || "nothing built"}`);
  if (base.some(([id]) => world.boilers[id] || world.generators[id])) lines.push(`Power: ${Math.floor(s.steam)} L steam, ${Math.floor(s.eu)} EU stored`);
  if (s.furnaceBurn > 0) lines.push(`Furnace fuel left: ${Math.floor(s.furnaceBurn)} ticks`);
  if (s.veins.length) lines.push(`Known ore veins: ${s.veins.map(v => `#${v.n} ${v.name} (${v.left} blocks left)`).join(", ")}`);
  const ready = loadQuests() ? questList(s).filter(x => x.ready).length : 0;
  if (ready) lines.push(`${ready} quest(s) ready to claim. Run: quests`);
  return { text: lines.join("\n") };
};

commands.inv = (s, args) => {
  const f = (args.rest ?? "").toLowerCase();
  const rows = Object.entries(s.inv).filter(([id]) => !f || label(id).toLowerCase().includes(f)).sort((a, b) => label(a[0]).localeCompare(label(b[0])));
  return { text: rows.map(([id, n]) => `${String(n).padStart(5)}  ${label(id)}  (${id})`).join("\n") || "Nothing matches." };
};

commands.gather = (s, args) => {
  const key = Object.keys(world.gather).find(k => k === args.rest?.toLowerCase()) ?? Object.keys(world.gather).find(k => k.startsWith(args.rest?.toLowerCase() ?? "?"));
  if (!key) fail(`Can't gather "${args.rest}". Options: ${Object.keys(world.gather).join(", ")}. For ore, use explore and mine.`);
  const g = world.gather[key], n = Math.max(1, args.n ?? 1), events = [];
  if (g.needsItem && count(s, g.needsItem) < 1) fail(`You need a ${label(g.needsItem)} for that.`);
  const tool = g.tool ? bestTool(s, g.tool) : null;
  if (g.needsTool && (!tool || tool.level < (g.minLevel ?? 0))) fail(`You need a ${world.tools[g.tool].name.toLowerCase()}${g.minLevel ? ` (mining level ${g.minLevel}+)` : ""} to gather ${key}.`);
  const secs = (g.seconds / (tool ? (g.toolSpeed ?? 2) * (1 + tool.level * 0.25) : 1)) * n;
  if (tool) useTool(s, g.tool, n, events);
  const got = {};
  const put = (id, k) => { if (!k) return; add(s, id, k); got[id] = (got[id] ?? 0) + k; };
  put(g.item, (g.amount ?? 1) * n);
  for (const b of g.bonus ?? []) { let k = 0; for (let i = 0; i < n; i++) if (rand(s) < b.chance) k++; put(b.item, k); }
  pass(s, secs);
  log(s, `Gathered ${listGot(got)}`);
  return { text: [`Gathered ${listGot(got)} in ${fmtDur(secs)}${tool ? ` with your ${toolLabel(tool)}` : " by hand"}. ${clock(s).text}.`, ...events].join("\n") };
};

commands.hunt = (s, args) => {
  const key = args.rest?.toLowerCase();
  const h = world.hunt[key] ?? fail(`Can't hunt "${args.rest}". Options: ${Object.keys(world.hunt).join(", ")}.`);
  const n = Math.max(1, args.n ?? 1), events = [];
  const sword = bestTool(s, "sword");
  if (h.danger && !sword) events.push("Fighting hostile mobs bare-handed is slow and risky. Craft a sword.");
  const secs = h.seconds * n / (sword ? 1 + sword.level * 0.5 : 0.6);
  if (sword) useTool(s, "sword", n, events);
  const got = {};
  for (let i = 0; i < n; i++) for (const d of h.drops) { const k = randInt(s, d.min, d.max); if (k) { add(s, d.item, k); got[d.item] = (got[d.item] ?? 0) + k; } }
  s.stats.kills[h.target] = (s.stats.kills[h.target] ?? 0) + n;
  pass(s, secs);
  log(s, `Hunted ${n} ${key}`);
  return { text: [`Hunted ${n} ${key} in ${fmtDur(secs)}: ${listGot(got) || "no drops"}. ${clock(s).text}.`, ...events].join("\n") };
};

commands.explore = s => {
  const v = pickWeighted(s, world.veins.map(v => [v, v.weight]));
  const size = randInt(s, v.size[0], v.size[1]);
  const vein = { n: s.nextVein++, key: v.key, name: v.name, left: size, level: v.level };
  s.veins.push(vein);
  pass(s, world.veinSearchSeconds);
  log(s, `Found ${v.name} #${vein.n}`);
  const ores = Object.keys(v.ores).join(", ");
  return { text: `After ${fmtDur(world.veinSearchSeconds)} of searching you found vein #${vein.n}: ${v.name} (${ores}), about ${size} ore blocks. Needs mining level ${v.level}. ${clock(s).text}.` };
};

export function rawOreId(material) {
  const d = getDb();
  const want = [`Raw ${material} Ore`, `${material} Ore`];
  for (const w of want) {
    const g = [...d.goods.values()].find(x => x.name === w && x.id.startsWith("i:gregtech:gt.metaitem.03:"))
      ?? [...d.goods.values()].find(x => x.name === w && /^i:gregtech:gt\.blockores\d?:\d{1,3}$/.test(x.id));
    if (g) return g.id;
  }
  return null;
}

commands.mine = (s, args) => {
  const num = Number(String(args.rest ?? "").replace("#", ""));
  const vein = s.veins.find(v => v.n === num) ?? s.veins.find(v => v.key === args.rest || v.name.toLowerCase().startsWith(String(args.rest).toLowerCase()));
  if (!vein) fail(`No known vein "${args.rest}". Known: ${s.veins.map(v => `#${v.n} ${v.name}`).join(", ") || "none, use explore"}.`);
  const pick = bestTool(s, "pickaxe");
  if (!pick) fail("You need a pickaxe to mine.");
  if (pick.level < vein.level) fail(`Your ${toolLabel(pick)} (level ${pick.level}) can't mine this vein (needs level ${vein.level}).`);
  const n = Math.min(args.n ?? 16, vein.left);
  if (n <= 0) fail("That vein is mined out.");
  const def = world.veins.find(v => v.key === vein.key);
  const events = [], got = {};
  for (let i = 0; i < n; i++) {
    const mat = pickWeighted(s, Object.entries(def.ores));
    const id = rawOreId(mat);
    if (id) { add(s, id, 1); got[id] = (got[id] ?? 0) + 1; }
  }
  const stone = Math.floor(n / 2);
  add(s, "i:minecraft:cobblestone:0", stone);
  if (stone) got["i:minecraft:cobblestone:0"] = stone;
  useTool(s, "pickaxe", n, events);
  vein.left -= n;
  const secs = n * world.mineSeconds / (1 + pick.level * 0.5);
  pass(s, secs);
  log(s, `Mined ${n} blocks from vein #${vein.n}`);
  return { text: [`Mined ${n} ore blocks from vein #${vein.n} in ${fmtDur(secs)}: ${listGot(got)}. ${vein.left} left. ${clock(s).text}.`, ...events].join("\n") };
};

// Hand crafting (crafting grid recipes from the data, plus mortar grinding).
commands.craft = (s, args) => {
  const d = getDb();
  let target, cands;
  if (args.recipe) {
    const r = d.recipesById.get(args.recipe) ?? fail(`No recipe ${args.recipe}.`);
    if (!isCraftingType(r)) fail(`${args.recipe} is a ${typeName(r)} recipe. Use process for machine recipes.`);
    cands = [r];
    target = (r.itemOut ?? [])[0]?.id;
  } else {
    target = findItem(args.rest) ?? fail(`Unknown item "${args.rest}".`);
    cands = producersOf(target).filter(isCraftingType).filter(r => !(r.itemIn ?? []).some(e => e.id === target));
    const m = mortarRecipe(target);
    if (m) cands.push(m);
  }
  if (!cands.length) fail(`${label(target)} can't be crafted by hand. Try: howto ${label(target)}`);
  const want = Math.max(1, args.n ?? 1);
  const events = [];
  const per = r => outputOf(r, target) || 1;
  const timesOf = r => Math.ceil(want / per(r));
  const check = r => {
    const miss = r.mortar ? (bestTool(s, "mortar") ? [] : [{ what: "a Mortar (tool)", have: 0, need: 1 }]).concat(missingFor(s, r, timesOf(r))) : missingFor(s, r, timesOf(r));
    if (!r.mortar && needsTable(r) && !s.base[world.craftingTable]) miss.push({ what: "a placed Crafting Table", have: 0, need: 1 });
    return miss;
  };
  const ranked = cands.map(r => ({ r, miss: check(r) })).sort((a, b) => a.miss.length - b.miss.length);
  const ok = ranked.find(x => !x.miss.length);
  if (!ok) {
    const best = ranked.slice(0, 3).map(x => `  ${x.r.id}: missing ${x.miss.map(m => `${m.what}${m.need > 1 ? ` (${m.have}/${m.need})` : ""}`).join(", ")}`);
    fail(`Can't craft ${want}x ${label(target)} yet. Closest recipes:\n${best.join("\n")}`);
  }
  const r = ok.r, times = timesOf(r);
  if (r.mortar) { take(s, r.itemIn[0].id, times) || fail("short"); useTool(s, "mortar", times, events); }
  else consume(s, r, times, events);
  const got = produce(s, r, times);
  const secs = times * (r.mortar ? 3 : 2);
  pass(s, secs);
  log(s, `Crafted ${listGot(got)}`);
  return { text: [`Crafted ${listGot(got)} (${times} craft${times > 1 ? "s" : ""}, recipe ${r.id}).`, ...events].join("\n") };
};

// Tool crafting (game recipes; GT and Tinkers' tool recipes aren't in the export).
commands.tool = (s, args) => {
  const [typeText, matText] = (args.rest ?? "").toLowerCase().split(/\s+/);
  const type = Object.keys(world.tools).find(k => k === typeText || world.tools[k].name.toLowerCase().replace(/\s/g, "") === typeText);
  if (!type) fail(`Unknown tool "${typeText}". Tools: ${Object.keys(world.tools).join(", ")}.`);
  const def = world.tools[type];
  if (!matText) {
    const rows = def.materials.map(m => `  ${m}: ${toolCost(type, m).map(([id, n]) => `${n}x ${label(id)}`).join(", ")} (level ${world.toolMaterials[m].level}, ${world.toolMaterials[m].durability} uses)`);
    return { text: `${def.name} recipes${def.needs ? ` (needs a ${def.needs.map(n => world.tools[n].name).join(", ")})` : ""}:\n${rows.join("\n")}` };
  }
  if (!def.materials.includes(matText)) fail(`A ${def.name} can be made from: ${def.materials.join(", ")}.`);
  const cost = toolCost(type, matText);
  const miss = cost.filter(([id, n]) => count(s, id) < n).map(([id, n]) => `${label(id)} (${count(s, id)}/${n})`);
  for (const t of def.needs ?? []) if (!bestTool(s, t)) miss.push(`a ${world.tools[t].name} (tool)`);
  if (miss.length) fail(`Missing for a ${matText} ${def.name}: ${miss.join(", ")}.`);
  const events = [];
  for (const [id, n] of cost) take(s, id, n);
  for (const t of def.needs ?? []) useTool(s, t, 1, events);
  const t = giveTool(s, type, matText);
  s.stats.toolsMade[type] = (s.stats.toolsMade[type] ?? 0) + 1;
  pass(s, 10);
  log(s, `Made a ${toolLabel(t)}`);
  return { text: [`Made a ${toolLabel(t)} (mining level ${t.level}, ${t.max} uses).`, ...events].join("\n") };
};
function toolCost(type, mat) {
  const def = world.tools[type], m = world.toolMaterials[mat];
  const out = [];
  for (const [part, n] of Object.entries(def.cost)) {
    const id = part === "stick" ? world.toolStick : part === "stone" ? world.toolStone : m.parts[part];
    out.push([id, n]);
  }
  return out;
}

commands.place = (s, args) => {
  const id = findItem(args.rest, { prefer: isPlaceable }) ?? fail(`Unknown item "${args.rest}".`);
  if (!isPlaceable(id)) fail(`${label(id)} isn't a machine or workstation the game knows how to place.`);
  const n = Math.max(1, args.n ?? 1);
  if (count(s, id) < n) fail(`You have ${count(s, id)}x ${label(id)}.`);
  const info = machineInfo(id);
  const struct = Object.entries(info.structure ?? {});
  const miss = struct.filter(([b, k]) => count(s, b) < k * n).map(([b, k]) => `${label(b)} (${count(s, b)}/${k * n})`);
  if (miss.length) fail(`The ${info.name} structure also needs: ${miss.join(", ")}.`);
  take(s, id, n);
  for (const [b, k] of struct) take(s, b, k * n);
  s.base[id] = (s.base[id] ?? 0) + n;
  pass(s, 20 + struct.length * 60);
  log(s, `Placed ${n}x ${info.name}`);
  const before = age(s);
  return { text: `Placed ${n}x ${info.name} (${info.kind}). Age: ${before.name}.` };
};

commands.pickup = (s, args) => {
  const id = Object.keys(s.base).find(b => b === args.rest || label(b).toLowerCase() === args.rest?.toLowerCase()) ?? fail(`Nothing called "${args.rest}" is placed.`);
  const n = Math.min(args.n ?? 1, s.base[id]);
  s.base[id] -= n;
  if (!s.base[id]) delete s.base[id];
  add(s, id, n);
  for (const [b, k] of Object.entries(machineInfo(id).structure ?? {})) add(s, b, k * n);
  return { text: `Picked up ${n}x ${label(id)}.` };
};

// Fuel a boiler (fuel -> steam) or the furnace.
commands.fuel = (s, args) => {
  const [what, ...restWords] = (args.rest ?? "").split(/\s+/);
  const itemText = restWords.join(" ");
  const fuelId = findItem(itemText) ?? fail(`Unknown fuel "${itemText}".`);
  const burn = burnTicks(fuelId) ?? fail(`${label(fuelId)} isn't a fuel.`);
  const n = Math.max(1, args.n ?? 1);
  if (count(s, fuelId) < n) fail(`You have ${count(s, fuelId)}x ${label(fuelId)}.`);
  if (what === "furnace") {
    if (!s.base["i:minecraft:furnace:0"]) fail("No furnace placed.");
    take(s, fuelId, n);
    s.furnaceBurn += burn * n;
    return { text: `Added ${n}x ${label(fuelId)}: the furnace has ${s.furnaceBurn} ticks of fuel (${Math.floor(s.furnaceBurn / world.furnaceTicks)} smelts).` };
  }
  const boilers = Object.keys(s.base).filter(id => world.boilers[id]);
  if (!boilers.length) fail("No boiler placed.");
  const b = world.boilers[boilers.sort((a, c) => world.boilers[c].steamPerBurnTick - world.boilers[a].steamPerBurnTick)[0]];
  take(s, fuelId, n);
  const steam = burn * n * b.steamPerBurnTick;
  s.steam += steam;
  log(s, `Burned ${n}x ${label(fuelId)} for ${steam} L steam`);
  return { text: `Burned ${n}x ${label(fuelId)} in the ${b.name}: +${steam} L steam (now ${Math.floor(s.steam)} L). Boilers run while you work, so this takes no extra time.` };
};
function burnTicks(id) {
  for (const [spec, t] of Object.entries(world.fuels)) if (matches(spec, id)) return t;
  return null;
}

// Run a machine recipe.
commands.process = (s, args) => {
  const d = getDb();
  let target = null, cands;
  if (args.recipe) {
    cands = [d.recipesById.get(args.recipe) ?? fail(`No recipe ${args.recipe}.`)];
    target = [...(cands[0].itemOut ?? []), ...(cands[0].fluidOut ?? [])][0]?.id;
  } else {
    target = findItem(args.rest) ?? fail(`Unknown item "${args.rest}".`);
    cands = producersOf(target).filter(r => !isCraftingType(r) && getDb().recipeTypes[r.type]?.category === "gregtech");
  }
  if (!cands.length) fail(`No machine recipe makes ${label(target)}. Try: howto ${label(target)}`);
  const want = Math.max(1, args.n ?? 1);
  const options = [];
  for (const r of cands) {
    const per = target ? outputOf(r, target) || 1 : 1;
    const times = args.recipe ? want : Math.ceil(want / per);
    const machines = Object.keys(s.base).filter(id => crafters(r).includes(id)).map(id => ({ id, ...machineInfo(id) })).filter(m => canRun(s, m, r));
    const miss = missingFor(s, r, times);
    if (!machines.length) miss.push({ what: `a machine that can run it (${typeName(r)}${r.gt?.voltage ? `, ${r.gt.voltage} EU/t` : ""})`, have: 0, need: 1 });
    options.push({ r, times, machines, miss });
  }
  options.sort((a, b) => a.miss.length - b.miss.length || (a.r.gt?.voltage ?? 0) - (b.r.gt?.voltage ?? 0));
  const rank = m => ({ electric: 4, steam: m.prefix === "High Pressure" ? 3 : 2, primitive: 1, fuel: 1 })[m.kind] ?? 0;
  for (const o of options) {
    if (args.machine) o.machines = o.machines.filter(m => m.name.toLowerCase().includes(String(args.machine).toLowerCase()));
    o.machines = o.machines.filter(m => powerCheck(s, o, m).ok).concat(o.machines.filter(m => !powerCheck(s, o, m).ok));
    o.machines.sort((a, b) => powerCheck(s, o, b).ok - powerCheck(s, o, a).ok || rank(b) - rank(a));
    if (!o.machines.length && !o.miss.some(m => m.what.startsWith("a machine"))) o.miss.push({ what: `a machine matching "${args.machine}"`, have: 0, need: 1 });
  }
  options.sort((a, b) => a.miss.length - b.miss.length || isRecycle(a.r) - isRecycle(b.r));
  const ok = options.find(o => !o.miss.length && powerCheck(s, o).ok);
  if (!ok) {
    const lines = options.slice(0, 4).map(o => {
      const pc = o.miss.length ? null : powerCheck(s, o);
      return `  ${o.r.id} [${typeName(o.r)}]: ${o.miss.length ? "missing " + o.miss.map(m => `${m.what}${m.need > 1 ? ` (${m.have}/${m.need})` : ""}`).join(", ") : pc.why}`;
    });
    fail(`Can't make ${want}x ${label(target)} with what you have. Closest options:\n${lines.join("\n")}`);
  }
  const { r, times, machines } = ok;
  const m = machines[0];
  const parallel = machines.filter(x => x.id === m.id).reduce((a, x) => a + (s.base[x.id] ?? 1), 0);
  const events = [];
  const pc = powerCheck(s, ok, m);
  consume(s, r, times, events);
  pc.pay();
  const got = produce(s, r, times);
  const secs = pc.ticks / 20 / Math.max(1, parallel);
  pass(s, secs);
  log(s, `${m.name}: ${listGot(got)}`);
  return { text: [`${m.name}${parallel > 1 ? ` x${parallel}` : ""} ran ${times}x ${r.id} [${typeName(r)}] in ${fmtDur(secs)}: ${listGot(got)}.${pc.note ? " " + pc.note : ""} ${clock(s).text}.`, ...events].join("\n") };
};

function canRun(s, m, r) {
  const v = r.gt?.voltage ?? 0, tier = recipeTier(r);
  if (m.kind === "primitive" || m.kind === "fuel") return v === 0;
  if (m.kind === "steam") return tier <= m.maxTier && v <= 32;
  if (m.kind === "electric") return tier <= m.tier && powerTier(s) >= m.tier;
  return false;
}
// Works out time and energy for running option o on machine m (or the best one).
function powerCheck(s, o, m = o.machines[0]) {
  const r = o.r, t = o.times;
  const base = r.gt?.durationTicks ?? world.furnaceTicks;
  if (m.kind === "fuel") {
    const need = world.furnaceTicks * t;
    const avail = s.furnaceBurn + Object.entries(s.inv).reduce((a, [id, n]) => a + (burnTicks(id) ?? 0) * n, 0);
    return {
      ok: avail >= need, why: `needs ${need} ticks of furnace fuel (have ${avail})`, ticks: need,
      pay: () => {
        let left = need - Math.min(need, s.furnaceBurn);
        s.furnaceBurn -= need - left;
        const fuels = Object.entries(s.inv).filter(([id]) => burnTicks(id)).sort((a, b) => burnTicks(b[0]) - burnTicks(a[0]));
        for (const [id] of fuels) {
          while (left > 0 && (s.inv[id] ?? 0) > 0) { add(s, id, -1); const b = burnTicks(id); s.furnaceBurn += b - Math.min(b, left); left -= Math.min(b, left); }
        }
      },
      note: "",
    };
  }
  if (m.kind === "primitive") return { ok: true, ticks: base * t, pay: () => {}, note: "" };
  if (m.kind === "steam") {
    const steam = (r.gt?.voltage ?? 0) * (r.gt?.amperage ?? 1) * base * t * m.steamPerEU;
    return { ok: s.steam >= steam, why: `needs ${steam} L steam (have ${Math.floor(s.steam)} L). Fuel a boiler.`, ticks: base * t * m.durationMult, pay: () => { s.steam -= steam; }, note: `Used ${steam} L steam.` };
  }
  if (m.kind === "electric") {
    const eu = (r.gt?.voltage ?? 0) * (r.gt?.amperage ?? 1) * base * t;
    const gens = Object.keys(s.base).filter(id => world.generators[id] && world.generators[id].tier >= m.tier);
    const spe = gens.length ? Math.min(...gens.map(id => world.generators[id].steamPerEU)) : Infinity;
    const fromSteam = Math.floor(s.steam / spe);
    return {
      ok: s.eu + fromSteam >= eu, why: `needs ${eu} EU (have ${Math.floor(s.eu)} EU + ${fromSteam} EU from steam). Fuel a boiler.`, ticks: base * t,
      pay: () => { const short = Math.max(0, eu - s.eu); s.eu = Math.max(0, s.eu - eu); s.steam -= short * spe; },
      note: `Used ${eu} EU.`,
    };
  }
  return { ok: false, why: "unsupported machine", ticks: 0, pay: () => {} };
}

// How "basic" a recipe's inputs are: 0 per raw-ish input (dusts, ingots, ores, world blocks),
// 1 per crafted part. Used to list sensible recipes before salvage ones.
const PLAIN = /(Dust|Ingot|Ore|Gem|Nugget|Log|Planks|Cobblestone|Sand|Gravel|Clay|Coal|Coke|Resin|Water)$|^(Coal|Charcoal|Flint|Redstone|Diamond|Emerald|Clay|Wheat|String|Leather|Stone|Glass|Lapis Lazuli)$/;
const plainness = r => [...(r.itemIn ?? []).filter(e => e.amount > 0), ...(r.oreDictIn ?? [])].reduce((a, e) => a + (e.id.startsWith("o:") ? (/^o:(dust|ingot|ore|gem|log|plank|stone|sand)/.test(e.id) ? 0 : 1) : PLAIN.test(getDb().goods.get(e.id)?.name ?? "") ? 0 : 1), 0);
const sig = r => `${r.type}|${[...(r.itemIn ?? []), ...(r.oreDictIn ?? []), ...(r.fluidIn ?? [])].map(e => label(e.id) + e.amount).sort().join(",")}`;

// Ways to get an item, marked with what the player can do now.
commands.howto = (s, args) => {
  const d = getDb();
  const id = findItem(args.rest) ?? fail(`Unknown item "${args.rest}".`);
  const lines = [`${label(id)} (${id}). You have ${count(s, id)}.`];
  const gat = Object.entries(world.gather).filter(([, g]) => g.item === id || g.bonus?.some(b => b.item === id)).map(([k]) => k);
  if (gat.length) lines.push(`Gather: ${gat.join(", ")}`);
  const hunts = Object.entries(world.hunt).filter(([, h]) => h.drops.some(x => x.item === id)).map(([k]) => k);
  if (hunts.length) lines.push(`Hunt: ${hunts.join(", ")}`);
  const veins = world.veins.filter(v => Object.keys(v.ores).some(m => rawOreId(m) === id)).map(v => v.name);
  if (veins.length) lines.push(`Mine: ${veins.join(", ")} (explore to find one)`);
  const rs = producersOf(id).filter(r => !(r.itemIn ?? []).some(e => e.id === id) && d.recipeTypes[r.type]?.category !== "thaumcraft");
  const hand = rs.filter(isCraftingType);
  const m = mortarRecipe(id);
  if (m) lines.push(`Mortar: 1x ${label(m.itemIn[0].id)} -> ${m.itemOut[0].amount}x`);
  const show = (r, ready) => {
    const { items, tools, kept } = inputsOf(r);
    const ins = items.map(([i, a]) => `${a}${i.startsWith("f:") ? " L" : "x"} ${label(i)}`).concat(tools.map(t => `[${world.tools[t].name}]`), kept.map(k => `[keeps ${label(k)}]`));
    const gt = r.gt ? ` ${r.gt.voltage} EU/t, ${r.gt.durationTicks / 20}s` : "";
    return `  ${ready ? "✓" : "·"} ${r.id} [${typeName(r)}${gt}] ${ins.join(", ")} -> ${+outputOf(r, id).toFixed(2)}x`;
  };
  if (hand.length) {
    lines.push("Hand crafting:");
    for (const r of hand.slice(0, 6)) lines.push(show(r, !missingFor(s, r, 1).length));
    if (hand.length > 6) lines.push(`  ... ${hand.length - 6} more`);
  }
  const runnable = r => Object.keys(s.base).some(b => crafters(r).includes(b) && canRun(s, machineInfo(b), r));
  const mach = rs.filter(r => !isCraftingType(r) && d.recipeTypes[r.type]?.category === "gregtech" && !isRecycle(r))
    .sort((a, b) => runnable(b) - runnable(a) || recipeTier(a) - recipeTier(b) || plainness(a) - plainness(b) || (a.gt?.voltage ?? 0) - (b.gt?.voltage ?? 0));
  for (let i = 0, seen2 = new Set(); i < mach.length; i++) { const k = sig(mach[i]); if (seen2.has(k)) { mach.splice(i--, 1); } else seen2.add(k); }
  if (mach.length) {
    lines.push("Machines (lowest power first):");
    const pickList = [...mach.filter(runnable).slice(0, 4), ...mach.filter(r => !runnable(r)).slice(0, 6)];
    for (const r of pickList) {
      const have = Object.keys(s.base).some(b => crafters(r).includes(b) && canRun(s, machineInfo(b), r));
      const firstMachine = crafters(r).map(machineInfo).find(x => ["steam", "electric", "primitive", "fuel"].includes(x.kind))?.name ?? itemName(d, crafters(r)[0] ?? "?");
      lines.push(show(r, have && !missingFor(s, r, 1).length) + `  (e.g. ${firstMachine}${have ? ", you have one" : ""})`);
    }
    if (mach.length > pickList.length) lines.push(`  ... ${mach.length - pickList.length} more (node scripts/lookup.mjs recipes "${label(id)}")`);
  }
  const tool = Object.keys(world.tools).find(k => world.tools[k].name.toLowerCase() === label(id).toLowerCase());
  if (tool) lines.push(`Tool: node scripts/game.mjs tool ${tool}`);
  if (lines.length === 1) lines.push("No known way to get it in this game.");
  return { text: lines.join("\n") };
};

// ---------------------------------------------------------------------------------------------
// Quests
const isDone = (s, id) => !!s.quests.done[id];
export function unlocked(s, q) {
  const pre = q.prereqs.filter(p => loadQuests().byId.has(p));
  if (!pre.length) return true;
  return q.questLogic === "OR" ? pre.some(p => isDone(s, p)) : pre.every(p => isDone(s, p));
}
function craftedCount(s, spec) {
  const tool = toolOfItem(spec.id);
  if (tool && !tool.head) return s.stats.toolsMade[tool.type] ?? 0;
  const key = itemSpec(spec);
  let n = 0;
  for (const [id, c] of Object.entries(s.stats.crafted)) if (matches(key, id)) n += c;
  return n;
}
const itemSpec = it => it.ore && oreItems(`o:${it.ore}`).length ? `<${it.ore}>` : it.id;
export function taskProgress(s, q, i) {
  const t = q.tasks[i];
  const ticked = (s.quests.ticked[q.id] ?? []).includes(i);
  if (ticked) return { done: true, text: "done" };
  switch (t.type) {
    case "retrieval": case "optional_retrieval": case "crafting": {
      const rows = t.items.map(it => {
        const have = t.type === "crafting" ? craftedCount(s, it) : count(s, itemSpec(it));
        return { it, have, ok: have >= it.count };
      });
      const done = t.anyOne ? rows.some(r => r.ok) : rows.every(r => r.ok);
      return { done, text: rows.map(r => `${r.ok ? "✓" : "·"} ${Math.min(r.have, r.it.count)}/${r.it.count} ${label(itemSpec(r.it))}`).join(", ") };
    }
    case "fluid": {
      const rows = t.fluids.map(f => ({ f, have: count(s, f.id) }));
      return { done: rows.every(r => r.have >= r.f.amount), text: rows.map(r => `${Math.min(r.have, r.f.amount)}/${r.f.amount} L ${label(r.f.id)}`).join(", ") };
    }
    case "hunt": {
      const have = s.stats.kills[t.target] ?? 0;
      return { done: have >= t.amount, text: `${Math.min(have, t.amount)}/${t.amount} ${t.target} killed` };
    }
    case "checkbox": return { done: false, text: "read it, then tick it" };
    case "location": return { done: false, text: `reach ${t.name || "a place"} (game master ticks it)` };
    default: return { done: false, text: `${t.type} (game master ticks it)` };
  }
}
const isOptional = t => t.type === "optional_retrieval";
export function questReady(s, q) {
  const req = q.tasks.map((t, i) => [t, i]).filter(([t]) => !isOptional(t));
  const list = req.length ? req : q.tasks.map((t, i) => [t, i]);
  if (!list.length) return true;
  const res = list.map(([, i]) => taskProgress(s, q, i).done);
  return q.taskLogic === "OR" ? res.some(Boolean) : res.every(Boolean);
}
export function questList(s, { lines = world.starterQuestLines, all = false } = {}) {
  const Q = loadQuests();
  const out = [];
  for (const key of lines) {
    const line = Q.lineByKey.get(key);
    if (!line) continue;
    for (const id of line.quests) {
      const q = Q.byId.get(id);
      if (!q || isDone(s, id)) continue;
      if (!all && !unlocked(s, q)) continue;
      out.push({ q, line, ready: unlocked(s, q) && questReady(s, q), unlocked: unlocked(s, q) });
    }
  }
  return out;
}
function findQuest(text) {
  const Q = loadQuests() ?? fail("Quests aren't installed. Run: node scripts/setup-quests.mjs");
  if (Q.byId.has(text)) return Q.byId.get(text);
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const t = norm(text);
  const all = Q.quests.filter(q => norm(q.name) === t);
  const inStarter = q => q.lines.some(l => world.starterQuestLines.includes(Q.lineById.get(l.line)?.key));
  return all.find(inStarter) ?? all[0] ?? Q.quests.filter(q => norm(q.name).includes(t)).sort((a, b) => inStarter(b) - inStarter(a))[0] ?? fail(`No quest matches "${text}".`);
}

commands.quests = (s, args) => {
  const Q = loadQuests() ?? fail("Quests aren't installed. Run: node scripts/setup-quests.mjs");
  const lines = args.line ? [Q.lines.find(l => l.key.toLowerCase() === args.line.toLowerCase() || l.name.toLowerCase().includes(args.line.toLowerCase()))?.key ?? fail(`No quest line "${args.line}". Lines: ${Q.lines.map(l => l.key).join(", ")}`)] : world.starterQuestLines;
  const rows = questList(s, { lines });
  const out = [];
  for (const key of lines) {
    const line = Q.lineByKey.get(key);
    const total = line.quests.length, done = line.quests.filter(id => isDone(s, id)).length;
    const mine = rows.filter(r => r.line.key === key);
    out.push(`${line.name}: ${done}/${total} done${mine.length ? "" : (done === total ? "" : " (nothing open yet)")}`);
    mine.sort((a, b) => b.ready - a.ready || b.q.main - a.q.main);
    for (const r of mine.slice(0, args.all ? 999 : 12)) {
      const prog = r.q.tasks.map((t, i) => taskProgress(s, r.q, i)).filter((p, i) => !isOptional(r.q.tasks[i]));
      const short = prog.map(p => p.text).join("; ");
      out.push(`  ${r.ready ? "[READY]" : r.q.main ? "  ★    " : "       "} ${r.q.name}: ${short.length > 110 ? short.slice(0, 107) + "..." : short}`);
    }
    if (mine.length > 12 && !args.all) out.push(`  ... ${mine.length - 12} more (--all)`);
  }
  return { text: out.join("\n") };
};

commands.quest = (s, args) => {
  const words = (args.rest ?? "").split(/\s+/);
  const sub = words[0];
  if (sub === "claim") return claim(s, words.slice(1).join(" "), args);
  if (sub === "tick") return tick(s, words.slice(1).join(" "), args);
  const q = findQuest(args.rest ?? "");
  const Q = loadQuests();
  const lines = [`${q.name}${q.main ? " (main quest)" : ""}  [${q.lines.map(l => Q.lineById.get(l.line)?.name).join(", ")}]`];
  lines.push(isDone(s, q.id) ? "Status: done" : unlocked(s, q) ? (questReady(s, q) ? "Status: READY to claim" : "Status: open") : `Status: locked. Needs ${q.questLogic === "OR" ? "one of" : ""}: ${q.prereqs.map(p => Q.byId.get(p)).filter(Boolean).map(p => `${p.name}${isDone(s, p.id) ? " ✓" : ""}`).join(", ")}`);
  lines.push("", q.desc, "");
  lines.push(`Tasks (${q.taskLogic === "OR" ? "any one" : "all"}):`);
  q.tasks.forEach((t, i) => { const p = taskProgress(s, q, i); lines.push(`  ${i + 1}. ${p.done ? "✓" : "·"} ${t.type}${t.consume ? " (consumed)" : ""}: ${p.text}`); });
  if (q.rewards.length) {
    lines.push("Rewards:");
    for (const r of q.rewards) {
      if (r.type === "item") lines.push(`  ${r.items.map(i => `${i.count}x ${label(itemSpec(i))}`).join(", ")}`);
      if (r.type === "choice") lines.push(`  choose one: ${r.items.map((i, k) => `(${k + 1}) ${i.count}x ${label(itemSpec(i))}`).join(", ")}`);
      if (r.type === "xp") lines.push(`  ${r.amount} ${r.levels ? "levels" : "XP"}`);
    }
  }
  return { text: lines.join("\n") };
};

function tick(s, text, args) {
  const m = text.match(/^(.*?)\s+(\d+)$/) ?? (args.n ? [null, text, String(args.n)] : fail("Usage: quest tick <quest> <task number>"));
  const q = findQuest(m[1]);
  const i = Number(m[2]) - 1;
  if (!q.tasks[i]) fail(`${q.name} has ${q.tasks.length} task(s).`);
  if (["retrieval", "crafting", "fluid", "hunt"].includes(q.tasks[i].type) && !args.force) fail(`Task ${i + 1} is a ${q.tasks[i].type} task; the game checks it. Use --force only for things the game can't model, and say why with --reason.`);
  (s.quests.ticked[q.id] ??= []).push(i);
  if (args.force) s.gm.push({ time: s.time, what: `ticked ${q.name} task ${i + 1}`, reason: args.reason ?? "" });
  return { text: `Ticked task ${i + 1} of ${q.name}.${questReady(s, q) ? " It's ready to claim." : ""}` };
}

function claim(s, text, args) {
  const q = findQuest(text);
  if (isDone(s, q.id)) fail(`${q.name} is already done.`);
  if (!unlocked(s, q)) fail(`${q.name} is still locked.`);
  if (!questReady(s, q)) fail(`${q.name} isn't finished yet. Run: quest ${q.name}`);
  const choiceR = q.rewards.find(r => r.type === "choice");
  if (choiceR && !args.choice) fail(`Pick a reward with --choice N: ${choiceR.items.map((i, k) => `(${k + 1}) ${i.count}x ${label(itemSpec(i))}`).join(", ")}`);
  q.tasks.forEach((t, i) => {
    if (t.consume && t.items && !(s.quests.ticked[q.id] ?? []).includes(i)) for (const it of t.items) take(s, itemSpec(it), it.count);
    if (t.consume && t.fluids) for (const f of t.fluids) take(s, f.id, f.amount);
  });
  s.quests.done[q.id] = s.time;
  const got = [];
  for (const r of q.rewards) {
    const items = r.type === "item" ? r.items : r.type === "choice" ? [r.items[Number(args.choice) - 1] ?? fail("Bad --choice.")] : [];
    for (const it of items) got.push(giveReward(s, it));
    if (r.type === "xp") { s.xp += r.amount; got.push(`${r.amount} ${r.levels ? "levels" : "XP"}`); }
    if (r.type === "questcompletion" && !isDone(s, r.quest)) { s.quests.done[r.quest] = s.time; got.push(`quest "${loadQuests().byId.get(r.quest)?.name}" completed`); }
  }
  log(s, `Quest done: ${q.name}`);
  const Q = loadQuests();
  const inStarter = x => x.lines.some(l => world.starterQuestLines.includes(Q.lineById.get(l.line)?.key));
  const next = Q.quests.filter(x => !isDone(s, x.id) && x.prereqs.includes(q.id) && unlocked(s, x)).sort((a, b) => inStarter(b) - inStarter(a) || b.main - a.main);
  const names = next.slice(0, 8).map(x => `${x.name}${x.main ? " (main)" : ""}`);
  return { text: `Quest complete: ${q.name}! Rewards: ${got.join(", ") || "none"}.${next.length ? `\nNew quests: ${names.join(", ")}${next.length > 8 ? `, and ${next.length - 8} more` : ""}` : ""}` };
}
function giveReward(s, it) {
  const tool = toolOfItem(it.id);
  if (tool?.head && tool.material) {
    const cur = bestTool(s, tool.type);
    const t = cur ?? giveTool(s, tool.type, tool.material);
    const m = world.toolMaterials[tool.material];
    Object.assign(t, { material: tool.material, level: m.level, durability: m.durability, max: m.durability });
    return `${cap(tool.material)} ${world.tools[tool.type].name} head (fitted to your ${world.tools[tool.type].name.toLowerCase()})`;
  }
  if (tool && !tool.head) { giveTool(s, tool.type, "iron"); return `Iron ${world.tools[tool.type].name}`; }
  const id = it.ore ? (oreItems(`o:${it.ore}`)[0] ?? it.id) : it.id.replace(/:\*$/, ":0");
  add(s, id, it.count);
  return `${it.count}x ${label(id)}`;
}

// ---------------------------------------------------------------------------------------------
// Game master tools (logged in the save so it's clear what wasn't earned)
commands.give = (s, args) => {
  const id = findItem(args.rest) ?? fail(`Unknown item "${args.rest}".`);
  const n = args.n ?? 1;
  add(s, id, n);
  s.gm.push({ time: s.time, what: `give ${n}x ${label(id)}`, reason: args.reason ?? "" });
  return { text: `GM: gave ${n}x ${label(id)}${args.reason ? ` (${args.reason})` : ""}.` };
};
commands.take = (s, args) => {
  const id = findItem(args.rest) ?? fail(`Unknown item "${args.rest}".`);
  const n = args.n ?? 1;
  take(s, id, n) || fail(`Player only has ${count(s, id)}x ${label(id)}.`);
  s.gm.push({ time: s.time, what: `take ${n}x ${label(id)}`, reason: args.reason ?? "" });
  return { text: `GM: took ${n}x ${label(id)}${args.reason ? ` (${args.reason})` : ""}.` };
};
commands.wait = (s, args) => {
  const mins = args.n ?? Number(args.rest) ?? 10;
  pass(s, mins * 60);
  return { text: `Time passes: ${mins} min. ${clock(s).text}.` };
};
commands.log = s => ({ text: [...s.log.slice(-20), ...(s.gm.length ? ["GM actions:", ...s.gm.slice(-10).map(g => `  ${g.what}${g.reason ? ` (${g.reason})` : ""}`)] : [])].join("\n") || "Nothing yet." });
commands.find = (s, args) => ({ text: search(getDb(), args.rest ?? "", 15).map(g => `${g.name}  (${g.id})  you have ${count(s, g.id)}`).join("\n") || "No matches." });

export const MUTATING = new Set(["new", "gather", "hunt", "explore", "mine", "craft", "tool", "place", "pickup", "fuel", "process", "quest", "give", "take", "wait"]);
const decode = n => String(n).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
