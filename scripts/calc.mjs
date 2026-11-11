// Expand a plan (what you want to build) into raw materials, machine steps and EU.
// Usage:
//   node scripts/calc.mjs <plan.json> [--auto] [--tier LV] [--json]
//   node scripts/calc.mjs --item "Electric Blast Furnace" --amount 4 [--raw "Steel Ingot,Tin Ingot"] [--auto] [--tier LV] [--json]
//
// Plan file (see plans/example.json):
//   targets: [{ item, amount }]        item = display name or id
//   raw:     [item, ...]               stop expanding here and count as raw materials
//   choices: { item: recipeId }        which recipe makes an item (pick with lookup.mjs recipes)
//   oreDict: { "o:circuitBasic": item } which item fills an ore dictionary input
//   stopAt:  ["ingot", "dust", ...]    ore dictionary prefixes that count as raw. Replaces the default
//                                      list below (it does not add to it); use [] to expand down to ores
//   maxTier: "LV" | "MV" | ...         the player's voltage tier (or --tier). Recipes above it are
//                                      reported under warnings; --auto avoids them when it can
//   rawFluids: [fluid, ...]            extra fluids to count as raw (base gases and Molten metals already are)
//   maxDepth: number                   safety limit, default 30
//
// --auto ranks recipes by their whole chain down to raw materials: the highest voltage tier needed
// anywhere first, then the number of steps, then hand crafting before machines.
//
// Without --auto, any item with several recipes and no choice is left unexpanded and listed under
// "needsChoice" with its candidate recipes. With --auto the calculator picks one itself and lists it
// under "autoChoices" so it can be reviewed and pinned in the plan.
import { readFileSync } from "node:fs";
import { load, resolve, name, label, machineName, outputAmount, tierName, tierIndex } from "../lib/data.mjs";

const args = process.argv.slice(2);
const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const auto = flag("--auto"), asJson = flag("--json");
const cliItem = opt("--item"), cliAmount = Number(opt("--amount") ?? 1), cliRaw = opt("--raw"), cliTier = opt("--tier");
let plan;
if (cliItem) plan = { targets: [{ item: cliItem, amount: cliAmount }], raw: cliRaw ? cliRaw.split(",").map(s => s.trim()) : [] };
else if (args[0]) plan = JSON.parse(readFileSync(args[0], "utf8"));
else { console.log("Usage: node scripts/calc.mjs <plan.json> | --item <name> --amount N  [--auto] [--tier LV] [--json]"); process.exit(1); }
if (cliTier) plan.maxTier = cliTier;

const db = load();
const errors = [];
const res = t => { const id = resolve(db, t); if (!id) errors.push(`Unknown item: ${t}`); return id; };
const raw = new Set((plan.raw ?? []).map(res).filter(Boolean));
const choices = new Map(Object.entries(plan.choices ?? {}).map(([k, v]) => [res(k), v]));
const oreChoice = new Map(Object.entries(plan.oreDict ?? {}).map(([k, v]) => [k, res(v)]));
const maxDepth = plan.maxDepth ?? 30;
const maxTier = plan.maxTier == null ? null : tierIndex(plan.maxTier);
if (plan.maxTier != null && maxTier === null) errors.push(`Unknown maxTier: ${plan.maxTier} (use LV, MV, HV, EV, IV, ...)`);
const stopAt = plan.stopAt ?? ["ingot", "gem", "dust", "ore", "log", "cropCotton", "slimeball"];
const BASE_FLUIDS = /^(Water|Distilled Water|Steam|Oxygen|Nitrogen|Hydrogen|Chlorine|Fluorine|Helium|Argon|Air|Lava|Oil|Light Oil|Heavy Oil|Raw Oil|Natural Gas|Creosote Oil|Seed Oil|Lubricant|Concrete|Molten .*|Liquid Air)$/;
for (const f of plan.rawFluids ?? []) { const id = res(f); if (id) raw.add(id); }

// Not consumed in a normal build: GregTech single use tools (players use durable tools) and Thaumcraft aspect markers.
const notConsumed = id => id.startsWith("i:ggfab:gt.ggfab.d1:") || id.startsWith("i:aspectrecipeindex:") || id.startsWith("i:gregtech:gt.metatool");
// Blocks you dig up in the world. Counted as raw so the calculator doesn't route them through
// cobblestone generators or compressed blocks.
const WORLD_BLOCKS = /^(Cobblestone|Stone|Sand|Red Sand|Gravel|Dirt|Clay|Netherrack|End Stone|Obsidian|Soul Sand|Snow|Ice)$/;
// Gathered in the world without a recipe the data knows about (Sticky Resin comes from a treetap).
const GATHERED = /^(Sticky Resin)$/;
function isRaw(id) {
  if (raw.has(id)) return true;
  const g = db.goods.get(id);
  if (g?.mod === "minecraft" && WORLD_BLOCKS.test(g.name)) return true;
  if (g?.name && GATHERED.test(g.name)) return true;
  if (g?.kind === "fluid") return BASE_FLUIDS.test(g.name);
  // The data only lists ore dictionary names that some recipe uses, so also match by name.
  if (stopAt.includes("ore") && g?.name && /^(?!Crushed|Purified|Centrifuged|Impure).* Ore$/.test(g.name)) return true;
  if (stopAt.includes("ingot") && g?.name && /^(?!Hot ).* Ingot$/.test(g.name)) return true;
  if (stopAt.includes("dust") && g?.name && /^(?!Small Pile|Tiny Pile|Impure|Purified).* Dust$/.test(g.name)) return true;
  if (stopAt.includes("gem") && g?.name && /^(Diamond|Emerald|Ruby|Sapphire|Lapis Lazuli|Nether Quartz|Certus Quartz|Coal|Charcoal|Flint)$/.test(g.name)) return true;
  if (stopAt.includes("log") && g?.name && / (Log|Wood)$/.test(g.name)) return true;
  const ods = db.oreOf.get(id) ?? [];
  return ods.some(o => stopAt.some(p => o.startsWith(p) && /^[A-Z]/.test(o.slice(p.length, p.length + 1))));
}

// Recipe types that run backwards (recycling, scanning) and would loop forever.
const AUTO_SKIP = /^(Item aspects|Canner|Fusion Reactor|Extreme Heat Exchanger|Heliothermal|Plasma|Fluid Canner|Arc Furnace|Macerator|Fluid Extractor|Extractor|Packager|Unpackager|Disassembler|Pulverizer|Recycler|Forge Hammer|Scanner|Replicator|Mass Fabrication)/i;

const candCache = new Map();
function candidates(id) {
  let c = candCache.get(id);
  if (!c) candCache.set(id, c = (db.producers.get(id) ?? []).filter(r => outputAmount(r, id) > 0));
  return c;
}

const tierOf = r => r.gt?.voltageTier ?? 0;

// The goods a recipe actually consumes, with ore dictionary inputs resolved, without duplicates.
const inputsCache = new Map();
function inputsOf(r) {
  let ids = inputsCache.get(r.id);
  if (ids) return ids;
  const set = new Set();
  for (const e of [...(r.itemIn ?? []), ...(r.fluidIn ?? [])]) if (e.amount > 0 && !notConsumed(e.id)) set.add(e.id);
  for (const e of r.oreDictIn ?? []) { const it = pickOre(e.id); if (it) set.add(it); }
  inputsCache.set(r.id, ids = [...set]);
  return ids;
}

// Whether need() may use recipe r to make id: the pinned choice if there is one, the only recipe
// if there is just one, otherwise anything that isn't a recycling/backwards recipe type.
function allowed(r, id) {
  if (choices.has(id)) return r.id === choices.get(id);
  return candidates(id).length === 1 || !AUTO_SKIP.test(machineName(db, r));
}

// --- Chain cost: how hard an item is to make, all the way down to raw materials. ---
// Each recipe step costs 1, plus TIER_WEIGHT per voltage tier above LV (so one MV step weighs as much
// as 20 LV steps), plus a large penalty above the player's maxTier. Byproduct recipes and machine
// (non hand-crafting) recipes cost a little extra. An item's cost is its cheapest recipe's step cost
// plus the cost of each distinct input. All item costs are computed once, bottom up, with Knuth's
// generalization of Dijkstra's algorithm: since every step adds cost, a route that loops back to
// itself can never be the cheapest, so the cheapest chains never loop.
// NO_RECIPE is high so a chain that ends in an odd, unobtainable item (salvage recipes that take
// apart some mod's item) loses to a normal one.
const TIER_WEIGHT = 20, OVER_TIER = 1000, NO_RECIPE = 50;
function stepCost(r, id) {
  const t = tierOf(r);
  const outs = [...(r.itemOut ?? []), ...(r.fluidOut ?? [])];
  return 1 + t * TIER_WEIGHT + (maxTier !== null && t > maxTier ? OVER_TIER : 0)
    + (outs[0]?.id === id ? 0 : 2)
    + (/^Crafting/.test(machineName(db, r)) ? 0 : 0.25)
    + inputsOf(r).length * 0.01;
}

let costs = null;
function chainCosts() {
  if (costs) return costs;
  costs = new Map();
  const done = new Set(), heap = [];
  const hpush = x => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= x[0]) break; heap[i] = heap[p]; i = p; } heap[i] = x; };
  const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= last[0]) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return top; };
  const offer = (id, c) => { if (!done.has(id) && c < (costs.get(id) ?? Infinity)) { costs.set(id, c); hpush([c, id]); } };
  // Leaves: raw materials cost nothing; items with no usable recipe are counted raw, with a penalty.
  for (const g of db.goods.values()) {
    if (isRaw(g.id) || notConsumed(g.id)) offer(g.id, 0);
    else if (!candidates(g.id).some(r => allowed(r, g.id))) offer(g.id, NO_RECIPE);
  }
  const waiting = new Map(), sum = new Map(), usedBy = new Map();
  const fire = r => { for (const e of [...(r.itemOut ?? []), ...(r.fluidOut ?? [])]) if (outputAmount(r, e.id) > 0 && allowed(r, e.id)) offer(e.id, sum.get(r.id) + stepCost(r, e.id)); };
  const ready = [];
  for (const r of db.recipesById.values()) {
    const ins = inputsOf(r);
    waiting.set(r.id, ins.length); sum.set(r.id, 0);
    for (const i of ins) { let u = usedBy.get(i); if (!u) usedBy.set(i, u = []); u.push(r); }
    if (!ins.length) ready.push(r);
  }
  for (const r of ready) fire(r);
  while (heap.length) {
    const [c, id] = hpop();
    if (done.has(id) || c !== costs.get(id)) continue;
    done.add(id);
    for (const r of usedBy.get(id) ?? []) {
      sum.set(r.id, sum.get(r.id) + c);
      const w = waiting.get(r.id) - 1; waiting.set(r.id, w);
      if (w === 0) fire(r);
    }
  }
  return costs;
}

// Pick the recipe whose whole chain is cheapest, skipping any that directly needs an item already
// being made higher up (ancestors).
function autoPick(id, ancestors) {
  const C = chainCosts();
  let best = null, bestCost = Infinity;
  for (const r of candidates(id)) {
    if (!allowed(r, id)) continue;
    const ins = inputsOf(r);
    if (ins.some(i => i === id || ancestors.has(i))) continue;
    let c = stepCost(r, id);
    for (const i of ins) c += C.get(i) ?? Infinity;
    if (c < bestCost - 1e-9) { best = r; bestCost = c; }
  }
  return best;
}

function pickOre(od) {
  if (oreChoice.has(od)) return oreChoice.get(od);
  const items = db.oreDicts.get(od)?.items ?? [];
  // Prefer an item that is itself in the raw list, then a GregTech one, then the first.
  // Then the variant most recipes use by its exact id (the "normal" one), then a GregTech one.
  const pop = i => db.consumers.get(i)?.length ?? 0;
  return items.find(i => isRaw(i)) ?? [...items].sort((a, b) => pop(b) - pop(a))[0] ?? null;
}

const rawTotals = new Map();
const surplus = new Map();
const steps = new Map(); // recipeId -> { crafts }
const needsChoice = new Map();
const autoChoices = new Map();
const warnings = new Map(); // de-duplicated by text
const warn = s => warnings.set(s, true);
const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
const loopsBack = (r, ancestors, id) => inputsOf(r).find(i => i === id || ancestors.has(i));

function need(id, amount, ancestors, depth) {
  // Use leftovers first.
  const have = surplus.get(id) ?? 0;
  if (have > 0) { const used = Math.min(have, amount); surplus.set(id, have - used); amount -= used; }
  if (amount <= 1e-9) return;
  if (notConsumed(id)) return;
  if (isRaw(id)) return add(rawTotals, id, amount);
  if (depth > maxDepth) { warn(`${label(db, id)}: hit maxDepth (${maxDepth}), counted as raw`); return add(rawTotals, id, amount); }
  const cands = candidates(id);
  let r = null;
  if (choices.has(id)) {
    r = db.recipesById.get(choices.get(id));
    if (!r) errors.push(`Choice for ${name(db, id)} names an unknown recipe ${choices.get(id)}`);
  } else if (cands.length === 1) {
    const loop = loopsBack(cands[0], ancestors, id);
    if (loop) warn(`${label(db, id)}: its only recipe needs ${label(db, loop)}, which is already being made higher up; counted as raw`);
    else r = cands[0];
  }
  else if (cands.length > 1 && auto) { r = autoPick(id, ancestors); if (r) autoChoices.set(id, r.id); }
  else if (cands.length > 1) needsChoice.set(id, cands);
  if (!r) return add(rawTotals, id, amount);
  if (maxTier !== null && tierOf(r) > maxTier)
    warn(`${label(db, id)}: ${machineName(db, r)} recipe needs ${tierName(tierOf(r))}, above maxTier ${tierName(maxTier)}`);

  const per = outputAmount(r, id);
  const crafts = Math.ceil(amount / per - 1e-9);
  const s = steps.get(r.id) ?? { crafts: 0, makes: id }; s.crafts += crafts; steps.set(r.id, s);
  for (const e of [...(r.itemOut ?? []), ...(r.fluidOut ?? [])]) add(surplus, e.id, e.amount * (e.chance ?? 1) * crafts);
  add(surplus, id, -amount);
  const next = new Set(ancestors).add(id);
  for (const e of [...(r.itemIn ?? []), ...(r.fluidIn ?? [])]) if (e.amount > 0) need(e.id, e.amount * crafts, next, depth + 1);
  for (const e of r.oreDictIn ?? []) {
    const it = pickOre(e.id);
    if (it) need(it, e.amount * crafts, next, depth + 1); else add(rawTotals, e.id, e.amount * crafts);
  }
}

for (const t of plan.targets ?? []) { const id = res(t.item); if (id) need(id, t.amount ?? 1, new Set(), 0); }

const goodsOut = m => [...m].filter(([, v]) => v > 1e-9).map(([id, v]) => ({ id, name: label(db, id), amount: +v.toFixed(3), unit: db.goods.get(id)?.kind === "fluid" ? "L" : "" }))
  .sort((a, b) => a.name.localeCompare(b.name));
let euTotal = 0;
const stepList = [...steps].map(([rid, s]) => {
  const r = db.recipesById.get(rid);
  const eu = r.gt ? r.gt.voltage * r.gt.amperage * r.gt.durationTicks * s.crafts : 0; euTotal += eu;
  return { recipe: rid, machine: machineName(db, r), makes: label(db, s.makes), crafts: s.crafts,
    ...(r.gt ? { euPerTick: r.gt.voltage * r.gt.amperage, tier: tierName(r.gt.voltageTier), secondsEach: r.gt.durationTicks / 20, euTotal: eu } : {}),
    ...(r.gt?.metadata ? { metadata: r.gt.metadata } : {}) };
});
const out = {
  data: db.meta,
  targets: (plan.targets ?? []).map(t => ({ item: name(db, res(t.item) ?? t.item), amount: t.amount ?? 1 })),
  raw: goodsOut(rawTotals),
  steps: stepList,
  euTotal,
  leftovers: goodsOut(surplus),
  needsChoice: [...needsChoice].map(([id, rs]) => ({ id, name: label(db, id), options: rs.length,
    sample: rs.slice(0, 6).map(r => ({ recipe: r.id, machine: machineName(db, r) })) })),
  autoChoices: [...autoChoices].map(([id, rid]) => ({ id, name: label(db, id), recipe: rid, machine: machineName(db, db.recipesById.get(rid)) })),
  ...(maxTier !== null ? { maxTier: tierName(maxTier) } : {}),
  warnings: [...warnings.keys()],
  errors,
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`GTNH ${out.data.gtnhVersion}  targets: ${out.targets.map(t => `${t.amount}x ${t.item}`).join(", ")}\n`);
if (errors.length) console.log("Errors:\n  " + errors.join("\n  ") + "\n");
if (out.warnings.length) console.log("Warnings:\n  " + out.warnings.join("\n  ") + "\n");
const ingotNote = g => /^Molten /.test(g.name) ? `  (= ${+(g.amount / 144).toFixed(2)} ingots)` : "";
console.log("Raw materials:"); for (const g of out.raw) console.log(`  ${g.amount}${g.unit ? " " + g.unit : "x"}  ${g.name}${ingotNote(g)}`);
console.log(`\nSteps (${stepList.length}):`); for (const s of stepList) console.log(`  ${s.crafts}x ${s.machine} -> ${s.makes}${s.euPerTick ? `  ${s.euPerTick} EU/t ${s.tier}, ${s.secondsEach}s each` : ""}${s.metadata ? "  " + JSON.stringify(s.metadata) : ""}`);
console.log(`\nTotal energy: ${euTotal.toLocaleString()} EU`);
if (out.leftovers.length) { console.log("\nLeftovers / byproducts:"); for (const g of out.leftovers) console.log(`  ${g.amount}${g.unit ? " " + g.unit : "x"}  ${g.name}`); }
if (out.needsChoice.length) { console.log("\nNeeds a recipe choice (counted as raw for now):"); for (const c of out.needsChoice) console.log(`  ${c.name} (${c.id}): ${c.options} recipes. See: node scripts/lookup.mjs recipes "${c.id}"`); }
if (out.autoChoices.length) { console.log("\nAuto-picked recipes (pin in plan.choices to keep, or change):"); for (const c of out.autoChoices) console.log(`  ${c.name}: ${c.machine}  ${c.recipe}`); }
