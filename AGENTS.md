# gregllm

A GregTech: New Horizons recipe calculator that runs inside an AI coding CLI (built for Claude Code).
The user asks things like "what do 4 EBFs cost?" and the agent answers with real GTNH 2.9.0 recipe
data, by running small Node scripts. It never connects to the game.

**Read `.claude/skills/gregllm/SKILL.md` and follow it for every GTNH question.** It holds the
workflow, the commands and the limits.

It also has a text game: the player climbs from the Stone Age to LV with Claude as game master,
using the real recipes and the GTNH 2.9.0 quest book. **When the user wants to play, read
`.claude/skills/gregtech-game/SKILL.md` and follow it.**

## First run

If `data/recipes.json` does not exist, run `node scripts/setup-data.mjs` (Node 18+, no npm install
needed). It downloads `data.bin` (about 18 MB) from ShadowTheAge/gtnh-data at a pinned commit,
checks its SHA-256 hash, and writes `data/recipes.json` (about 93 MB).

The game also needs `data/quests.json`: run `node scripts/setup-quests.mjs` (needs git). It
sparse-clones the 2.9.0 quest book from GTNewHorizons/GT-New-Horizons-Modpack at a pinned commit
and converts it.

## Layout

| Path | What | Committed? |
|------|------|-----------|
| `scripts/setup-data.mjs` | Downloads and converts the recipe data | yes |
| `scripts/lookup.mjs` | Item and recipe search | yes |
| `scripts/calc.mjs` | Expands a plan into raw materials, steps and EU | yes |
| `scripts/setup-quests.mjs` | Downloads and converts the GTNH quest book | yes |
| `scripts/game.mjs` | Text game commands (one per call) | yes |
| `lib/data.mjs` | Loads the data and builds indexes | yes |
| `lib/game.mjs` | Game engine: inventory, crafting, machines, power, quests | yes |
| `game/world.json` | Game rules the data lacks: world, ore veins, tools, fuel, steam | yes |
| `saves/` | The player's game saves | **no** |
| `plans/` | The user's build plans (`example.json` is the template) | only the example |
| `tests/` | `npm test` (`node --test`); data tests skip when `data/` is missing | yes |
| `data/` | Downloaded and converted recipe data | **never** |

## Rules

- **Never commit, upload or paste in bulk anything from `data/`.** The upstream recipe export has
  no license, and the quest book is CC BY-NC-SA 4.0 (this repo is MIT). Each user downloads both
  for themselves.
- Never invent recipes. If the data has no recipe for something, say so. The game's own rules
  (tool recipes, mortar grinding, ore veins, fuel and steam numbers) live only in
  `game/world.json` and are described as game rules, not GTNH data.
- Keep scripts dependency-free (Node built-ins only) so a fresh clone works with no `npm install`.
- To move to a new pack version, change `SOURCE` in `scripts/setup-data.mjs` to the new
  gtnh-data branch and commit, then re-run setup. It stops with a hash mismatch that prints the
  new file's hash: check the file came from the right commit, then put that hash in
  `SOURCE.sha256`. If the upstream binary format changes, update the reader in that file (the
  data version check, `E[0] !== 7`). Then run `npm test`; a few tests pin recipe ids and
  amounts from 2.9.0 and will need updating.
