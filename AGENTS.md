# Draft Edge Workspace Rules

@[CONTEXT.md](./CONTEXT.md)

## Season Mode (post-draft, from 2026-10-18)

The league draft is complete and the project is now focused on in-season management. League ground truth (draft results, rosters, projected standings) is in `season/`; see `season/README.md`. The official league draft is already archived as `drafts/mock_2026-10-19_00-07-.txt`. Never re-run it through the analyzer, because that double-counts it in the empirical prices. The user manages **Shut Up and Jam Gaiden** (their own team, the default focus) and **Finn will cook Burt** (their son Finn's team).

### Session-Start Workflow
- **`main` is the source of truth.** A scheduled task commits a Hashtag Basketball stats snapshot to `main` every morning (12:47 UTC). Start each session with `git pull origin main`, and push season-data changes to `main` (fast-forward; never force-push).
- At session start, also run `npm run injuries` (Yahoo's public injury report, saved to `season/injuries/YYYY-MM-DD.json`; rostered players get `injury: {status, note}` in `league.json`). Check it before lineup or waiver advice.
- At session start, run `npm run fetch-stats` to pull the latest Hashtag Basketball season stats; don't ask the user to paste them. If the fetch fails (network or page change), say so. If the user pastes stats instead, save them verbatim to `stats/raw/YYYY-MM-DD.txt` (never overwrite an older snapshot) and run `npm run stats`.
- When the user pastes Yahoo weekly rosters/lineups (League > Rosters page), save them verbatim to `season/lineups/raw/YYYY-MM-DD.txt` and run `npm run lineups`. Any `WARNING` printed means a transaction is missing from `season/transactions.json`: ask the user for it rather than editing rosters by hand.
- When the user shares Yahoo standings (text or screenshot), save the category totals to `season/standings/YYYY-MM-DD.json` (same shape as the existing files) and run `npm run season`. Prefer these real standings over the estimated `actualRoto` when advising.
- When the user pastes Yahoo transactions, append them to `season/transactions.json` and run `npm run season`.
- Base advice on `season/league.json`: current rosters, projections, season-to-date stats and standings.

## Mandatory Mock Draft Analysis & Price Update Workflow

Whenever the user asks to analyze a mock or live draft export:
1. **Save Input**: Write the raw draft text to `utils/mock.txt` (preserving exact pick formatting so all 13 picks per team match).
2. **Run Official Analyzer & Auto-Pricer**: Run `node utils/analyze_mock.js` (or `npm run analyze`) and/or `node utils/calculate_draft_prices.js` (`npm run prices`). Never pass `--no-update-prices`, and never use ad-hoc analysis scripts in place of `utils/analyze_mock.js`.
3. **Empirical Prices Only (No Yahoo Average)**: Do not use `utils/update_prices.js` or Yahoo average (`Y! AVG`) prices. All `mktCost` values in `players.js` must be driven strictly by empirical mock draft medians from `utils/calculate_draft_prices.js`.
4. **Verify Price Sync**: Confirm in the command output that:
   - `[Auto-Archive]` saved the new draft to `drafts/`.
   - `[Auto-Pricing]` (`utils/calculate_draft_prices.js`) recalculated empirical median/average prices and updated `players.js`, `utils/draft_prices.csv`, and `utils/prices.csv`.
   - Zero picks were accidentally dropped due to formatting typos (check `Notice: X picks could not be matched` and verify any unmatched players are genuinely outside `players.js`).
