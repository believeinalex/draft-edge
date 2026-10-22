# Season Stats Snapshots

Season-to-date player stats, pasted from Yahoo's Players page (stats view, 8-cat columns).

## Updating (start of each session)
1. Paste the Yahoo player-list table into `stats/raw/YYYY-MM-DD.txt` (today's date), exactly as copied. Tabs, repeated `R#` header rows and the extra number in the R# column are all fine.
2. Run `npm run stats`. This parses every raw snapshot into `stats/snapshots/YYYY-MM-DD.json`, copies the newest to `stats/latest.json`, and rebuilds `season/league.json`.
3. Never edit or delete old raw files. They are the history used to track player trends.

## What you get
- `stats/latest.json` / `stats/snapshots/*.json`: one record per player with the Yahoo rank, NBA team, positions, GP, MPG, makes/attempts and percentages, counting stats and Yahoo's value total. Stat columns are **per-game averages**.
- In `season/league.json`, every rostered player gets a `stats` field (`null` if they haven't played). Each team gets `actualTotals`, `actualRoto`, `actualRank` and `gamesPlayed`.
- `npm run season` prints season-to-date roto standings next to the projected ones. It also lists managed-team players with no stats yet and the top unrostered players by Yahoo value, as waiver candidates.

## Caveats
- **Season-to-date roto counts every rostered player's games**, bench and IL included. Yahoo only counts games from active lineup slots, so this approximates the real standings rather than reproducing them.
- **Snapshot coverage:** a snapshot only contains players who have played. Players missing from it (injured, or their team hasn't played yet) have `stats: null`.
- **Name matching:** players are matched to stat lines by accent-insensitive name, and a fuzzy fallback is only accepted when the NBA team also matches. This avoids errors like Cameron Johnson → Chaney Johnson.
- **Duplicate rows:** Yahoo sometimes repeats rows (e.g. Chaney Johnson in the first export), and these are de-duplicated.
- **The `rankNote` field** holds the second number in Yahoo's R# column. Its meaning hasn't been confirmed.
