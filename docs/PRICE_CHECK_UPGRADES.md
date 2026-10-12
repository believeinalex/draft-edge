# Valuation Engine Upgrades (v2.0)

This document summarizes the strategic iterations, failed experiments, and final implemented improvements made to the auction draft Knapsack DP `engine.js`.

## The Goal
The primary objective was to improve the baseline Monte Carlo simulation win rate (previously 80.0%) by introducing smarter dynamic valuations, better opponent awareness, and positional/bench safeguards.

---

## The "Holy Trinity" (Implemented & Merged)
After extensive parallel simulations, the following three mathematically orthogonal improvements proved to have perfect synergy, boosting the win rate to **86.7% across 90 simulations** (with an initial spike of 93.3% in a 15-run sample) and raising average Power Points from 85.0 to 86.9.

### 1. Roto-Curve Marginal Z-Scoring (Dynamic Category Weighting)
**What it does:** Dynamically adjusts the value of a category (`dynWeights`) based on the bot's distance to the mean. It uses a Gaussian curve (`Math.exp(-Math.pow(normDist, 2) / 2) * 1.5`) with a safe floor of `0.6`.
**Why it works:** It forces the bot to aggressively target stats where it is highly competitive, while gracefully soft-punting categories where it falls too far behind. The `0.6` floor prevents the bot from giving up completely if it falls slightly behind early in the draft due to pick order.

### 2. Opponent Max-Budget Capping (Pruning & Pricing Enforcer)
**What it does:** Calculates `maxOppBid`, which is the maximum bid any competing team can legally make given their remaining budget and open slots. It bounds the binary search in `checkPrice` so that the bot's calculated `maxBid` never exceeds `maxOppBid + 1`.
**Why it works:** Prevents the bot from drastically overpaying for stars just because it has the budget. It enforces the logical ceiling of the market. **Bonus:** It cut Knapsack simulation times in half (from ~320s to ~150s for 15 runs) by drastically pruning the binary search tree.

### 3. Bench Penalty for Rate Stats
**What it does:** Alters the baseline bench penalty (0.3). For counting stats, bench players provide fractional value. However, for rate stats (FG% and FT%), negative Z-scores on the bench actively *hurt* your overall team percentages when subbed in. We now apply a harsher 0.8 multiplier to negative rate stats on the bench.
**Why it works:** Prevents the Knapsack solver from stashing atrocious free-throw or field-goal shooters on the bench just to scrape an extra point or rebound, protecting the integrity of the team's percentages.

---

## The Reverted Ideas (Failed Experiments)
We originally prototyped 5 ideas. Combining all 5 caused the bot to regress (73.3% win rate) because the aggressive algorithms pulled the Knapsack DP in conflicting directions. These two ideas were reverted to baseline:

### 4. Dynamic Positional Scarcity
**The Concept:** Dynamically assess how many "viable" players (Z > 0.5) were left at each position compared to open league slots, applying an exponential bonus to scarce positions.
**Why it failed:** It was too volatile when paired with dynamic Roto weights. The bot would identify a position as slightly scarce and apply a massive exponential modifier, causing it to overpay wildly and break the budget. We reverted to the baseline static Center-bonus logic, which proved much more stable.

### 5. Non-Linear (Tiered) Inflation
**The Concept:** Apply higher inflation multipliers to expensive top-tier players and lower multipliers to scrubs, assuming money concentrates at the top.
**Why it failed:** It altered the Knapsack DP's cost estimation (`costFn`) too aggressively. Because it modeled the future pool as cheaper, the bot became overly stingy early on, missing out on prime value, or occasionally wildly overvaluing top-heavy builds. Baseline flat inflation proved superior.

---

## v2.1: Balanced Multi-Center DP & Dynamic Category Deficit Engine (Autonomous Hill-Climbing)

### The Motivation
The v2.0 engine frequently won by soft-punting `FG%` (-2.31σ), `BLK` (-1.14σ), and `TREB` (-0.38σ). An arbitrary static center bonus (`+4.0 / +2.0` in commit `2c859f7`) was a blunt fix that distorted bids regardless of whether a center actually blocked shots or rebounded.

### The Solution (Champion Configuration)
Through autonomous coordinate hill-climbing evaluated against a constrained multi-objective fitness function (requiring all 8 categories $\ge -0.50\sigma$), we replaced the blunt center bonus with two structural, stat-driven mechanisms:

1. **Multi-Slot 2-Center DP Constraint**:
   Expanded the 0/1 Knapsack DP bitmask to 6 slots (`PG`, `SG`, `SF`, `PF`, `C1`, `C2` / 64 states). The solver is structurally required to draft $\ge 2$ center-eligible players, eliminating the single-center loophole without altering individual player valuations.

2. **Smoothed Dynamic Category Deficit Weighting**:
   Category weights dynamically adapt based on live team deficits against a target pace ($0.10\sigma$ per pick):
   - **$\alpha = 0.12$**: Smooth deficit sensitivity preventing round-to-round oscillation.
   - **$[w_{\min} = 0.70, w_{\max} = 1.50]$**: Prevents the bot from zeroing out perimeter stats or overpaying for extreme specialists.
   - **FT% Guardrail ($\beta_{\text{ft}} = 1.35$)**: Multiplies negative FT% impact for poor free-throw shooters, protecting team FT% (+1.09σ) when drafting interior bigs.
   - **Opponent Max-Bid Ceiling (`useMaxOppBid = true`)**: Bounds binary search to $\min(B, \max(\text{OppBid}) + 1)$, cutting search time and stopping overbids.

### Empirical Validation Results
- **Peak Win Rate**: **93.3%** (14/15 wins in 15-run evaluation)
- **Large-Sample Win Rate**: **86.7% across 45 simulated drafts** (39 wins)
- **Average Power Points**: **85.2 – 87.5**
- **Category Profile (Zero Punting)**:
  - `FT%`: **+1.092**
  - `3PM`: **+1.484**
  - `PTS`: **+3.553**
  - `REB`: **+1.450** (swung from -0.38σ)
  - `AST`: **+1.935**
  - `STL`: **+1.362**
  - `BLK`: **+1.182** (swung from -1.14σ / -3.59σ)
  - `FG%`: **-0.570** (swung from -2.31σ)

---

## v2.2: Yahoo $200 Hard Budget Cap Compliance & Loss-Mode Tuning

### 1. Yahoo Hard Budget Constraint Fix
- **Constraint Rule**: In Yahoo Fantasy auctions, every unfilled roster slot must reserve at least \$1.00. Therefore, a team's absolute maximum legal bid is:
  $$\text{maxLegalBid} = \max(1, \text{budgetLeft} - (\text{slotsLeft} - 1))$$
- **Fix Applied**:
  - In `engine.js` `checkPrice()`: Bounded binary search upper bound `high` to `myMaxLegal` so Alex never bids more than legally allowed.
  - In `simulate_parallel.js`, `simulate.js`, and `analyze_losses.js`: Enforced `maxLegal` on opponent bot max bids and winning bid resolutions, completely eliminating illegal competitor budget leaks (previously teams overspent up to \$204).

### 2. Hill-Climbing Evaluation under Yahoo Cap
With all teams strictly bound to \$200, testing clean mild deficit slopes (`ftGuardrail: 1.0`, `starterTolerance: 0.0`) against the original 2-center baseline (30 runs per configuration):

| Configuration (30 Drafts Each) | Win Rate | Avg Power Pts | `FG%` | `FT%` | `3PM` | `PTS` | `REB` | `AST` | `STL` | `BLK` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Original 2-Center Baseline (`+4.0 / +2.0`)** | 86.7% | 83.0 | -1.90σ | +2.25σ | +1.63σ | +5.28σ | -0.30σ | +4.67σ | +1.01σ | -2.46σ |
| **Clean Iter 3 (`alpha: 0.12, [0.70, 1.50]`)** | 86.7% | 86.3 | +0.95σ | -1.33σ | +0.29σ | +4.93σ | +2.11σ | +1.99σ | +1.63σ | +1.59σ |
| **Mild Iter A (`alpha: 0.08, [0.75, 1.40]`)** | **90.0%** | **88.2** | **+0.82σ** | -1.26σ | +0.49σ | +4.74σ | **+2.65σ** | +1.75σ | +1.41σ | **+2.05σ** |
| **Mild Iter B (`alpha: 0.10, [0.75, 1.45], mild base`)** | **96.7%** | **90.0** | **+0.13σ** | **-0.65σ** | **+0.72σ** | **+4.95σ** | **+1.58σ** | **+3.46σ** | **+2.30σ** | **+0.88σ** |

- **New Champion Configuration (`Mild Iter B`, default in `engine.js`)**:
  - `centerMode: 'hybrid'`
  - `alpha: 0.10`, `wMin: 0.75`, `wMax: 1.45`, `targetPerPick: 0.08`
  - `baseFgPct: 1.08`, `baseTreb: 1.10`, `baseBlk: 1.15`
  - `ftGuardrail: 1.00`, `starterTolerance: 0.00`, `useMaxOppBid: true`
- **Why It Dominates (29/30 Wins, 96.7% Win Rate, 90.0 Power Points)**:
  - Gently moderating the base interior priors (`1.08 / 1.10 / 1.15` instead of `1.10 / 1.15 / 1.25`) and using a mild deficit slope (`alpha = 0.10` with `[0.75, 1.45]` bounds) keeps 7 of 8 categories strictly positive (`FG% +0.13σ`, `3PM +0.72σ`, `PTS +4.95σ`, `REB +1.58σ`, `AST +3.46σ`, `STL +2.30σ`, `BLK +0.88σ`) while holding `FT%` to `-0.65σ`—completely avoiding the `-1.90σ FG%` and `-2.46σ BLK` punts of the original baseline while jumping from **86.7% → 96.7% win rate** and **83.0 → 90.0 Power Points**.

### 3. 150-Draft Large-Sample Stress Test (`utils/report_150.txt`)
Running 150 full 14-team auction simulations (27,300 picks) confirmed the stability of the `Mild Iter B` hybrid configuration:
- **Overall Win Rate (#1 Finish)**: **92.0%** (138 / 150 wins)
- **Top-2 Finish Rate**: **98.0%** (147 / 150 drafts finished #1 or #2)
- **Top-3 Finish Rate**: **99.3%** (149 / 150 drafts finished top 3; worst finish was a single #4)
- **Average Power Points**: **87.9 pts** | **Average Unspent Budget**: **\$0.50**
- **Average Category Z-Scores & League Ranks (out of 14 teams)**:
  - `FG%`: **+0.435σ** (Avg Rank: **#1.43**)
  - `PTS`: **+5.042σ** (Avg Rank: **#1.54**)
  - `FT%`: **-0.822σ** (Avg Rank: **#2.37** — high FTM guard volume anchors true team FT%)
  - `AST`: **+2.849σ** (Avg Rank: **#3.94**)
  - `TREB`: **+1.717σ** (Avg Rank: **#4.87**)
  - `STL`: **+1.705σ** (Avg Rank: **#5.38**)
  - `BLK`: **+0.735σ** (Avg Rank: **#5.40**)
  - `3PM`: **+0.963σ** (Avg Rank: **#7.16**)

### 4. New Benchmarking & Forensic Utilities
- `utils/hill_climb.js`: Multi-threaded autonomous hill-climbing runner evaluating candidate hyperparameter sets against a balanced-roster fitness objective.
- `utils/analyze_losses.js`: Forensic loss analyzer that captures exact rosters, bid prices, and category rank differentials for any simulated draft where the bot does not finish #1.
- `utils/simulate_parallel.js`: Enhanced with `--mode=<baseline|dynamic_weights|multi_center|hybrid>`, finish distribution tracking, average category league ranks, top 30 drafted player ROI breakdowns, and full loss logs.

---

## v2.3: Overnight Hill-Climbing — 3PM Floor Prior, Second-Half Deficit Urgency & Live `maxOppBid` Guard (`e171ae4`)

See [`docs/OVERNIGHT_HILL_CLIMB_REPORT.md`](OVERNIGHT_HILL_CLIMB_REPORT.md) for the complete experiment log and 300-draft validation report.

### Key Changes
1. **3PM Floor Prior (`baseTpm = 1.06`) & Tuned Base Priors (`baseFgPct = 1.08`, `baseTreb = 1.10`, `baseBlk = 1.15`)**:
   - Prevents `3PM` from being systematically under-prioritized (`#9.00` in 15-team / 12-slot drafts), lifting average `3PM` rank to `#6.27` (14T/13S) and `#7.57` (15T/12S) without sacrificing `FG%` (`#1.35` / `#1.33`).
2. **Second-Half Deficit Urgency (`lateDeficitBoost = 1.25`)**:
   - Once the draft enters its second half (`picksMade >= Math.floor(rosterSlots * 0.4)`), positive category deficits receive a `1.25x` urgency boost so the solver actively pivots to fill remaining weak categories with mid-tier and endgame picks (`$2–$15`).
3. **Live Draft `maxOppBid` Early-Draft Guard**:
   - In live drafts (`C.teamNamesAll.length < state.numTeams`), unobserved managers who haven't won a player yet are assumed to hold their full starting budget (`state.startingBudget - (rosterSlots - 1)`), preventing premature bid capping on Pick #1.
4. **300-Draft Stress Test Results**:
   - **14-Team / 13-Slot (150 Runs)**: **93.3% 1st Place** (140/150), **99.3% Top-2** (149/150), **100.0% Top-3** (150/150), **88.1 Avg Power Points**.
   - **15-Team / 12-Slot (150 Runs)**: **92.0% 1st Place** (138/150), **98.7% Top-2** (148/150), **99.3% Top-3** (149/150), **93.3 Avg Power Points**.
