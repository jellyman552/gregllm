# gregllm

A GregTech: New Horizons recipe calculator that runs inside an AI coding CLI (built for Claude Code).
The user asks things like "what do 4 EBFs cost?" and the agent answers with real GTNH 2.9.0 recipe
data, by running small Node scripts. It never connects to the game.

**Read `.claude/skills/gregllm/SKILL.md` and follow it for every GTNH question.** It holds the
workflow, the commands and the limits.

## First run

If `data/recipes.json` does not exist, run `node scripts/setup-data.mjs` (Node 18+, no npm install
needed). It downloads `data.bin` (about 18 MB) from ShadowTheAge/gtnh-data at a pinned commit,
checks its SHA-256 hash, and writes `data/recipes.json` (about 93 MB).

## Layout

| Path | What | Committed? |
|------|------|-----------|
| `scripts/setup-data.mjs` | Downloads and converts the recipe data | yes |
| `scripts/lookup.mjs` | Item and recipe search | yes |
| `scripts/calc.mjs` | Expands a plan into raw materials, steps and EU | yes |
| `lib/data.mjs` | Loads the data and builds indexes | yes |
| `plans/` | The user's build plans (`example.json` is the template) | only the example |
| `tests/` | `npm test` (`node --test`); data tests skip when `data/` is missing | yes |
| `data/` | Downloaded and converted recipe data | **never** |

## Rules

- **Never commit, upload or paste in bulk anything from `data/`.** The upstream export has no
  license. Each user downloads it for themselves.
- Never invent recipes. If the data has no recipe for something, say so.
- Keep scripts dependency-free (Node built-ins only) so a fresh clone works with no `npm install`.
- To move to a new pack version, change `SOURCE` in `scripts/setup-data.mjs` to the new
  gtnh-data branch and commit, then re-run setup. It stops with a hash mismatch that prints the
  new file's hash: check the file came from the right commit, then put that hash in
  `SOURCE.sha256`. If the upstream binary format changes, update the reader in that file (the
  data version check, `E[0] !== 7`). Then run `npm test`; a few tests pin recipe ids and
  amounts from 2.9.0 and will need updating.
