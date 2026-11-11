---
name: gregllm
description: "GregTech: New Horizons (GTNH 2.9.0) recipe calculator. Use when the user asks what a GTNH item, machine or multiblock costs, how to make something, which machine runs a recipe, EU/t or duration of a recipe, or wants a batch of items broken down into raw materials."
argument-hint: "[setup | <item and amount> | lookup <item> | uses <item>]"
user-invocable: true
license: MIT
---

# gregllm: GTNH recipe calculator

You answer GregTech: New Horizons crafting questions from real recipe data, not from memory.
GTNH recipes differ from vanilla GregTech and change between pack versions, so **never guess a
recipe**: look it up with the scripts below and quote what they print.

## Project root

Find `PROJECT_ROOT`: start at this SKILL.md's folder and walk up to the first folder that has both
`AGENTS.md` and `scripts/calc.mjs`. Run every command from there. If you cannot find it, the skill
was installed without the repo: tell the user to run
`git clone https://github.com/jellyman552/gregllm && cd gregllm && claude`, then stop.

## Step 0: data check (every session)

If `data/recipes.json` is missing, run setup first and tell the user it downloads about 18 MB once
(about 93 MB on disk after conversion):

```bash
node scripts/setup-data.mjs
```

It downloads the GTNH 2.9.0 recipe export from ShadowTheAge/gtnh-data (pinned commit), checks its
SHA-256 hash, and converts it locally. That data has no license, so it must never be committed or uploaded anywhere.

## Commands

| Need | Command |
|------|---------|
| Find an item's exact name/id | `node scripts/lookup.mjs find <text>` |
| Recipes that make an item | `node scripts/lookup.mjs recipes <item> [--machine <text>] [--limit N]` |
| Recipes that use an item | `node scripts/lookup.mjs uses <item>` |
| One recipe in full | `node scripts/lookup.mjs recipe <recipe id>` |
| Machines / multiblocks for a recipe type | `node scripts/lookup.mjs machines <text>` |
| Raw materials for a build | `node scripts/calc.mjs plans/<name>.json [--auto] [--tier LV] [--json]` |
| Quick one-off | `node scripts/calc.mjs --item "<name>" --amount N --auto --tier LV` |

Item names are matched case-insensitively. When a name is ambiguous, run `find` and use the id
(`i:mod:name:damage` for items, `f:mod:name` for fluids).

## Workflow: "what does X cost?"

1. **Understand the request.** Pin down the items and amounts. For a multiblock, ask whether they
   want just the controller or the full structure. The data has recipes, not structure block counts,
   so for a full structure ask for (or look up together) the casing, coil, hatch and bus counts and
   add each as a target.
2. **Ask the player's voltage tier before running `--auto`** (LV, MV, HV, ...) unless they already
   said it. Put it in the plan as `maxTier` (or pass `--tier`). The script has no tier limit by
   default, so without this it can pick recipes the player can't run yet.
3. **Write a plan** to `plans/<short-name>.json` (copy `plans/example.json`). Plans live in the
   user's checkout and git ignores them, apart from the example.
4. **Run `calc.mjs --auto`** for a first draft. Read the `Warnings` section: it lists recipes above
   `maxTier`, items whose only recipe loops back, and anything cut off by `maxDepth`. Tell the user
   about each one.
5. **Review the recipe choices with the user.** GTNH often has many recipes for one item: hand
   crafting, assembler, recycling, alternatives at higher tiers. `--auto` picks a cheap, low-tier
   recipe and avoids recycling loops, but it is only a draft. Show the important auto picks
   (circuits, plates, wires, anything above the user's current voltage tier) and ask about any that
   look off. Use `lookup.mjs recipes` to show alternatives. Pin each decision in `plan.choices` and
   ore dictionary picks (such as which circuit fills `o:circuitBasic`) in `plan.oreDict`.
6. **Re-run without `--auto`** once the choices are pinned, so the result is reproducible.
   `needsChoice` lists anything still open.
7. **Answer** with the raw material list first, then the machine steps grouped by machine, total EU,
   and notable leftovers or byproducts. Quote fluid amounts in L, and convert `Molten X` to ingots
   (144 L each).

## How the calculator counts

- `stopAt` (default ingots, gems, dusts, ores, logs, cotton and slimeballs) marks where expansion
  stops. A plan's `stopAt` **replaces** the default list, so copy the whole list if you only want to
  add to it. Put `stopAt: []` in the plan to expand down to ores.
- Base gases, water, oil and every `Molten <x>` fluid count as raw, including plastics such as
  Molten Polyethylene: expansion stops at the molten fluid. Vanilla world blocks (cobblestone, sand,
  gravel, ...) and Sticky Resin (from a treetap) also count as raw.
- `--auto` ranks each recipe by its whole chain down to raw materials: every step costs 1, each
  voltage tier above LV adds 20 per step, steps above `maxTier` add 1000, and byproduct or machine
  recipes cost a little more than hand crafting. Items with no usable recipe cost 50, so salvage
  recipes that take apart some unobtainable mod item lose. The cheapest chain can never loop.
  Any dust counts as raw, so a chain may start from an unusual dust (such as Liveroot Dust): check
  the raw list for those.
- When two items share a display name, the output adds the mod, e.g. `Wood Pulp (Forestry)` vs
  `Wood Pulp (gregtech)`.
- Programmed circuits, molds, lenses and other 0-amount inputs are not consumed. Single-use GT
  tools from crafting recipes are skipped because players use durable tools.
- Output chances are averaged (expected value). Leftover outputs feed later steps before anything
  new is crafted.
- `EU total` = EU/t × amps × ticks × crafts. It ignores overclocking and multiblock parallels. Say
  so if the user asks about time or power.

## Limits to tell the user about

- The data is GTNH **2.9.0** (it comes from the web calculator at https://shadowtheage.github.io/gtnh/).
  Other pack versions may differ.
- There are no multiblock structure block counts and no overclock or parallel math yet.
- A calc run with `--auto` takes a few seconds (it costs every recipe chain in the pack once).
- Auto recipe choice is a heuristic. Always confirm it before giving a final shopping list.
