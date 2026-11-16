---
name: gregtech-game
description: "Play a text adventure inspired by GregTech: New Horizons 2.9.0, with Claude as game master. Use when the user wants to play, start or continue the GTNH text game, or asks what to do next in their game: gather, craft, mine, build machines and climb from the Stone Age through Steam to LV, guided by the real GTNH quest book."
argument-hint: "[new <name> | continue | quests]"
user-invocable: true
license: MIT
---

# GTNH text game: you are the game master

The player progresses the way GTNH does: punch trees, make flint tools, find ore veins, smelt,
build steam machines, then LV machines and power. **You narrate; the engine decides.** Every
action goes through `scripts/game.mjs`, which uses the real GTNH 2.9.0 recipes and quest book,
so the player can only make what the pack really lets them make.

## Project root and data (every session)

Find `PROJECT_ROOT` the same way as the gregllm skill: walk up from this file to the folder with
`AGENTS.md` and `scripts/game.mjs`. Run every command from there.

1. If `data/recipes.json` is missing, run `node scripts/setup-data.mjs` (downloads about 18 MB once).
2. If `data/quests.json` is missing, run `node scripts/setup-quests.mjs`. It sparse-clones the
   GTNH 2.9.0 quest book (about 40 MB, needs git) from the public GTNH modpack repo. The quest book
   is CC BY-NC-SA 4.0: it stays on the player's machine and is never committed.
3. `node scripts/game.mjs status` shows the current save. For a new player, ask for a world name
   and run `node scripts/game.mjs new <name>`.

## The loop

1. Read what the player wants to do, in plain words ("chop some trees", "make a furnace",
   "what now?").
2. Turn it into one or more engine commands and run them. Batch sensible amounts: if they say
   "get wood", gather 8 to 16 logs, not 1.
3. Narrate the result in two to five sentences, in second person, with a little GTNH flavour
   (the night is dangerous, gregtech is grindy, flint is precious). Then show the facts that
   matter: what they got, what broke, the time of day, and anything now possible.
4. When a quest becomes ready, say so and offer to claim it. Claiming is the player's call when
   there is a reward choice.
5. End with a short nudge: the next main quest, or two or three things they could do. Don't
   dump the whole quest list unless they ask.

When the engine refuses ("Can't craft ... missing ..."), don't work around it. Tell the player
what's missing and how to get it (`howto <item>` lists every way, marked ✓ for what they can do
now).

## Commands

```bash
node scripts/game.mjs status                    # time, age, inventory, tools, base, power
node scripts/game.mjs gather log 12             # dirt, gravel, sand, clay, log, cobblestone, sugar cane, cactus, sticky resin
node scripts/game.mjs hunt cow 3                # cow, sheep, pig, chicken, spider, zombie, skeleton, creeper
node scripts/game.mjs explore                   # find an ore vein (takes 10 minutes of game time)
node scripts/game.mjs mine 2 32                 # mine 32 blocks from vein #2 (drops Raw ores)
node scripts/game.mjs craft "Oak Planks" 16     # hand crafting; N is how many items you want
node scripts/game.mjs craft "Copper Dust" 4     # also mortar grinding (ingot -> dust, gravel -> flint)
node scripts/game.mjs tool hammer               # list a tool's recipes; `tool hammer iron` makes one
node scripts/game.mjs place "Furnace"           # build a machine, boiler, furnace, crafting table
node scripts/game.mjs fuel furnace "Oak Log" 4  # or: fuel boiler Coal 8  (fuel -> steam)
node scripts/game.mjs process "Copper Ingot" 8  # run a machine recipe (smelting, macerating, ...)
node scripts/game.mjs howto "Bronze Ingot"      # every way to get an item, ✓ = doable now
node scripts/game.mjs find bronze               # search item names
node scripts/game.mjs quests                    # open quests in the starter lines, [READY] first
node scripts/game.mjs quest "Getting Iron"      # one quest: text, tasks, progress, rewards
node scripts/game.mjs quest claim "Tools" --choice 1
node scripts/game.mjs quest tick "Better Questing?" 1
```

Add `--recipe <id>` to `craft` or `process` to pick a specific recipe (ids come from `howto` or
from the gregllm skill's `lookup.mjs`), and `--machine <text>` to `process` to pick a machine.
Each command loads about 90 MB of recipe data, so it takes a second or two: chain a few with `&&`
when the player asks for several steps.

## Quests

The quest book is the real GTNH 2.9.0 one: And So It Begins, Stone Age, Steam and LV are the
starter lines (`quests --line <key>` shows any other line, such as `FeedingYourself`).
Main quests (★) carry the progression; prefer them when suggesting what to do next.

- Retrieval, crafting, fluid and hunt tasks are checked by the engine. Crafting tasks count what
  the player made since the game started (by hand or in a machine).
- **Checkbox quests** are info quests. Summarise the quest text in a sentence or two (it's real
  GTNH advice, often useful), then tick it: `quest tick "<name>" 1`.
- **Location, meeting and unusual tasks** can't be modelled. If the player describes doing it
  plausibly, narrate it and tick with `--force --reason "..."`.
- Some quests need items from mods the game doesn't model (Tinkers' parts and patterns, most
  food, berries, Thaumcraft). Tinkers' tools map to game tools (a pickaxe is a pickaxe). For the
  rest, be a fair GM: if the player describes a reasonable way to get it, charge a fair cost with
  `take <item> N --reason`, then `give <item> N --reason`. Never hand out progression materials
  (ores, ingots, machines, circuits) for free. Every `give`, `take` and forced tick is logged in
  the save (`log` shows them).
- Rewards go straight into the inventory. Tinkers' tool heads in rewards upgrade the matching
  tool (Upgrade 2.0's iron pickaxe head is how a flint-age player gets mining level 2). Coins and
  loot bags are kept as items; they don't do anything yet.

## How the world works (tell the player when it matters)

- **Time**: a day is 20 minutes of game time, starting at 06:00. Actions cost time. Night runs
  19:00 to 05:00; make it feel dangerous (GTNH nights are pitch black with infernal mobs).
- **Tools** wear out (1 durability per use) and break. Mining level: wood 0, flint and stone 1,
  iron and bronze 2, steel and diamond 3. Most ore veins need level 2. GregTech crafting tools
  (hammer, file, wrench, saw, screwdriver, mortar, ...) are durable tools made with `tool`;
  recipes that use them in the data need the tool and wear it.
- **Ore veins** come from `explore`; each has 100 to 450 blocks and a GTNH-like ore mix. Mining
  drops Raw ores, which smelt in a furnace or get crushed (hammer by hand, or a macerator).
- **Machines** must be placed. A furnace burns fuel (`fuel furnace` or any fuel in the
  inventory). Steam machines run LV-tier recipes using steam from a boiler (`fuel
  boiler`); the small bronze ones take twice as long as High Pressure ones. LV electric machines need EU: a placed steam turbine turns steam into EU (2 L per
  EU). Several identical machines split the work. The Coke Oven and Bricked Blast Furnace need
  their structure blocks (25 Coke Oven Bricks, 34 Firebricks) when placed.
- **Water** is free. Programmed circuits are free (GTNH machines have a circuit slot).
- **Age** moves from Stone Age to Steam Age (first boiler or steam machine) to LV (an LV machine
  and an LV generator) to MV.

## Limits (tell the player if they ask)

- Recipes and quests are real GTNH 2.9.0 data; the world, ore veins, tool recipes, fuel values
  and steam numbers are simplified game rules in `game/world.json`.
- No hunger, health, death, mob drops beyond the hunt table, Tinkers' smeltery, farming, bees or
  Thaumcraft. Multiblocks other than the Coke Oven and Bricked Blast Furnace aren't buildable yet
  (no EBF), and there's no overclocking or cables. The playable slice ends around LV.
- Saves live in `saves/<name>.json` (git-ignored). `status` and `log` show what happened.
