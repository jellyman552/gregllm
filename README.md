# gregllm

Ask Claude what your GregTech: New Horizons build will cost. gregllm is a Claude Code skill that
breaks multiblocks and batch crafts down to raw materials, using real GTNH 2.9.0 recipe data.

> "How much do 4 Electric Blast Furnaces cost? I'm in MV."
>
> Claude looks up every recipe in the chain, checks the recipe choices with you (which circuit,
> hand-crafted or assembler plates), and comes back with the raw material list, the machine steps
> with EU/t and duration, total EU, and leftovers.

It runs on your computer and never connects to the game.

## Quick start

You need [Claude Code](https://claude.com/claude-code) and [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/jellyman552/gregllm.git
cd gregllm
claude
```

Then just ask. On first use Claude downloads the recipe data (about 18 MB, about 93 MB once converted) and
checks it against a pinned hash. You can
also run that step yourself:

```bash
node scripts/setup-data.mjs
```

There's nothing to `npm install`.

## What you can ask

- "What do 16 MV motors cost in raw materials?"
- "Break down a Large Chemical Reactor controller, then the casings for the full structure."
- "Which multiblocks can run Blast Furnace recipes?"
- "What's the EU/t and duration for Gallium Arsenide in the EBF?"
- "What uses Polyethylene?"

## Using the scripts directly

```bash
node scripts/lookup.mjs find steel plate
node scripts/lookup.mjs recipes "Electric Blast Furnace"
node scripts/lookup.mjs machines blast
node scripts/calc.mjs --item "Electric Blast Furnace" --amount 4 --auto --tier LV
node scripts/calc.mjs plans/example.json --auto
```

`--tier` (or `maxTier` in a plan) is your voltage tier. `--auto` then avoids recipes above it and
warns about any it can't avoid. Claude asks for your tier before running it.

A plan file (`plans/*.json`) lists the targets and pins your choices: which recipe makes an item,
which item fills an ore dictionary slot, and where to stop expanding (ingots and dusts by default).
See `plans/example.json` and `.claude/skills/gregllm/SKILL.md`.

To run the tests: `npm test` (the ones that need recipe data are skipped until you've run setup).

## Limits

- The recipe data is GTNH **2.9.0**. Other versions will be off in places.
- With `--auto`, recipe choices are the cheapest low-tier chain the calculator can find, but still
  a first guess. Claude checks them with you before giving a final answer.
- Molten fluids (metals and plastics) count as raw materials; the calculator doesn't expand them.
- Multiblock structure block counts, overclocking and parallels aren't modeled yet.

## Data and credits

The recipe data is the export behind ShadowTheAge's [GTNH calculator](https://shadowtheage.github.io/gtnh/)
([source](https://github.com/ShadowTheAge/gtnh)), from
[ShadowTheAge/gtnh-data](https://github.com/ShadowTheAge/gtnh-data), made with the NESQL exporter.
That data has no license and contains content owned by Mojang, the GTNH team and mod authors, so
this repo **does not include it**. `setup-data.mjs` downloads a pinned copy on your machine.
`data/` is git-ignored, so please don't commit or redistribute it.

The code in this repo is MIT licensed. This project isn't affiliated with GTNH or ShadowTheAge.
