// Run with: npm test   (or: node --test)
// Tests that need the recipe data are skipped when data/recipes.json is missing
// (run `node scripts/setup-data.mjs` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ROOT, DATA_PATH, tierIndex, tierName } from "../lib/data.mjs";

const noData = !existsSync(DATA_PATH) && "no data/recipes.json (run node scripts/setup-data.mjs)";
const tmp = mkdtempSync(join(tmpdir(), "gregllm-test-"));

function calc(planOrArgs) {
  let args = planOrArgs;
  if (!Array.isArray(planOrArgs)) {
    const p = join(tmp, `plan-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(p, JSON.stringify(planOrArgs));
    args = [p, "--auto"];
  }
  const out = execFileSync(process.execPath, [join(ROOT, "scripts", "calc.mjs"), ...args, "--json"], { encoding: "utf8", maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

test("tierIndex parses tier names", () => {
  assert.equal(tierIndex("LV"), 0);
  assert.equal(tierIndex("ulv"), 0);
  assert.equal(tierIndex("mv"), 1);
  assert.equal(tierIndex("IV"), 4);
  assert.equal(tierIndex(2), 2);
  assert.equal(tierIndex("XV"), null);
  assert.equal(tierName(tierIndex("LuV")), "LuV");
});

test("setup-data refuses a file with the wrong hash", () => {
  const bad = join(tmp, "bad.bin");
  writeFileSync(bad, gzipSync(Buffer.from("not the real data")));
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "setup-data.mjs"), join(tmp, "out.json"), "--input", bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash mismatch/);
});

test("4 EBFs at LV: sensible, loop-free, all-LV chain", { skip: noData }, () => {
  const o = calc({ targets: [{ item: "Electric Blast Furnace", amount: 4 }], maxTier: "LV", raw: ["Rubber Bar"] });
  assert.deepEqual(o.errors, []);
  assert.equal(o.maxTier, "LV");
  for (const s of o.steps) if (s.tier) assert.equal(s.tier, "LV", `${s.machine} -> ${s.makes} is ${s.tier}`);
  assert.deepEqual(o.warnings, [], "no over-tier, loop or maxDepth warnings");
  // Invar Rod: file + ingot, not saw + long rod (which forced an MV Fluid Solidifier before).
  const rod = o.autoChoices.find(c => c.name === "Invar Rod");
  assert.equal(rod?.recipe, "r~OQ7nQLIkMDupqPvDICWsQw==");
  assert.ok(!o.steps.some(s => /Fluid Solidifier|Fluid Extractor|Crucible/.test(s.machine)), "no solidifier/extractor/crucible detours");
  assert.ok(o.steps.length < 35, `expected a short chain, got ${o.steps.length} steps`);
  assert.ok(o.raw.some(g => g.name === "Cast Iron Ingot" && g.amount === 168));
});

test("output names are unambiguous", { skip: noData }, () => {
  const o = calc({ targets: [{ item: "Electric Blast Furnace", amount: 4 }], maxTier: "LV" });
  for (const list of [o.raw, o.leftovers, o.autoChoices]) {
    const names = list.map(g => g.name);
    assert.equal(new Set(names).size, names.length, "duplicate names: " + names.join(", "));
  }
});

test("without --auto, items with several recipes wait for a choice", { skip: noData }, () => {
  const o = calc(["--item", "Electric Blast Furnace", "--amount", "1"]);
  assert.equal(o.steps.length, 0);
  assert.ok(o.needsChoice.some(c => c.name.startsWith("Electric Blast Furnace")));
});

test("recipes above maxTier are reported", { skip: noData }, () => {
  const o = calc(["--item", "Integrated Logic Circuit", "--auto", "--tier", "LV"]);
  assert.ok(o.warnings.some(w => /above maxTier LV/.test(w)), o.warnings.join("\n"));
});

test("unknown maxTier is an error", { skip: noData }, () => {
  const o = calc(["--item", "Steel Plate", "--tier", "XV"]);
  assert.ok(o.errors.some(e => /Unknown maxTier/.test(e)));
});

test("molten fluids count as raw (plastics stop at the molten fluid)", { skip: noData }, () => {
  const o = calc(["--item", "Polyethylene (PE) Sheet", "--amount", "4", "--auto"]);
  assert.deepEqual(o.raw.map(g => [g.name, g.amount, g.unit]), [["Molten Polyethylene (PE)", 576, "L"]]);
});

test("hitting maxDepth is a warning, not silent", { skip: noData }, () => {
  const o = calc({ targets: [{ item: "Electric Blast Furnace", amount: 1 }], maxDepth: 1 });
  assert.ok(o.warnings.some(w => /hit maxDepth/.test(w)), o.warnings.join("\n"));
});
