// Expand a plan (what you want to build) into raw materials, machine steps and EU.
// Usage:
//   node scripts/calc.mjs <plan.json> [--auto] [--json]
//   node scripts/calc.mjs --item "Electric Blast Furnace" --amount 4 [--raw "Steel Ingot,Tin Ingot"] [--auto] [--json]
//
// Plan file (see plans/example.json):
//   targets: [{ item, amount }]        item = display name or id
//   raw:     [item, ...]               stop expanding here and count as raw materials
//   choices: { item: recipeId }        which recipe makes an item (pick with lookup.mjs recipes)
//   oreDict: { "o:circuitBasic": item } which item fills an ore dictionary input
//   stopAt:  ["ingot", "dust", ...]    ore dictionary prefixes that count as raw (default below;
//                                      use [] to expand everything down to ores)
//   rawFluids: [fluid, ...]            extra fluids to count as raw (base gases and Molten metals already are)
//   maxDepth: number                   safety limit, default 30
//
// Without --auto, any item with several recipes and no choice is left unexpanded and listed under
// "needsChoice" with its candidate recipes. With --auto the calculator picks one itself and lists it
// under "autoChoices" so it can be reviewed and pinned in the plan.
import { readFileSync } from "node:fs";
import { load, resolve, name, machineName, outputAmount, tierName } from "../lib/data.mjs";

const args = process.argv.slice(2);
const flag = k => { const i = args.indexOf(k); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const auto = flag("--auto"), asJson = flag("--json");
const cliItem = opt("--item"), cliAmount = Number(opt("--amount") ?? 1), cliRaw = opt("--raw");
let plan;
if (cliItem) plan = { targets: [{ item: cliItem, amount: cliAmount }], raw: cliRaw ? cliRaw.split(",").map(s => s.trim()) : [] };
else if (args[0]) plan = JSON.parse(readFileSync(args[0], "utf8"));
else { console.log("Usage: node scripts/calc.mjs <plan.json> | --item <name> --amount N  [--auto] [--json]"); process.exit(1); }

const db = load();
const errors = [];
const res = t => { const id = resolve(db, t); if (!id) errors.push(`Unknown item: ${t}`); return id; };
const raw = new Set((plan.raw ?? []).map(res).filter(Boolean));
const choices = new Map(Object.entries(plan.choices ?? {}).map(([k, v]) => [res(k), v]));
const oreChoice = new Map(Object.entries(plan.oreDict ?? {}).map(([k, v]) => [k, res(v)]));
const maxDepth = plan.maxDepth ?? 30;
const stopAt = plan.stopAt ?? ["ingot", "gem", "dust", "ore", "log", "cropCotton", "slimeball"];
const BASE_FLUIDS = /^(Water|Distilled Water|Steam|Oxygen|Nitrogen|Hydrogen|Chlorine|Fluorine|Helium|Argon|Air|Lava|Oil|Light Oil|Heavy Oil|Raw Oil|Natural Gas|Creosote Oil|Seed Oil|Lubricant|Concrete|Molten .*|Liquid Air)$/;
for (const f of plan.rawFluids ?? []) { const id = res(f); if (id) raw.add(id); }

// Not consumed in a normal build: GregTech single use tools (players use durable tools) and Thaumcraft aspect markers.
const notConsumed = id => id.startsWith("i:ggfab:gt.ggfab.d1:") || id.startsWith("i:aspectrecipeindex:") || id.startsWith("i:gregtech:gt.metatool");
function isRaw(id) {
  if (raw.has(id)) return true;
  const g = db.goods.get(id);
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

function candidates(id) {
  return (db.producers.get(id) ?? []).filter(r => outputAmount(r, id) > 0);
}

function autoPick(id, ancestors) {
  const ok = candidates(id).filter(r => !AUTO_SKIP.test(machineName(db, r)) &&
    ![...(r.itemIn ?? []), ...(r.fluidIn ?? [])].some(e => e.amount > 0 && ancestors.has(e.id)));
  if (!ok.length) return null;
  const score = r => {
    const outs = [...(r.itemOut ?? []), ...(r.fluidOut ?? [])];
    const main = outs[0]?.id === id ? 0 : 1;
    const tier = r.gt?.voltageTier ?? 0;
    const nIn = (r.itemIn?.length ?? 0) + (r.fluidIn?.length ?? 0) + (r.oreDictIn?.length ?? 0);
    const crafting = /^Crafting/.test(machineName(db, r)) ? 0 : 0.5; // hand recipes are the usual default
    return main * 100 + tier * 10 + crafting + nIn * 0.01;
  };
  return ok.sort((a, b) => score(a) - score(b))[0];
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
const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);

function need(id, amount, ancestors, depth) {
  // Use leftovers first.
  const have = surplus.get(id) ?? 0;
  if (have > 0) { const used = Math.min(have, amount); surplus.set(id, have - used); amount -= used; }
  if (amount <= 1e-9) return;
  if (notConsumed(id)) return;
  if (isRaw(id) || depth > maxDepth) return add(rawTotals, id, amount);
  const cands = candidates(id);
  let r = null;
  if (choices.has(id)) {
    r = db.recipesById.get(choices.get(id));
    if (!r) errors.push(`Choice for ${name(db, id)} names an unknown recipe ${choices.get(id)}`);
  } else if (cands.length === 1 && !ancestors.has(id)) r = cands[0];
  else if (cands.length > 1 && auto) { r = autoPick(id, ancestors); if (r) autoChoices.set(id, r.id); }
  else if (cands.length > 1) needsChoice.set(id, cands);
  if (!r) return add(rawTotals, id, amount);

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

const goodsOut = m => [...m].filter(([, v]) => v > 1e-9).map(([id, v]) => ({ id, name: name(db, id), amount: +v.toFixed(3), unit: db.goods.get(id)?.kind === "fluid" ? "L" : "" }))
  .sort((a, b) => a.name.localeCompare(b.name));
let euTotal = 0;
const stepList = [...steps].map(([rid, s]) => {
  const r = db.recipesById.get(rid);
  const eu = r.gt ? r.gt.voltage * r.gt.amperage * r.gt.durationTicks * s.crafts : 0; euTotal += eu;
  return { recipe: rid, machine: machineName(db, r), makes: name(db, s.makes), crafts: s.crafts,
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
  needsChoice: [...needsChoice].map(([id, rs]) => ({ id, name: name(db, id), options: rs.length,
    sample: rs.slice(0, 6).map(r => ({ recipe: r.id, machine: machineName(db, r) })) })),
  autoChoices: [...autoChoices].map(([id, rid]) => ({ id, name: name(db, id), recipe: rid, machine: machineName(db, db.recipesById.get(rid)) })),
  errors,
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
console.log(`GTNH ${out.data.gtnhVersion}  targets: ${out.targets.map(t => `${t.amount}x ${t.item}`).join(", ")}\n`);
if (errors.length) console.log("Errors:\n  " + errors.join("\n  ") + "\n");
const ingotNote = g => /^Molten /.test(g.name) ? `  (= ${+(g.amount / 144).toFixed(2)} ingots)` : "";
console.log("Raw materials:"); for (const g of out.raw) console.log(`  ${g.amount}${g.unit ? " " + g.unit : "x"}  ${g.name}${ingotNote(g)}`);
console.log(`\nSteps (${stepList.length}):`); for (const s of stepList) console.log(`  ${s.crafts}x ${s.machine} -> ${s.makes}${s.euPerTick ? `  ${s.euPerTick} EU/t ${s.tier}, ${s.secondsEach}s each` : ""}${s.metadata ? "  " + JSON.stringify(s.metadata) : ""}`);
console.log(`\nTotal energy: ${euTotal.toLocaleString()} EU`);
if (out.leftovers.length) { console.log("\nLeftovers / byproducts:"); for (const g of out.leftovers) console.log(`  ${g.amount}${g.unit ? " " + g.unit : "x"}  ${g.name}`); }
if (out.needsChoice.length) { console.log("\nNeeds a recipe choice (counted as raw for now):"); for (const c of out.needsChoice) console.log(`  ${c.name} (${c.id}): ${c.options} recipes. See: node scripts/lookup.mjs recipes "${c.id}"`); }
if (out.autoChoices.length) { console.log("\nAuto-picked recipes (pin in plan.choices to keep, or change):"); for (const c of out.autoChoices) console.log(`  ${c.name}: ${c.machine}  ${c.recipe}`); }
