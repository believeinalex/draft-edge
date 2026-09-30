# LePrawn - League Rules & Settings

This document outlines the core rules and settings for the "LePrawn" Yahoo Fantasy Basketball League (League ID#: 45771). These rules serve as the ground truth for our bot's strategy, valuation engine, and simulations.

## Core Draft Details
* **Draft Type:** Live Salary Cap Draft (Auction)
* **Budget:** $200
* **Max Teams:** 18 (Expected Draft Size: 14)
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
**Total Drafted Roster Size:** 13 players
* **Active Slots (9):** PG, SG, SF, PF, C, Util, Util, Util, Util
* **Bench Slots (4):** BN, BN, BN, BN
* **Injury Slots (2):** IL, IL (Not drafted)

## Key Strategic Implications for the Bot
1. **14-Team Depth:** With 14 teams and 13 drafted players per team, exactly **182 players** will be drafted. This is slightly deeper than a standard 12-team league, increasing the value of late-round contributors.
2. **Weekly Lineups & Positional Limits:** Roster changes lock **Weekly on Monday**. This means flexibility and maximizing games played via daily streaming is not possible. You must start a valid lineup for the whole week.
3. **Strict Acquisition Limit:** **Max 18 acquisitions for the ENTIRE SEASON**. This is the most critical setting. It means "streaming" (picking up players for a few games and dropping them) is completely unviable. The team drafted is largely the team you will have all year. Drafted depth and avoiding injury-prone players becomes exponentially more valuable.
4. **Positional Requirements:** While we only strictly need 1 PG, 1 SG, 1 SF, 1 PF, and 1 C, the 4 Util spots offer a lot of flexibility. However, only drafting 1.9 Centers (like the bot currently does) might lead to issues if that Center gets injured, especially with weekly locks and extremely limited waiver wire pickups.
5. **Turnovers (TO) are NOT a category:** The league uses standard 8-cat, not 9-cat. High usage guards who turn the ball over frequently (like Trae Young, Luka Doncic) get a significant value boost in this format.

## Draft Timers
* **Nomination Time:** 30 seconds
* **Bid Time:** 20 seconds
