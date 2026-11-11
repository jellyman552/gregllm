// Fetch GTNH recipe data from ShadowTheAge/gtnh-data and convert it to JSON locally.
// Usage: node scripts/setup-data.mjs [out.json] [--input data.bin]
// The upstream data is unlicensed, so this tool never ships it: each user downloads it themselves.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
// sha256 is the hash of data.bin at that commit. When moving to a new pack version, update it too
// (run setup once with the new commit; the error message prints the new hash).
const SOURCE = { repo: "ShadowTheAge/gtnh-data", branch: "2.9.0-v7", commit: "d200440ea31d0357068a294d7312acf1146de909", gtnhVersion: "2.9.0",
  sha256: "624c9a20c8476dc630c274145dc04c72d7c582e130a3599dc49ce9aee0a2fe73" };
const args = process.argv.slice(2);
const inIdx = args.indexOf("--input");
const inPath = inIdx >= 0 ? args.splice(inIdx, 2)[1] : null;
const outPath = args[0] ?? join(ROOT, "data", "recipes.json");
let raw;
if (inPath) raw = readFileSync(inPath);
else {
  const url = `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.commit}/data.bin`;
  console.error("Downloading " + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  raw = Buffer.from(await res.arrayBuffer());
}
const hash = createHash("sha256").update(raw).digest("hex");
if (hash !== SOURCE.sha256) {
  console.error(`data.bin hash mismatch.\n  expected ${SOURCE.sha256}\n  got      ${hash}\n` +
    "The download may be corrupt or the file changed. If you changed SOURCE on purpose, put the new hash in SOURCE.sha256.");
  process.exit(1);
}
const buf = gunzipSync(raw);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const E = new Int32Array(ab), B = new Uint8Array(ab), V = new DataView(ab), td = new TextDecoder();
if (E[0] !== 7) throw new Error("unexpected data version " + E[0]);
const strCache = new Map();
const str = p => { if (p === -1) return null; let s = strCache.get(p); if (s === undefined) { const n = E[p], b = p*4+4; s = td.decode(B.subarray(b, b+n)); strCache.set(p, s);} return s; };
const slice = p => E.subarray(p+1, p+1+E[p]);
const fld = (o, k) => E[o+k];
const sfld = (o, k) => str(E[o+k]);
const arr = (o, k) => slice(E[o+k]);
const idOf = p => sfld(p, 4);

const goods = (p, kind) => {
  const g = { id: idOf(p), name: sfld(p,5), mod: sfld(p,6), internalName: sfld(p,7) };
  const nbt = sfld(p,12); if (nbt) g.nbt = nbt;
  if (kind === "item") { g.stackSize = fld(p,15); g.damage = fld(p,16);
    const c = fld(p,17); if (c !== -1) g.container = { fluid: idOf(fld(c,0)), amount: fld(c,1), empty: fld(c,2) === -1 ? null : idOf(fld(c,2)) }; }
  else g.isGas = fld(p,15) === 1;
  return g;
};
const items = [...slice(E[1])].map(p => goods(p, "item"));
const fluids = [...slice(E[2])].map(p => goods(p, "fluid"));
const oreDicts = [...slice(E[3])].map(p => ({ id: idOf(p), items: [...arr(p,5)].map(idOf) }));
const rtIndex = new Map();
const recipeTypes = [...slice(E[4])].map((p, i) => { rtIndex.set(p, i); const d = fld(p,6); return {
  name: sfld(p,0), category: sfld(p,1), dimensions: [...arr(p,2)], shapeless: fld(p,4) === 1,
  singleblocks: [...arr(p,5)].map(idOf), multiblocks: [...arr(p,3)].map(idOf), defaultCrafter: d === -1 ? null : idOf(d) }; });
const IO = ["itemIn","oreDictIn","fluidIn","itemOut","fluidOut"];
const recipes = [...slice(E[5])].map(p => {
  const r = { id: idOf(p), type: rtIndex.get(fld(p,6)) };
  const s = arr(p,5); const io = { itemIn:[], oreDictIn:[], fluidIn:[], itemOut:[], fluidOut:[] };
  for (let i = 0; i < s.length; i += 5) { const e = { id: idOf(s[i+1]), amount: s[i+3], slot: s[i+2] }; const pr = s[i+4]; if (pr !== 100) e.chance = pr/100; io[IO[s[i]]].push(e); }
  for (const k of IO) if (io[k].length) r[k] = io[k];
  const g = fld(p,7);
  if (g !== -1) { r.gt = { voltage: fld(g,0), durationTicks: fld(g,1), amperage: fld(g,2), voltageTier: fld(g,3), circuitConflicts: fld(g,5), specialValue: fld(g,6) };
    const md = [...arr(g,4)]; if (md.length) r.gt.metadata = Object.fromEntries(md.map(m => [sfld(m,0), V.getFloat64(4*(m+1), true)])); }
  return r;
});
const out = { source: SOURCE, gtnhVersion: SOURCE.gtnhVersion, recipeTypes, items, fluids, oreDicts, recipes };
if (dirname(outPath) && !existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
console.log({ items: items.length, fluids: fluids.length, oreDicts: oreDicts.length, recipeTypes: recipeTypes.length, recipes: recipes.length, gtRecipes: recipes.filter(r=>r.gt).length });
