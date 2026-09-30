# Project Context for AI Agents

Welcome! This document provides context on how to develop, test, and analyze the Draft Edge engine.

## Core Simulation & Analysis Utilities

The `utils/` directory contains several crucial scripts for evaluating the performance of the valuation engine (`engine.js`). Before changing the engine's mathematical formulas, you should run these simulations to prove your changes increase the bot's win rate.

### 1. Parallel Draft Simulator
- **File**: `utils/simulate_parallel.js`
- **Usage**: `node utils/simulate_parallel.js --runs=30`
- **Purpose**: Runs a Monte Carlo simulation pitting the Draft Edge bot against a league of automated opponents with different archetypes (Homer, Market Value, Stars & Scrubs). 
- **Output**: Generates a statistical report of the bot's Win Rate, positional breakdown, average Z-scores, and most-drafted players. Use this to verify that engine changes actually result in stronger teams.

### 2. Live/Mock Draft Analyzer & Historical Tracker
- **File**: `utils/analyze_mock.js`
- **Usage**: `node utils/analyze_mock.js` (reads from `utils/mock.txt`) or `node utils/analyze_mock.js <path-to-file>`
- **Purpose**: Parses a raw text export from a real Yahoo/ESPN draft (or mock draft) and calculates the final Power Rankings and Surplus Value for every team.
- **Auto-Archive Feature**: When you run `analyze_mock.js`, it automatically saves a timestamped copy of the draft into the `drafts/` directory.
- **Historical Analysis**: After analyzing the single draft, it automatically runs `utils/analyze_history.js` to parse ALL drafts in the `drafts/` directory. This outputs a macro-analysis of the user's historical Win Rate, average category finishes, and most profitable players across all tracked drafts.

### 3. Modifying the Engine
- `engine.js` contains the core valuation logic. 
- Important functions:
  - `checkPrice(state, PLAYERS, rk)`: Computes the absolute Maximum Bid the bot should make on a nominated player. This uses a dynamic programming knapsack algorithm.
  - `runOptimizer(state, PLAYERS)`: Computes the optimal target list of players to nominate/draft when the bot is on the clock.
- **Warning**: When modifying `valFn` in `checkPrice`, be careful not to apply positional bonuses or artificial weights to the entire pool. Only apply target-specific bonuses to the nominated player (`p`), otherwise the knapsack algorithm will hoard budget to hunt the artificially inflated players in the remaining pool, suppressing the Max Bid of the current player.

## League Rules
Refer to `LEAGUE_RULES.md` for the specific league configuration (14 teams, $200 budget, 8-cat Roto, specific roster constraints). Always ensure your simulations run with these constraints.
