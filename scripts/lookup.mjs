// Look up items and recipes in the local GTNH data.
// Usage:
//   node scripts/lookup.mjs find <text>              items/fluids whose name matches
//   node scripts/lookup.mjs recipes <item> [--machine <text>] [--limit N]   recipes that make it
//   node scripts/lookup.mjs uses <item> [--limit N]  recipes that consume it
//   node scripts/lookup.mjs recipe <recipe id>       one recipe in full
//   node scripts/lookup.mjs machines <text>          recipe types (machines) and the multiblocks that run them
import { load, search, resolve, name, describeRecipe, outputAmount } from "../lib/data.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const limit = Number(opt("--limit", 15));
const machine = opt("--machine", null)?.toLowerCase();
const [cmd, ...rest] = args;
const text = rest.join(" ");
if (!cmd || !text) { console.log("Usage: node scripts/lookup.mjs find|recipes|uses|recipe|machines <text>"); process.exit(1); }
const db = load();

const pickItem = () => {
  const id = resolve(db, text);
  if (!id) { console.log(`No item matches "${text}". Try: node scripts/lookup.mjs find ${text}`); process.exit(1); }
  console.log(`Item: ${name(db, id)}  (${id})\n`);
  return id;
};
const filt = rs => machine ? rs.filter(r => db.recipeTypes[r.type]?.name.toLowerCase().includes(machine)) : rs;

if (cmd === "find") {
  for (const g of search(db, text, limit)) console.log(`${g.name}  (${g.id})  ${g.kind}, made by ${db.producers.get(g.id)?.length ?? 0} recipes`);
} else if (cmd === "recipes") {
  const id = pickItem();
  const rs = filt(db.producers.get(id) ?? []).sort((a, b) => (outputAmount(b, id) > 0) - (outputAmount(a, id) > 0) || (a.gt?.voltageTier ?? 0) - (b.gt?.voltageTier ?? 0));
  console.log(`${rs.length} recipes make it${rs.length > limit ? ` (showing ${limit})` : ""}:\n`);
  for (const r of rs.slice(0, limit)) console.log(describeRecipe(db, r) + "\n");
} else if (cmd === "uses") {
  const id = pickItem();
  const rs = filt(db.consumers.get(id) ?? []);
  console.log(`${rs.length} recipes use it${rs.length > limit ? ` (showing ${limit})` : ""}:\n`);
  for (const r of rs.slice(0, limit)) console.log(describeRecipe(db, r) + "\n");
} else if (cmd === "recipe") {
  const r = db.recipesById.get(text);
  console.log(r ? describeRecipe(db, r) : `No recipe with id ${text}`);
} else if (cmd === "machines") {
  const q = text.toLowerCase();
  for (const t of db.recipeTypes.filter(t => t.name.toLowerCase().includes(q)))
    console.log(`${t.name} [${t.category}]\n    singleblocks: ${t.singleblocks.map(i => name(db, i)).join(", ") || "-"}\n    multiblocks: ${t.multiblocks.map(i => name(db, i)).join(", ") || "-"}`);
} else {
  console.log(`Unknown command ${cmd}`); process.exit(1);
}
