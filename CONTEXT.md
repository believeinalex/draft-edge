# Project Context for AI Agents

Welcome! This document provides context on how to develop, test, and analyze the Draft Edge engine.

## Core Simulation & Analysis Utilities

The `utils/` directory contains several crucial scripts for evaluating the performance of the valuation engine (`engine.js`). Before changing the engine's mathematical formulas, you should run these simulations to prove your changes increase the bot's win rate.

### 1. Parallel Draft Simulator
- **File**: `utils/simulate_parallel.js`
- **Usage**:
  - Confirmed 15-team / 12-slot (9 starters, 3 bench): `node utils/simulate_parallel.js --mode=hybrid --runs=30`
  - Custom overrides: `node utils/simulate_parallel.js --mode=hybrid --teams=15 --slots=12 --starters=9 --runs=30`
  - Supported `--mode` values: `hybrid` (default v2.4 champion), `multi_center`, `dynamic_weights`, `baseline` (legacy static `+4.0/+2.0` center bonus).
- **Purpose**: Runs a multi-worker Monte Carlo simulation pitting the Draft Edge bot against a league of automated opponents (Market Value, Stars & Scrubs, Strict Budget, Homer) under strict Yahoo $200 hard salary cap rules ($\text{maxLegalBid} = \max(1, \text{budgetLeft} - (\text{slotsLeft} - 1))$).
- **Output**: Generates Win Rate, Finish Place Distribution, average category Z-scores & League Ranks, Top 30 drafted players with Surplus ROI, and full forensic breakdowns for every loss.

### 2. Autonomous Hill-Climbing & Loss Forensics
- **Hill-Climbing Runner**: `node utils/hill_climb.js` — Evaluates candidate hyperparameter configurations (`state.hillClimbConfig`) across parallel workers against a multi-objective fitness function (Win Rate + Power Points - Category Rank Balance Penalty).
- **Forensic Loss Analyzer**: `node utils/analyze_losses.js` — Captures exact rosters, prices paid, and category rank differentials for any simulated draft where the bot finishes #2 or lower.

### 3. Live/Mock Draft Analyzer & Historical Tracker
- **File**: `utils/analyze_mock.js`
- **Usage**: `npm run analyze` or `node utils/analyze_mock.js` (reads from `utils/mock.txt`) or `node utils/analyze_mock.js <path-to-file>`
- **Purpose**: Parses a raw text export from a real Yahoo/ESPN draft (or mock draft) and calculates the final Power Rankings and Surplus Value for every team.
- **Auto-Archive & Auto-Pricing**: When you run `analyze_mock.js`, it automatically saves a timestamped copy of the draft into `drafts/`, recalculates empirical average/median draft prices across all sample drafts (`utils/calculate_draft_prices.js`), and updates `players.js`, `draft_prices.csv`, and `prices.csv`.
- **Stock Analysis & Major Price Moves (Stock Watch)**:
  - Tracks significant divergences ($\Delta \ge \$3$ or $\ge 50\%$) between individual draft clearing prices and empirical market medians (`mktCost`).
  - Reports **Top Price Surges** (Stock Rising / Bullish Price Spikes) and **Top Price Drops** (Stock Falling / Value Dips) to detect inflation shifts and market trends.
  - Generates full historical win rate and profitable player breakdowns (`utils/analyze_history.js`).

### 4. Valuation Engine Architecture (`engine.js` — v2.4 Hybrid Default)
- **6-Slot Multi-Center Knapsack DP (`PG, SG, SF, PF, C1, C2` — 64 Coverage States)**:
  - `reachableCoverage()`, `knapsackDP()`, and `knapsackReconstruct()` track two distinct center slots (`C1` and `C2`) in the DP bitmask when `multiCenter` is active (`centerMode === 'hybrid'`), structurally guaranteeing a multi-center roster without arbitrary Z-score inflation.
- **Dynamic Category Deficit Weighting (`getDynamicCategoryWeights`)**:
  - Dynamically adjusts category weights around base priors (`FG%: 1.08, 3PM: 1.06, REB: 1.10, BLK: 1.15`) using a smoothed deficit slope (`alpha: 0.10, targetPerPick: 0.08, [wMin: 0.75, wMax: 1.48]`) and **Second-Half Deficit Urgency** (`lateDeficitBoost: 1.25` once 40% of roster slots are filled).
- **Rank-Matched Opponent Bid Ceiling & Endgame Monopoly Mode (`buildEffectiveCostMap` & `solveDreamBuild`)**:
  - `buildEffectiveCostMap()` sorts the remaining pool by player valuation (`valFn`) and matches players against the sorted remaining opponent max-bids (`bestMaxLegal + 1`) whenever opponent budgets become a binding constraint (`bestMaxLegal <= fairPrice * 1.5`), depleting each opponent's budget/slots as they contest top targets.
  - `solveDreamBuild()` runs an unconstrained (`$1/slot`) 6-slot Knapsack DP to identify the **Best Team Regardless of Money** (`dreamPlayers`).
  - When `budgetLeft` covers the rank-matched effective cost of `dreamPlayers` (`isMonopoly === true`), the solver enters **Endgame Monopoly** mode: bidding up to `maxOppBid + 1` on every `dreamPlayers` target and strictly returning `pass ($0)` on all non-Dream filler players.
  - When `!isMonopoly`, `runOptimizer()` surfaces both the **Dream Build (Regardless of $)** upgrade targets and top-market **Bait Nominations** (`baitPlayers` not in either build) to drain remaining opponent cash.
- **Yahoo $200 Hard Cap & Opponent Max-Bid Ceiling (`checkPrice`)**:
  - Bounds binary search in `checkPrice()` by `myMaxLegal = Math.max(1, B - (slotsLeft - 1))` and `maxOppBid + 1` (with `getMaxOppBid()` accounting for un-logged teams in early live drafts).
- **Reference Docs**:
  - See `docs/PRICE_CHECK_UPGRADES.md` and `docs/OVERNIGHT_HILL_CLIMB_REPORT.md` for full mathematical details and simulation benchmarks.

### 5. Fragility Budgeting & Cap System ($\le 1.0$)
- **Player Fragility Tiers (`players.js` & `engine.js`)**:
  - **Tier 1 (1.0)**: High injury/games-missed risk (`Kawhi Leonard`, `Joel Embiid`, `Jimmy Butler`, `Kyrie Irving`, `LaMelo Ball`, `Lauri Markkanen`, `Zion Williamson`, `Ja Morant`). Drafting one Tier 1 player consumes the entire fragility budget.
  - **Tier 2 (0.5)**: Moderate durability/load management/age concerns (`Giannis Antetokounmpo`, `Stephen Curry`, `LeBron James`, `Kevin Durant`, `Anthony Davis`, `Tyler Herro`, `Zach Edey`, `Jayson Tatum`, `Dejounte Murray`, `Paul George`, `Tyrese Haliburton`, `Domantas Sabonis`, `Damian Lillard`, `Walker Kessler`, `Jalen Suggs`, `Kon Knueppel`). You can draft at most two Tier 2 players (if no Tier 1 is rostered).
  - **DND ($\infty$)**: Unviable for draft (`Brandon Ingram`, `Kristaps Porziņģis`). Assigned `fragUnits = 999` and automatically excluded by the DP solver.
  - **Durable (0.0)**: All other players.
- **Multi-Dimensional Knapsack DP Enforcement**:
  - `knapsackDP()` tracks a discrete fragility dimension $F = \text{maxFragUnits} + 1 \in \{0, 1, 2\}$ representing half-units of fragility ($0.0, 0.5, 1.0$).
  - Any combination of players whose total fragility exceeds `maxFragility` (default $1.0$) is mathematically unreachable in the state space.
- **Real-Time Live Auction Overrides (`checkPrice` & `content.js`)**:
  - `checkPrice()` checks `currentRosterFragility + pFragility > maxFragility`. If exceeded, it immediately returns `maxBid: 0`, `fragilityCapped: true`.
  - The live Yahoo overlay renders an amber/red warning banner, disables bidding recommendations, and badges the player as `⚠️ Risk ${pFrag} (Capped: Fragility Limit Reached)`.

## League Rules
Refer to `LEAGUE_RULES.md` for the specific league configuration (15 teams, $200 budget, 8-cat Roto, 12 roster slots with 9 starters and 3 bench). Always ensure your simulations run with these constraints.

