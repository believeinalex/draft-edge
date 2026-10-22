# Draft Edge Workspace Rules

@[CONTEXT.md](./CONTEXT.md)

## Season Mode (post-draft, from 2026-10-18)

The league draft is complete and the project is now focused on in-season management. League ground truth (draft results, rosters, projected standings) is in `season/`; see `season/README.md`. The official league draft is already archived as `drafts/mock_2026-10-19_00-07-.txt`. Never re-run it through the analyzer, because that double-counts it in the empirical prices.

## Mandatory Mock Draft Analysis & Price Update Workflow

Whenever the user asks to analyze a mock or live draft export:
1. **Save Input**: Write the raw draft text to `utils/mock.txt` (preserving exact pick formatting so all 13 picks per team match).
2. **Run Official Analyzer & Auto-Pricer**: Run `node utils/analyze_mock.js` (or `npm run analyze`) and/or `node utils/calculate_draft_prices.js` (`npm run prices`). Never pass `--no-update-prices`, and never use ad-hoc analysis scripts in place of `utils/analyze_mock.js`.
3. **Empirical Prices Only (No Yahoo Average)**: Do not use `utils/update_prices.js` or Yahoo average (`Y! AVG`) prices. All `mktCost` values in `players.js` must be driven strictly by empirical mock draft medians from `utils/calculate_draft_prices.js`.
4. **Verify Price Sync**: Confirm in the command output that:
   - `[Auto-Archive]` saved the new draft to `drafts/`.
   - `[Auto-Pricing]` (`utils/calculate_draft_prices.js`) recalculated empirical median/average prices and updated `players.js`, `utils/draft_prices.csv`, and `utils/prices.csv`.
   - Zero picks were accidentally dropped due to formatting typos (check `Notice: X picks could not be matched` and verify any unmatched players are genuinely outside `players.js`).
