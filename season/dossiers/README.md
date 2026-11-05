# Player dossiers

One Markdown file per player in `players/`, holding dated, sourced notes from podcasts, articles, beat reporters and other sources. Read a player's dossier before giving lineup, waiver or trade advice on them. `INDEX.md` lists every dossier with its current fantasy team, note count and latest note, plus every source file. It is generated, so don't edit it by hand.

## Adding a source (e.g. a podcast transcript)

1. Save the text **verbatim** to `sources/YYYY-MM-DD_<show-slug>.txt`. Use the episode's air or publish date, not the date it was pasted. Add a suffix if a show has two episodes on one day (`_2`). Never overwrite an existing source file. If the paste doesn't say the show, episode or date, ask.
2. Pull out every claim about a specific player that could matter for fantasy: role, minutes, usage, rotation changes, injuries and timelines, coach quotes, trade rumours, schedule, buy/sell calls. Skip generic chatter. Notes about one team's rotation go on each player they affect. For example, "X is out, so Y and Z start" goes on X, Y and Z.
3. Add a note to each player's file under `## Notes`, **newest first** (by source date). Run `npm run dossiers -- "Player Name"` first if the player has no file yet.
4. Update that player's `## Current take` whenever the new notes change the picture. It's a short synthesis of the notes so far, with conflicts called out and the most recent, best-sourced view weighted highest.
5. Run `npm run dossiers` to rebuild `INDEX.md` and check formatting. Fix any `WARNING` it prints.

## Note format

```markdown
### 2026-11-04 · Locked On Thunder: "Caruso's back, now what?"
Source: sources/2026-11-04_locked-on-thunder.txt
Tags: role, minutes
- **Reported:** Daigneault said Caruso has no minutes limit (quoting post-game presser, Nov 3).
- **Analysis:** Host expects Ajay Mitchell's minutes to drop from ~30 to low 20s.
- **Stat:** Mitchell 6.1 FGA per game in the 3 games Caruso played vs 12.4 without him.
- **Speculation:** Host floats Mitchell as a trade chip before the deadline.
```

- The heading is `### YYYY-MM-DD · Source name: episode or article title`, where the date is the source's date.
- `Source:` (path to the saved source file) and `Tags:` lines are optional. Tags that work well: `role`, `minutes`, `usage`, `injury`, `rotation`, `trade`, `schedule`, `shooting`, `defense`, `outlook`.
- Label every bullet so facts and opinions stay apart:
  - **Reported:** news from the team, coach or a beat reporter. Name who said it when the source does.
  - **Analysis:** the host's or writer's own read.
  - **Stat:** a number the source cites.
  - **Speculation:** rumours and guesses.
- Keep the source's meaning and hedges ("I think", "I've heard"). Don't upgrade an opinion into a fact. Add timestamps (`[42:10]`) when the transcript has them.

## Uses

- `npm run report` lists the managed teams' dossier notes from the last 7 days under "Dossier notes".
- `npm run dossiers` with no player name also creates empty stubs for every player on both managed rosters.
