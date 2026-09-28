# Draft Edge Live Sync (Chrome extension) — WIP

Not ready to load yet — pick-detection selectors still need a real-DOM test pass
against a live Yahoo draft room. Once that's done this will be delivered as a
zip with load-unpacked instructions.

## What's built
- `engine.js` — the valuation math, ported line-for-line from the Draft Edge
  artifact's `computeAll()` and `checkPrice()` (exact position-aware knapsack),
  generalized to key teams by name string instead of a fixed index.
- `players.js` — the same 200-player 2026-27 projection dataset Draft Edge uses.
- `content.js` — overlay UI + pick-detection adapter (MutationObserver-based,
  currently running the generic fallback scanner since real selectors aren't
  filled in yet — see `YAHOO_SELECTORS` at the top of the detection section).
- `popup.html`/`popup.js` — league setup (teams, roster slots, budget, your
  team name) stored in `chrome.storage.local`.

## Verified so far (Node, outside the browser)
- `computeAll` / `checkPrice` run correctly against a fabricated draft state
  (budget, inflation, position alerts, power rankings, max-bid math all sane).
- Name matching handles the known Yahoo abbreviation cases (Nic Claxton →
  Nicolas Claxton, etc.) and returns null (not a crash) on an unmatched name.

## Still needed
1. Real DOM inspection of a live Yahoo draft room to fill in `YAHOO_SELECTORS`
   in `content.js` and confirm the generic fallback even fires.
2. Load-unpacked test in Chrome against that live/mock draft.
3. Package as a zip for delivery.
