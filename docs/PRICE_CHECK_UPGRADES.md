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

## Future Tweak Recommendations
If you wish to attempt further tweaks based on real-world draft performance:
1. **Adjust the Roto-Curve Floor:** Currently set to `0.6`. Lowering it (e.g., `0.3`) will make the bot more aggressive in punting categories. Raising it (e.g., `0.8`) will make the bot more balanced.
2. **Re-visit Positional Scarcity:** If you find the bot misses out on top-tier Point Guards or Centers, you could implement a softer, linear positional scarcity multiplier instead of the exponential one we reverted.
3. **Draft-Stage Transitions:** You could dynamically lower the Roto-Curve floor as the draft progresses (e.g., strict balance in the first 50 picks, heavy punting in the last 50 picks).
