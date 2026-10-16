# LePrawn - League Rules & Settings

This document outlines the core rules and settings for the "LePrawn" Yahoo Fantasy Basketball League (League ID#: 45771). These rules serve as the ground truth for our bot's strategy, valuation engine, and simulations.

## Core Draft Details
* **Draft Type:** Live Salary Cap Draft (Auction)
* **Budget:** $200
* **Confirmed League Size:** 15 teams
* **Scoring Type:** Rotisserie (Roto)
* **Stat Categories (8-Cat):**
  * Field Goal Percentage (FG%)
  * Free Throw Percentage (FT%)
  * 3-point Shots Made (3PTM)
  * Points Scored (PTS)
  * Total Rebounds (REB)
  * Assists (AST)
  * Steals (ST)
  * Blocked Shots (BLK)

## Roster Settings
**Total Drafted Roster Size:** 12 players per team (180 total players drafted league-wide)
* **Active Slots (9):** PG, SG, SF, PF, C, Util, Util, Util, Util (75% of total roster active weekly)
* **Bench Slots (3):** BN, BN, BN (Down from 4 — severe bench squeeze)
* **Injury Slots (2):** IL, IL (Not drafted)

## Key Strategic Implications for the Bot
1. **15-Team Pool Depth (180 Players):** With 15 teams × 12 slots, 180 total players are drafted. The talent threshold remains deep, but league dollars per drafted player increase from $15.38 to $16.67 (+$1.29/player, or ~9% inflation in spendable discretionary cash per player: $188 / 12 = $15.67 vs $187 / 13 = $14.38).
2. **The Triple Squeeze (Weekly Lock + 18 Max Moves + 3 Bench Spots):**
   * Roster changes lock **Weekly on Monday**. Daily streaming is impossible.
   * **Max 18 acquisitions for the entire season**: Averaging ~0.8 moves per week across 22 weeks. The drafted team is essentially your roster for the entire year.
   * **Only 3 Bench spots to cover 9 starting positions**: You cannot afford to stash zero-production flyers, long-term injured players, or single-position specialists who cause lineup gridlock.
3. **Multi-Position Eligibility is King:** With only 3 bench spots, players with dual and triple eligibility (PG/SG, SG/SF, SF/PF, PF/C) are vital to ensure 9 active starters can be fielded regardless of weekly NBA scheduling variations and short-term injuries.
4. **Positional Requirements & Multi-Center Enforcement:** While we only strictly need 1 PG, 1 SG, 1 SF, 1 PF, and 1 C, the 4 Util spots offer flexibility. Our Hybrid Engine enforces a **6-slot (`PG, SG, SF, PF, C1, C2`) Knapsack DP bitmask** paired with dynamic category deficit weighting (typically drafting ~3.8–4.2 center-eligible players) to protect against injury and dominate interior categories (`FG%`, `TREB`, `BLK`).
5. **15-Team Roto Point Spreads (1–15 pts):** A last-place finish in any category yields only 1 point, creating a punishing 14-point deficit against category leaders (compared to 13 points in 14-team format). Punting is significantly more dangerous in a 15-team format; balanced, high-floor profiles that place top-6 in 6+ categories reliably win the league.
6. **Turnovers (TO) are NOT a category:** Standard 8-cat roto boosts high-usage playmaking anchors (Luka Doncic, Shai Gilgeous-Alexander, Trae Young, James Harden) without punishing high turnover totals.

## Draft Timers
* **Nomination Time:** 30 seconds
* **Bid Time:** 20 seconds
