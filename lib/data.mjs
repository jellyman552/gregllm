// Loads data/recipes.json (made by scripts/setup-data.mjs) and builds lookup indexes.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_PATH = join(ROOT, "data", "recipes.json");

// voltageTier 0 covers everything up to 32 EU/t (ULV and LV), 1 is MV, and so on.
const TIERS = ["LV", "MV", "HV", "EV", "IV", "LuV", "ZPM", "UV", "UHV", "UEV", "UIV", "UMV", "UXV", "MAX"];
export const tierName = t => TIERS[t] ?? `T${t}`;

let cache = null;

export function load() {
  if (cache) return cache;
  if (!existsSync(DATA_PATH)) {
    console.error("Recipe data not found. Run: node scripts/setup-data.mjs");
    process.exit(2);
  }
  const d = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  const goods = new Map();
  for (const g of d.items) goods.set(g.id, { ...g, kind: "item" });
  for (const g of d.fluids) goods.set(g.id, { ...g, kind: "fluid" });
  const oreDicts = new Map(d.oreDicts.map(o => [o.id, o]));
  const oreOf = new Map(); // item id -> its ore dictionary names (without "o:")
  for (const o of d.oreDicts) for (const i of o.items) { let a = oreOf.get(i); if (!a) oreOf.set(i, a = []); a.push(o.id.slice(2)); }
  const recipesById = new Map();
  const producers = new Map(); // goods id -> recipes that output it
  const consumers = new Map();
  const push = (m, k, v) => { let a = m.get(k); if (!a) m.set(k, a = []); a.push(v); };
  for (const r of d.recipes) {
    recipesById.set(r.id, r);
    for (const e of [...(r.itemOut ?? []), ...(r.fluidOut ?? [])]) push(producers, e.id, r);
    for (const e of [...(r.itemIn ?? []), ...(r.fluidIn ?? []), ...(r.oreDictIn ?? [])]) push(consumers, e.id, r);
  }
  cache = { meta: { source: d.source, gtnhVersion: d.gtnhVersion }, recipeTypes: d.recipeTypes, goods, oreDicts, oreOf, recipesById, producers, consumers };
  return cache;
}

export function name(db, id) {
  if (id.startsWith("o:")) return `<ore dict ${id.slice(2)}>`;
  return db.goods.get(id)?.name ?? id;
}

// Search items/fluids by display name (case-insensitive, all words must match).
export function search(db, text, limit = 20) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const g of db.goods.values()) {
    const n = (g.name ?? "").toLowerCase();
    if (words.every(w => n.includes(w))) hits.push(g);
  }
  hits.sort((a, b) => (a.name.length - b.name.length) || ((db.producers.get(b.id)?.length ?? 0) - (db.producers.get(a.id)?.length ?? 0)));
  return hits.slice(0, limit);
}

// Resolve user text to one goods id: exact id, exact name, or best search hit.
export function resolve(db, text) {
  if (db.goods.has(text) || db.oreDicts.has(text)) return text;
  const lower = text.toLowerCase();
  const exact = [...db.goods.values()].filter(g => g.name?.toLowerCase() === lower);
  if (exact.length) return exact.sort((a, b) => (db.producers.get(b.id)?.length ?? 0) - (db.producers.get(a.id)?.length ?? 0))[0].id;
  return search(db, text, 1)[0]?.id ?? null;
}

export function machineName(db, r) { return db.recipeTypes[r.type]?.name ?? "?"; }

export function outputAmount(r, id) {
  let n = 0;
  for (const e of [...(r.itemOut ?? []), ...(r.fluidOut ?? [])]) if (e.id === id) n += e.amount * (e.chance ?? 1);
  return n;
}

export function describeRecipe(db, r) {
  const t = db.recipeTypes[r.type];
  const lines = [];
  let head = `${r.id}  [${t?.name}]`;
  if (r.gt) {
    head += `  ${r.gt.voltage} EU/t (${tierName(r.gt.voltageTier)})${r.gt.amperage > 1 ? ` x${r.gt.amperage}A` : ""}, ${r.gt.durationTicks / 20}s`;
    if (r.gt.metadata) head += "  " + Object.entries(r.gt.metadata).map(([k, v]) => `${k}=${v}`).join(" ");
  }
  lines.push(head);
  const fmt = (e, fluid) => `${e.amount}${fluid ? " L" : "x"} ${name(db, e.id)}${e.chance ? ` (${+(e.chance * 100).toFixed(2)}%)` : ""}`;
  const ins = [...(r.itemIn ?? []).map(e => e.amount === 0 ? `[not consumed] ${name(db, e.id)}${circuitNo(db, e.id) !== null ? ` #${circuitNo(db, e.id)}` : ""}` : fmt(e)),
    ...(r.oreDictIn ?? []).map(e => fmt(e)), ...(r.fluidIn ?? []).map(e => fmt(e, true))];
  const outs = [...(r.itemOut ?? []).map(e => fmt(e)), ...(r.fluidOut ?? []).map(e => fmt(e, true))];
  lines.push("    in:  " + ins.join(", "));
  lines.push("    out: " + outs.join(", "));
  if (t?.multiblocks?.length) lines.push("    multiblocks: " + t.multiblocks.map(id => name(db, id)).join(", "));
  return lines.join("\n");
}

export function circuitNo(db, id) {
  return id.startsWith("i:gregtech:gt.integrated_circuit:") ? Number(id.split(":").pop()) : null;
}
