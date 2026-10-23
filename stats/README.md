# Season Stats Snapshots

Season-to-date player stats from [Hashtag Basketball's rankings](https://hashtagbasketball.com/fantasy-basketball-rankings), using our league's 8 categories (TO off), Standard (roto) valuation, all players, per-game averages.

## Updating (start of each session)
- **Automatic:** run `npm run fetch-stats`. It fetches today's rankings into `stats/raw/YYYY-MM-DD.txt` (US Eastern date), parses every snapshot and rebuilds `season/league.json`. If today's file already exists it is kept. Pass `-- --force` to replace it, or `-- --date=YYYY-MM-DD` to name it.
- **Manual fallback:** paste the rankings table into `stats/raw/YYYY-MM-DD.txt` exactly as copied, then run `npm run stats`. Tabs, repeated `R#` header rows and the rank-movement number are all fine.
- Never edit or delete old raw files. They are the history used to track player trends.

The fetcher (`stats/fetch_htb.js`) posts the page's ASP.NET form back with our settings (show all, TO unchecked, Standard values, current season, averages), then writes the table in the same text format as a paste. It needs outbound access to `hashtagbasketball.com`. In the cloud container, Node needs `NODE_USE_ENV_PROXY=1`, which the npm script sets.

## What you get
- `stats/latest.json` / `stats/snapshots/*.json`: one record per player with the Hashtag rank, rank movement, NBA team, positions, GP, MPG, makes/attempts and percentages, counting stats and the value total (`valueTotal`). Stat columns are **per-game averages**.
- In `season/league.json`, every rostered player gets a `stats` field (`null` if they haven't played). Each team gets `actualTotals`, `actualRoto`, `actualRank` and `gamesPlayed`.
- `npm run season` prints season-to-date roto standings next to the projected ones. It also lists managed-team players with no stats yet and the top unrostered players by value, as waiver candidates. `npm run value` prints booms and busts against draft prices.

## Caveats
- **Season-to-date roto counts every rostered player's games**, bench and IL included. Yahoo only counts games from active lineup slots, so this approximates the real standings rather than reproducing them.
- **Snapshot coverage:** a snapshot only contains players who have played. Players missing from it (injured, or their team hasn't played yet) have `stats: null`.
- **Name matching:** players are matched to stat lines by accent-insensitive name, and a fuzzy fallback is only accepted when the NBA team also matches. This avoids errors like Cameron Johnson → Chaney Johnson.
- **Duplicate rows:** the table sometimes repeats rows (e.g. Chaney Johnson on Oct 22), and these are de-duplicated.
- **`rankMove`** is the rank movement since Hashtag's previous update. Fetched snapshots are signed (`+2` = up two places). Pasted ones lose the arrow (`rankMoveSigned: false`).
- **Page changes:** the fetcher scrapes a web page, so a Hashtag redesign can break it. It fails loudly (table not found, or the TO column still present) rather than saving bad data. Fall back to pasting.
