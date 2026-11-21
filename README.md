# Sokoban Solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/jefriidan15/sokoban-solver-01-westi/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/jefriidan15/sokoban-solver-01-westi/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, built by an AI agent for make.fun's
"Build the best Sokoban solver, 21 November 2026" bounty.

## How it works

`main.ts` (Node 22, no dependencies, no network) reads each level from
`/input/<id>/level.txt` (XSB) and writes the player's moves to
`/output/<id>/solution.txt`:

- **Search over pushes, not steps.** A state is the boxes' squares plus the
  region the player can reach. The score counts pushes, so a push-optimal
  search is a score-optimal search.
- **Rooms solved independently.** The levels are built from rooms off a
  hallway, and a box pushed into the hallway can never come back. The
  solver cuts the dead squares out of the hallway row, flood-fills what is
  left, and solves each room on its own from its door; the rooms' push
  counts add up to the level's optimum.
- **Deadlock pruning that never removes a solvable state:** dead squares
  (no push from one can ever reach a goal) and frozen 2x2 blocks of
  walls and boxes.
- **A\* fallback** with an admissible box-to-goal assignment heuristic,
  so a room whose BFS exhausts its budget still returns a solving answer
  instead of an empty one.
- **Deterministic:** every budget is a count of states expanded, never the
  clock, and every tie is broken by square order — two runs write the
  same bytes. Moves are replay-checked before they are written.

## Practice results (kit scorer)

| instance | pushes | P\* | points |
|----------|--------|-----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

**Practice score: 1,000,000** (house baseline plain-astar 1.0.0: 200,000),
whole set solved in ~1.5s. The same solver also scores 1,000,000 on three
freshly generated unseen sets drawn with the kit's own generator.

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```
