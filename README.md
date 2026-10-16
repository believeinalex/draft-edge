# Draft Edge Live Sync (Chrome Extension)

A Chrome extension that integrates directly into the Yahoo Fantasy Basketball live auction draft room (`*://*.fantasysports.yahoo.com/*`). It monitors draft picks in real time, calculates dynamic inflation, tracks team budgets, and provides live valuation and maximum bid recommendations powered by the Draft Edge model.

---

## Features

- **Live Yahoo Pick Detection**:
  - **Dual Scrapers**: Reads live pick feeds from both the Yahoo **Queue side-panel** and the **Board tab** (ensuring full draft history is preserved even after page refreshes).
  - **Auto-Nomination Sync**: Detects the player currently up for auction and automatically populates the price checker.
  - **Auto & Manual Pick Logging**: Picks are automatically logged with an `auto` tag and a one-click undo (`×`), with manual logging for edge cases.
- **Real-Time Valuation & Inflation**:
  - Re-computes player values dynamically as league money and talent pool shift.
  - Displays dollar-for-dollar inflation multipliers and remaining league dollars.
- **Position-Aware Maximum Bid Solver**:
  - Uses an exact position-aware knapsack algorithm (`checkPrice()`) to compute the maximum recommended bid for any player on your specific roster.
- **Power Rankings & Category Weights**:
  - Live projected standings across all categories.
  - Customizable category weight sliders to adjust valuations according to your punt strategies.
- **League Setup Popup**:
  - Configure number of teams, roster slots, total budget, and your team name via the extension popup.

---

## Installation (Load Unpacked)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click **Load unpacked**.
5. Select the repository directory (`Edge2`).

---

## Usage

1. **Configure League**: Click the extension icon in the toolbar to set your league size (e.g., 15 teams), budget ($200), roster slots (12), and your exact team name.
2. **Join Yahoo Draft**: Open your Yahoo Fantasy Basketball live auction draft room.
3. **Overlay Control**: The Draft Edge overlay will render automatically in the live draft room.
4. **Draft Tracking**: Picks will auto-log as players are won. Open the **Board tab** at least once if rejoining mid-draft to sync past pick history.

---

## File Overview

- [manifest.json](file:///c:/Users/swarm/Downloads/Edge2/manifest.json) — Chrome Extension Manifest (v3).
- [content.js](file:///c:/Users/swarm/Downloads/Edge2/content.js) — Yahoo DOM scrapers, MutationObserver, live pick detection, and floating overlay UI.
- [engine.js](file:///c:/Users/swarm/Downloads/Edge2/engine.js) — Valuation algorithms, inflation calculations, knapsack max-bid math, and power rankings.
- [players.js](file:///c:/Users/swarm/Downloads/Edge2/players.js) — 200-player 2026-27 projection & valuation dataset.
- [overlay.css](file:///c:/Users/swarm/Downloads/Edge2/overlay.css) — Styling for the in-page floating draft overlay.
- [popup.html](file:///c:/Users/swarm/Downloads/Edge2/popup.html) / [popup.js](file:///c:/Users/swarm/Downloads/Edge2/popup.js) — Extension popup for league settings management.


## Analysis Utilities

This repository includes built-in tools for testing and historical draft tracking:
- **Draft Simulation**: Run \
ode utils/simulate_parallel.js --runs=30\ to test the engine's win rate against automated opponents in a Monte Carlo environment.
- **Mock Draft Analysis**: Paste raw draft results into \utils/mock.txt\ and run \
ode utils/analyze_mock.js\. This will generate a power ranking report, automatically archive the draft to the \drafts/\ folder, and print a historical analysis of all your tracked drafts to show your average win rate and most profitable players over time.
