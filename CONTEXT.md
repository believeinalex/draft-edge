# Project Context for AI Agents

Welcome! This document provides context on how to develop, test, and analyze the Draft Edge engine.

## Core Simulation & Analysis Utilities

The `utils/` directory contains several crucial scripts for evaluating the performance of the valuation engine (`engine.js`). Before changing the engine's mathematical formulas, you should run these simulations to prove your changes increase the bot's win rate.

### 1. Parallel Draft Simulator
- **File**: `utils/simulate_parallel.js`
- **Usage**:
  - Standard 14-team / 13-slot: `node utils/simulate_parallel.js --mode=hybrid --runs=30`
  - Upcoming 15-team / 12-slot (9 starters, 3 bench): `node utils/simulate_parallel.js --mode=hybrid --teams=15 --slots=12 --starters=9 --runs=30`
  - Supported `--mode` values: `hybrid` (default v2.3 champion), `multi_center`, `dynamic_weights`, `baseline` (legacy static `+4.0/+2.0` center bonus).
- **Purpose**: Runs a multi-worker Monte Carlo simulation pitting the Draft Edge bot against a league of automated opponents (Market Value, Stars & Scrubs, Strict Budget, Homer) under strict Yahoo $200 hard salary cap rules ($\text{maxLegalBid} = \max(1, \text{budgetLeft} - (\text{slotsLeft} - 1))$).
- **Output**: Generates Win Rate, Finish Place Distribution, average category Z-scores & League Ranks, Top 30 drafted players with Surplus ROI, and full forensic breakdowns for every loss.

### 2. Autonomous Hill-Climbing & Loss Forensics
- **Hill-Climbing Runner**: `node utils/hill_climb.js` — Evaluates candidate hyperparameter configurations (`state.hillClimbConfig`) across parallel workers against a multi-objective fitness function (Win Rate + Power Points - Category Rank Balance Penalty).
- **Forensic Loss Analyzer**: `node utils/analyze_losses.js` — Captures exact rosters, prices paid, and category rank differentials for any simulated draft where the bot finishes #2 or lower.

### 3. Live/Mock Draft Analyzer & Historical Tracker
- **File**: `utils/analyze_mock.js`
- **Usage**: `node utils/analyze_mock.js` (reads from `utils/mock.txt`) or `node utils/analyze_mock.js <path-to-file>`
- **Purpose**: Parses a raw text export from a real Yahoo/ESPN draft (or mock draft) and calculates the final Power Rankings and Surplus Value for every team.
- **Auto-Archive Feature**: When you run `analyze_mock.js`, it automatically saves a timestamped copy of the draft into the `drafts/` directory and runs `utils/analyze_history.js`.

### 4. Valuation Engine Architecture (`engine.js` — v2.3 Hybrid Default)
- **6-Slot Multi-Center Knapsack DP (`PG, SG, SF, PF, C1, C2` — 64 Coverage States)**:
  - `reachableCoverage()`, `knapsackDP()`, and `knapsackReconstruct()` track two distinct center slots (`C1` and `C2`) in the DP bitmask when `multiCenter` is active (`centerMode === 'hybrid'`), structurally guaranteeing a multi-center roster without arbitrary Z-score inflation.
- **Dynamic Category Deficit Weighting (`getDynamicCategoryWeights`)**:
  - Dynamically adjusts category weights around base priors (`FG%: 1.08, 3PM: 1.06, REB: 1.10, BLK: 1.15`) using a smoothed deficit slope (`alpha: 0.10, targetPerPick: 0.08, [wMin: 0.75, wMax: 1.48]`) and **Second-Half Deficit Urgency** (`lateDeficitBoost: 1.25` once 40% of roster slots are filled).
- **Yahoo $200 Hard Cap & Opponent Max-Bid Ceiling (`checkPrice`)**:
  - Bounds binary search in `checkPrice()` by `myMaxLegal = Math.max(1, B - (slotsLeft - 1))` and `maxOppBid + 1` (with a guard when `C.teamNamesAll.length < state.numTeams` so un-logged teams in early live drafts are assumed to hold full starting budget).
- **Reference Docs**:
  - See `docs/PRICE_CHECK_UPGRADES.md` and `docs/OVERNIGHT_HILL_CLIMB_REPORT.md` for full mathematical details and 300-draft stress test benchmarks (**93.3% win rate / 100% Top-3 in 14T/13S; 92.0% win rate in 15T/12S**).

## League Rules
Refer to `LEAGUE_RULES.md` for the specific league configuration (14–15 teams, $200 budget, 8-cat Roto, 12–13 roster slots with 9 starters). Always ensure your simulations run with these constraints.

