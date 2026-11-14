const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { normName, CATS } = require('../engine.js');
const { rotoPoints } = require('./build_season.js');
const { buildTradeWatch, tradeWatchMarkdown, moveWatchesFor, moveWatchMarkdown, loadWatches } = require('./trade_watch.js');
const { fetchSchedule, movesLeft, simulateSeason, seasonOddsMarkdown } = require('./season_sim.js');
const { applyFocus } = require('./focus.js');
const { fetchDay, addDays } = require('./boxscores.js');

/**
 * Morning report, four sections: top performers and stinkers (any team), how both managed
 * teams played vs projection, projected standings (tonight and end of week), injury updates, plus a FOMO watch
 * of tracked trades (season/trade_watch.json) and rest-of-season odds (season/season_sim.js). Writes reports/YYYY-MM-DD.md and prints it.
 *
 * Inputs (all already in the repo after `npm run fetch-stats` + `npm run injuries`):
 * - stats/snapshots: the two latest snapshots. Their difference is last night's box score.
 * - season/league.json: ownership, this week's locked lineup (thisWeek) and injuries.
 * - season/standings: the latest real Yahoo standings, the base for the projection.
 * - season/injuries: the two latest reports, compared to find new, changed and cleared injuries.
 * - Tonight's schedule from ESPN's public scoreboard.
 * - season/open_questions.md: unchecked questions due on or before today are listed for answering.
 *
 * Usage: node season/morning_report.js   (npm run report)
 * In the cloud container, run with NODE_USE_ENV_PROXY=1 (the npm script does).
 */

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports');
const COUNT = ['tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const ESPN_TEAM = { WAS: 'WSH', SAS: 'SA', NOP: 'NO', NYK: 'NY', GSW: 'GS', UTA: 'UTAH', PHO: 'PHX' };
// Share of a game a player is expected to play, by Yahoo injury status
const PLAY_WEIGHT = { O: 0, D: 0, INJ: 0, SUSP: 0, Q: 0.5, GTD: 0.5, DTD: 0.5, P: 0.9 };
const INACTIVE_SLOTS = new Set(['BN', 'IL', 'IL+', 'NA']);

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
// Matches a team by its current name or a name it had earlier (league.json previousNames)
const findTeam = (league, name) => league.teams.find(t => t.name === name || (t.previousNames || []).includes(name));

function datedFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => path.join(dir, f));
}
// Unchecked "- [ ]" items under "## YYYY-MM-DD" headings dated on or before `today`
function dueQuestions(today, file = path.join(__dirname, 'open_questions.md')) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  let date = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const h = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (h) { date = h[1]; continue; }
    if (/^#/.test(line)) { date = null; continue; }
    const q = line.match(/^- \[ \]\s+(.*)/);
    if (q && date && date <= today) out.push({ date, text: q[1] });
  }
  return out;
}

// REPORT_DATE=YYYY-MM-DD overrides today (for checking the end-of-week projection mid-week)
const etDate = (d = new Date()) => process.env.REPORT_DATE || d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const mondayOf = iso => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

// Per-game z-score of a stat line against the draft pool (top 180 projections), so a
// single game can be compared with a player's projected game on one scale. Percentages
// use volume-weighted impact: makes above (or below) a league-average shooter.
function buildScorer() {
  const pool = [...PLAYERS].sort((a, b) => a.rk - b.rk).slice(0, 180);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))) || 1; };
  const fgAvg = pool.reduce((s, p) => s + p.fgm, 0) / pool.reduce((s, p) => s + p.fga, 0);
  const ftAvg = pool.reduce((s, p) => s + p.ftm, 0) / pool.reduce((s, p) => s + p.fta, 0);
  const fgI = p => p.fgm - fgAvg * p.fga, ftI = p => p.ftm - ftAvg * p.fta;
  const stats = {
    fg: { m: mean(pool.map(fgI)), s: sd(pool.map(fgI)) },
    ft: { m: mean(pool.map(ftI)), s: sd(pool.map(ftI)) }
  };
  for (const c of COUNT) stats[c] = { m: mean(pool.map(p => p[c])), s: sd(pool.map(p => p[c])) };
  return line => ((fgI(line) - stats.fg.m) / stats.fg.s) + ((ftI(line) - stats.ft.m) / stats.ft.s) +
    COUNT.reduce((s, c) => s + ((line[c] || 0) - stats[c].m) / stats[c].s, 0);
}

// Box-score lines for games played between two snapshots (season totals differenced)
function gameLines(prev, cur) {
  const before = new Map(prev.players.map(p => [normName(p.name), p]));
  const lines = new Map();
  const keys = ['fgm', 'fga', 'ftm', 'fta', ...COUNT];
  for (const p of cur.players) {
    const b = before.get(normName(p.name));
    const games = p.gp - (b ? b.gp : 0);
    if (games <= 0) continue;
    const line = { name: p.name, nbaTeam: p.nbaTeam, games, mpg: p.mpg };
    // Snapshots hold per-game averages rounded to 0.1, so differenced totals carry noise;
    // box-score stats are whole numbers, so round (and never go below zero)
    for (const k of keys) line[k] = Math.max(0, Math.round(p[k] * p.gp - (b ? b[k] * b.gp : 0)));
    lines.set(normName(p.name), line);
  }
  return lines;
}

// Each team's active players this week, read straight from the locked lineup snapshot.
// Yahoo keeps counting a player for the team whose locked lineup he's in until the next
// lock, even after a mid-week trade or drop, so ownership is deliberately ignored here.
// A cut-off lineup paste is filled from the team's best-projected drafted players.
function activeLineups(league, lineupSnap, projByName) {
  const out = new Map();
  if (!lineupSnap) return out;
  const allNames = league.teams.flatMap(t => t.roster.map(r => r.name).concat(t.pendingOut || []));
  const fullName = name => {
    const m = name.match(/^([A-Za-z])\.\s+(.+)$/);
    if (!m) return name;
    return allNames.find(n => { const k = normName(n); return k.startsWith(m[1].toLowerCase()) && k.endsWith(' ' + normName(m[2])); }) || name;
  };
  const inferred = league.teams.find(t => t.lineup && t.lineup.teamNameInferred);
  for (const block of lineupSnap.teams) {
    const teamName = block.team || (inferred && inferred.name);
    const t = findTeam(league, teamName);
    if (!t) continue;
    let active = block.players.filter(p => !INACTIVE_SLOTS.has(p.slot)).map(p => ({ ...p, name: fullName(p.name) }));
    let estimated = false;
    if (block.players.length < 9) {
      const listed = new Set(block.players.map(p => normName(fullName(p.name))));
      const extra = t.roster.filter(r => !listed.has(normName(r.name)) && r.acquired === 'draft')
        .sort((a, b) => ((projByName.get(normName(b.name)) || {}).totalZ ?? -99) - ((projByName.get(normName(a.name)) || {}).totalZ ?? -99));
      active = active.concat(extra.slice(0, 9 - active.length));
      estimated = true;
    }
    out.set(t.name, { players: active, estimated });
  }
  return out;
}

async function tonightsSchedule(dateIso) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateIso.replace(/-/g, '')}`);
  if (!res.ok) throw new Error(`ESPN scoreboard -> ${res.status}`);
  const teams = new Set();
  for (const e of (await res.json()).events || []) {
    if (e.status && e.status.type && e.status.type.state === 'post') continue; // already final
    for (const c of e.competitions[0].competitors) teams.add(c.team.abbreviation);
  }
  return teams;
}

const fmtLine = l => `${l.pts}p ${l.treb}r ${l.ast}a ${l.stl}s ${l.blk}b ${l.tpm} 3s, ${l.fgm}/${l.fga} FG, ${l.ftm}/${l.fta} FT`;
const fmtPct = v => v.toFixed(3).replace(/^0/, '');

async function main() {
  const today = etDate();
  const league = readJson(path.join(__dirname, 'league.json'));
  const focus = applyFocus(league); // REPORT_TEAMS: report on other teams, written to suffixed files
  const projByName = new Map(PLAYERS.map(p => [normName(p.name), p]));
  const owner = new Map();
  for (const t of league.teams) for (const r of t.roster) owner.set(normName(r.name), t.name);
  const tag = name => {
    const o = owner.get(normName(name));
    return o === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(o) ? ` **${league.managedLabel || '(Finn)'}**` : o ? ` (${o})` : ' (FA)';
  };
  const score = buildScorer();
  const md = [];
  const warn = [];
  let standingsJson = null;

  // 1. Last night
  const snaps = datedFiles(path.join(ROOT, 'stats', 'snapshots'));
  const cur = readJson(snaps[snaps.length - 1]);
  const prev = snaps.length > 1 ? readJson(snaps[snaps.length - 2]) : null;
  md.push(`# Morning report — ${today}`, '');
  md.push(`Stats snapshot ${cur.asOf}${prev ? ` vs ${prev.asOf}` : ''}; standings ${league.standingsAsOf || 'none'}; injuries ${league.injuriesAsOf || 'none'}; lineups ${league.lineupAsOf || 'none'}.`, '');
  if (league.lineupAsOf && mondayOf(league.lineupAsOf) !== mondayOf(today)) {
    warn.push(`The latest locked lineup (${league.lineupAsOf}) is from an earlier week. Paste this week's Yahoo rosters so the projection uses the right active players.`);
  }

  const lines = prev ? gameLines(prev, cur) : new Map();
  const lineupFiles = datedFiles(path.join(__dirname, 'lineups'));
  const active = activeLineups(league, lineupFiles.length ? readJson(lineupFiles[lineupFiles.length - 1]) : null, projByName);
  const activeKey = new Map();
  for (const [team, a] of active) for (const r of a.players) activeKey.set(normName(r.name), team);

  const injFiles = datedFiles(path.join(__dirname, 'injuries'));
  const injBy = new Map((injFiles.length ? readJson(injFiles[injFiles.length - 1]).players : []).map(p => [normName(p.name), p]));
  const rated = [];
  for (const [key, l] of lines) {
    const proj = projByName.get(key);
    if (!proj) continue; // players outside the projection pool can't be compared with a projection
    const per = { ...l };
    for (const k of ['fgm', 'fga', 'ftm', 'fta', ...COUNT]) per[k] = l[k] / l.games;
    const gameZ = score(per), projZ = score(proj);
    rated.push({ ...l, key, delta: (gameZ - projZ) * l.games, gameZ, projZ, counted: activeKey.has(key) });
  }
  rated.sort((a, b) => b.delta - a.delta);
  const sgn = v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  const row = r => {
    const team = activeKey.get(r.key);
    const note = !team ? ' *(not in an active lineup)*' : team !== owner.get(r.key) ? ` *(counts for ${team} this week)*` : '';
    return `| ${r.name}${tag(r.name)}${note} | ${fmtLine(r)} | ${sgn(r.delta)} |`;
  };
  md.push('## Top performers and stinkers (any team, free agents too)', '');
  if (!rated.length) {
    md.push('No games between the last two snapshots.', '');
  } else {
    md.push(`Games in snapshot ${cur.asOf}. "vs proj" is the game's 8-cat z-score minus the player's projected per-game z-score.`, '');
    md.push('**Top performers**', '', '| Player | Line | vs proj |', '|---|---|---|', ...rated.slice(0, 8).map(row), '');
    md.push('**Stinkers**', '', '| Player | Line | vs proj |', '|---|---|---|', ...rated.slice(-8).reverse().map(row), '');
  }

  md.push(focus ? `## How ${league.managedTeams.join(' and ')} played vs projection` : '## How your two teams played vs projection', '');
  for (const tn of league.managedTeams || []) {
    const t = findTeam(league, tn);
    // Lineup first: a player traded mid-week still counts for his locked-lineup team until the next lock
    const mine = rated.filter(r => (activeKey.get(r.key) || owner.get(r.key)) === tn);
    const playedKeys = new Set(lines.keys());
    const dnp = (t ? t.roster : []).filter(r => !playedKeys.has(normName(r.name))).map(r => {
      const i = injBy.get(normName(r.name));
      return `${r.name}${i ? ` (${i.status}${i.note ? `: ${i.note}` : ''})` : ''}`;
    });
    const net = mine.filter(r => r.counted).reduce((s, r) => s + r.delta, 0);
    md.push(`**${tn}** — ${mine.length} played, net ${sgn(net)} vs projection (active players only)`, '');
    if (mine.length) md.push('| Player | Line | vs proj |', '|---|---|---|', ...mine.map(row), '');
    md.push(`Did not play (no game, injury or rest): ${dnp.length ? dnp.join(', ') : 'none'}`, '');
  }

  // 2. Injuries: changes since the previous report
  const injMd = [];
  injMd.push('## Injury updates', '');
  if (injFiles.length < 2) {
    injMd.push('Need two injury reports to compare; only one so far.', '');
  } else {
    const [a, b] = injFiles.slice(-2).map(readJson);
    const was = new Map(a.players.map(p => [normName(p.name), p]));
    const now = new Map(b.players.map(p => [normName(p.name), p]));
    const changes = [];
    for (const [k, p] of now) {
      if (!owner.has(k)) continue;
      const o = was.get(k);
      if (!o) changes.push(`- **New:** ${p.name}${tag(p.name)} — ${p.status} (${p.note})`);
      else if (o.status !== p.status) changes.push(`- **Changed:** ${p.name}${tag(p.name)} — ${o.status} → ${p.status} (${p.note})`);
    }
    for (const [k, o] of was) {
      if (owner.has(k) && !now.has(k)) changes.push(`- **Cleared:** ${o.name}${tag(o.name)} — was ${o.status} (${o.note})`);
    }
    injMd.push(`Comparing ${a.asOf} → ${b.asOf}.`, '', ...(changes.length ? changes : ['No changes for rostered players.']), '');
    for (const tn of league.managedTeams || []) {
      const t = league.teams.find(x => x.name === tn);
      const hurt = t.roster.filter(r => now.has(normName(r.name))).map(r => `${r.name} ${now.get(normName(r.name)).status}`);
      injMd.push(`- ${tn}: ${hurt.length ? hurt.join(', ') : 'no injuries'}`);
    }
    injMd.push('');
  }

  // 3. Projected standings: tonight and end of week
  md.push('## Projected standings: tonight and end of week', '');
  const stFiles = datedFiles(path.join(__dirname, 'standings'));
  if (!stFiles.length) {
    md.push('No Yahoo standings saved yet.', '');
  } else {
    // Standings copied while games were still being played are marked complete: false and
    // skipped; the base is the latest complete standings, and later games are rebuilt
    // from player stats (validated to match Yahoo within rounding).
    const stAll = stFiles.map(readJson);
    const st = [...stAll].reverse().find(x => x.complete !== false) || stAll[stAll.length - 1];
    const skipped = stAll.filter(x => x.asOf > st.asOf && x.complete === false).map(x => x.asOf);
    if (skipped.length) warn.push(`Skipped standings ${skipped.join(', ')}: copied while games were still in progress.`);
    let base = st.teams.map(r => ({ ...r, team: (findTeam(league, r.team) || { name: r.team }).name }));
    if (st.asOf < cur.asOf) {
      const emptyX = () => ({ gp: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 });
      const extra = new Map();
      const addLine = (team, l) => {
        const e = extra.get(team) || emptyX();
        e.gp += l.games;
        for (const c of Object.keys(e)) if (c !== 'gp') e[c] += l[c];
        extra.set(team, e);
      };
      // Exact ESPN box scores for each game day since the base standings, credited to the team
      // whose locked lineup (that week's) holds the player. Falls back to differencing the
      // rounded season snapshots if ESPN can't be reached or a game day isn't final.
      let exact = false;
      try {
        const lineupFor = d => {
          const wk = mondayOf(d);
          const same = lineupFiles.filter(f => mondayOf(path.basename(f, '.json')) === wk);
          const f = same.length ? same[same.length - 1] : [...lineupFiles].reverse().find(f => path.basename(f, '.json') <= d) || lineupFiles[lineupFiles.length - 1];
          return f;
        };
        const keyCache = new Map();
        const keysFor = f => {
          if (!keyCache.has(f)) {
            const m = new Map();
            for (const [team, a] of activeLineups(league, readJson(f), projByName)) for (const r of a.players) m.set(normName(r.name), team);
            keyCache.set(f, m);
          }
          return keyCache.get(f);
        };
        if (!lineupFiles.length) throw new Error('no lineup snapshots');
        const staged = [];
        for (let d = st.asOf; d < cur.asOf; d = addDays(d, 1)) {
          const day = await fetchDay(d);
          if (!day.complete) throw new Error(`games on ${d} aren't all final yet`);
          const keys = keysFor(lineupFor(d));
          for (const pl of day.players) {
            const team = keys.get(normName(pl.name));
            if (team) staged.push([team, pl]);
          }
        }
        for (const [team, pl] of staged) addLine(team, pl);
        exact = true;
      } catch (e) {
        extra.clear();
        warn.push(`Couldn't use ESPN box scores (${e.message}); games since the base standings are differenced from the rounded stat snapshots instead, so rank points can be off by a point or two.`);
        const since = snaps.map(readJson).filter(sn => sn.asOf >= st.asOf);
        for (let i = 1; i < since.length; i++) {
          for (const [k, l] of gameLines(since[i - 1], since[i])) {
            const team = activeKey.get(k);
            if (team) addLine(team, l);
          }
        }
      }
      warn.push(`Base standings ${st.asOf}; games since then (through ${exact ? 'ESPN box scores for ' + addDays(cur.asOf, -1) : 'stats ' + cur.asOf}) are rebuilt ${exact ? 'exactly from box scores' : 'from player stats'} and locked lineups. Paste standings each morning, after every game has finished, for an exact base.`);
      base = base.map(r => ({ ...r, _extra: extra.get(r.team) }));
    }

    let tonight = new Set();
    try { tonight = await tonightsSchedule(today); } catch (e) { warn.push(`Couldn't load tonight's schedule: ${e.message}`); }
    // Remaining days of this Monday-to-Sunday week (today included): who plays on each
    const weekStart = new Date(mondayOf(today) + 'T12:00:00Z').getTime();
    const days = [...Array(7).keys()].map(i => new Date(weekStart + i * 864e5).toISOString().slice(0, 10)).filter(d => d >= today);
    const sched = new Map([[today, tonight]]);
    for (const d of days.slice(1)) {
      try { sched.set(d, await tonightsSchedule(d)); } catch (e) { sched.set(d, new Set()); warn.push(`Couldn't load the ${d} schedule, so end of week is understated: ${e.message}`); }
    }
    const injNow = new Map([...injBy].map(([k, p]) => [k, p.status]));
    // ESPN expected-return dates (latest digest) let an "out" player count again once he's due back
    const newsFiles = datedFiles(path.join(__dirname, 'news'));
    const retDate = new Map();
    if (newsFiles.length) {
      const nj = readJson(newsFiles[newsFiles.length - 1]);
      for (const i of nj.injuries || []) if (i.returnDate) retDate.set(normName(i.name), i.returnDate.slice(0, 10));
      if (nj.asOf < today) warn.push(`Expected-return dates come from the ${nj.asOf} news digest.`);
    }
    // Share of a game expected on day d: injury weight, but an out player counts at 0.7 from his ESPN return date
    const playWeight = (k, d) => {
      const w = PLAY_WEIGHT[injNow.get(k)] ?? 1;
      return w === 0 && retDate.has(k) && d >= retDate.get(k) ? 0.7 : w;
    };
    const statLine = new Map(cur.players.map(p => [normName(p.name), p]));

    const teams = base.map(r => {
      const a = active.get(r.team) || { players: [], estimated: false };
      // Shot volume so far, estimated from active players' season lines (scaled to Yahoo GP)
      let fga = 0, fta = 0, gp = 0;
      for (const p of a.players) {
        const s = statLine.get(normName(p.name));
        if (s) { fga += s.fga * s.gp; fta += s.fta * s.gp; gp += s.gp; }
      }
      // Attempts behind the base standings' percentages, estimated from the active players'
      // season lines scaled to the base's games played
      const x = r._extra || { gp: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
      const scale = gp ? r.gp / gp : 1;
      const fgaBase = fga * scale || 1, ftaBase = fta * scale || 1;
      const nowT = {
        fgm: r.fgPct * fgaBase + x.fgm, fga: fgaBase + x.fga, ftm: r.ftPct * ftaBase + x.ftm, fta: ftaBase + x.fta,
        ...Object.fromEntries(COUNT.map(c => [c, r[c] + x[c]]))
      };
      const t = { name: r.team, yahooRank: r.yahooRank, gpNow: r.gp + x.gp, games: 0, estimated: a.estimated };
      // Projected stats from the active lineup over the given days (games weighted by injury status)
      const project = ds => {
        const add = { fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
        let games = 0;
        for (const p of a.players) {
          const k = normName(p.name);
          const src = projByName.get(k) || statLine.get(k);
          const team = (projByName.get(k) || {}).team || p.nbaTeam;
          if (!src) continue;
          for (const d of ds) {
            const w = sched.get(d).has(ESPN_TEAM[team] || team) ? playWeight(k, d) : 0;
            if (!w) continue;
            games += w;
            for (const c of Object.keys(add)) add[c] += (src[c] || 0) * w;
          }
        }
        return { add, games };
      };
      const { add, games: gTonight } = project([today]);
      const { add: addEow, games: gEow } = project(days);
      t.games = gTonight;
      t.gamesEow = gEow;
      t.eowTotals = {
        fgPct: (nowT.fgm + addEow.fgm) / (nowT.fga + addEow.fga),
        ftPct: (nowT.ftm + addEow.ftm) / (nowT.fta + addEow.fta),
        ...Object.fromEntries(COUNT.map(c => [c, nowT[c] + addEow[c]]))
      };
      t.realTotals = { fgPct: nowT.fgm / nowT.fga, ftPct: nowT.ftm / nowT.fta, ...Object.fromEntries(COUNT.map(c => [c, nowT[c]])) };
      t.projTotals = {
        fgPct: (nowT.fgm + add.fgm) / (nowT.fga + add.fga),
        ftPct: (nowT.ftm + add.ftm) / (nowT.fta + add.fta),
        ...Object.fromEntries(COUNT.map(c => [c, nowT[c] + add[c]]))
      };
      return t;
    });
    rotoPoints(teams, 'real');
    rotoPoints(teams, 'proj');
    rotoPoints(teams, 'eow');
    standingsJson = { base: st.asOf, statsThrough: cur.asOf, teams: teams.map(t => ({ name: t.name, gpNow: t.gpNow, gamesTonight: t.games, now: t.realTotals, nowRoto: t.realRoto, nowRank: t.realRank, proj: t.projTotals, projRoto: t.projRoto, projRank: t.projRank, gamesEow: t.gamesEow, eow: t.eowTotals, eowRoto: t.eowRoto, eowRank: t.eowRank })) };
    md.push(`"Now" = Yahoo standings ${st.asOf}${st.asOf < cur.asOf ? ` plus games through stats ${cur.asOf}, rebuilt from player stats` : ''}. "Tonight" adds today's ${tonight.size / 2} NBA games; "EOW" adds every remaining game through Sunday ${days[days.length - 1]}. Each player in a locked active lineup counts his projected per-game stats, weighted by injury status (O/D 0, Q 0.5, P 0.9; an out player counts 0.7 from his ESPN return date). Players traded or dropped mid-week keep counting for the team whose lineup they're locked into until the next lock, as Yahoo does.`, '');
    md.push('| Now | Tonight | EOW | Team | Games tonight / EOW | Points now → tonight → EOW | ' + CATS.map(c => `${c} (EOW)`).join(' | ') + ' |');
    md.push('|---|---|---|---|---|---|' + CATS.map(() => '---').join('|') + '|');
    for (const t of [...teams].sort((a, b) => a.eowRank - b.eowRank)) {
      const mark = t.name === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(t.name) ? ` **${league.managedLabel || '(Finn)'}**` : '';
      md.push(`| ${t.realRank} | ${t.projRank} | ${t.eowRank} | ${t.name}${mark}${t.estimated ? ' †' : ''} | ${+t.games.toFixed(1)} / ${+t.gamesEow.toFixed(1)} | ${t.realRoto.total} → ${t.projRoto.total} → ${t.eowRoto.total} | ` +
        CATS.map(c => t.eowRoto[c]).join(' | ') + ' |');
    }
    if (teams.some(t => t.estimated)) md.push('', '† lineup paste was cut off; missing starters estimated from best-projected players.');
    md.push('');
    for (const tn of league.managedTeams || []) {
      const t = teams.find(x => x.name === tn);
      if (!t) continue;
      md.push(`- **${tn}:** now ${t.realRank} → tonight ${t.projRank} → EOW ${t.eowRank} (${t.realRoto.total} → ${t.projRoto.total} → ${t.eowRoto.total} pts), ${+t.games.toFixed(1)} games tonight, ${+t.gamesEow.toFixed(1)} through Sunday. ` +
        `EOW projected: FG ${fmtPct(t.eowTotals.fgPct)}, FT ${fmtPct(t.eowTotals.ftPct)}, ${COUNT.map(c => `${Math.round(t.eowTotals[c])} ${c}`).join(', ')}.`);
    }
    md.push('');
  }

  md.push(...injMd);

  // 4. FOMO watch: how the tracked trades are working out since they happened
  let tradeWatch = [];
  try {
    let watches = loadWatches();
    const txAll = readJson(path.join(__dirname, 'transactions.json')).transactions;
    let moves = false;
    if (focus) {
      // Focus teams: the configured trades for those teams, else every add/drop they have made
      watches = watches.filter(w => league.managedTeams.includes((findTeam(league, w.team) || {}).name));
      if (!watches.length) { watches = league.managedTeams.flatMap(tn => moveWatchesFor(tn, txAll, name => findTeam(league, name))); moves = true; }
    }
    if (watches.length && snaps.length) {
      tradeWatch = buildTradeWatch({
        watches,
        transactions: txAll,
        snapshots: snaps.map(readJson),
        score,
        findTeam: name => findTeam(league, name),
        ownedKeys: new Set(owner.keys())
      });
      md.push(...(moves ? moveWatchMarkdown : tradeWatchMarkdown)(tradeWatch, name => (injBy.get(normName(name)) || {}).status || ''));
    }
  } catch (e) { warn.push(`FOMO watch failed: ${e.message}`); }

  const due = focus ? [] : dueQuestions(today);
  if (due.length) {
    md.push('## Open questions due', '', 'From `season/open_questions.md`. Answer each below, then tick it there with a one-line answer.', '');
    for (const q of due) md.push(`- (${q.date}) ${q.text}`);
    md.push('');
  }

  // 5. Season odds: Monte Carlo of the rest of the season (SEASON_SIM_N=0 skips it)
  let seasonOdds = null;
  const simN = parseInt(process.env.SEASON_SIM_N || '4000', 10);
  if (standingsJson && simN > 0) {
    try {
      const { schedule, source } = await fetchSchedule(today);
      const news = datedFiles(path.join(__dirname, 'news'));
      const returns = new Map();
      if (news.length) for (const i of readJson(news[news.length - 1]).injuries || []) if (i.returnDate) returns.set(normName(i.name), i.returnDate.slice(0, 10));
      const left = movesLeft(league, readJson(path.join(__dirname, 'transactions.json')).transactions);
      const res = simulateSeason({
        N: simN, today, schedule, players: PLAYERS, stats: cur.players, score,
        injuries: new Map([...injBy].map(([k, p]) => [k, p.status])), returns,
        teams: standingsJson.teams.map(st => {
          const t = findTeam(league, st.name);
          const a = active.get(t.name);
          return { name: t.name, now: st.now, gpNow: st.gpNow, roster: t.roster, activeNames: new Set(((a && a.players) || []).map(p => normName(p.name))), movesLeft: left[t.name] };
        })
      });
      const priorFile = datedFiles(REPORT_DIR).filter(f => path.basename(f) < `${today}.json`).pop();
      const prior = priorFile ? readJson(priorFile).seasonOdds : null;
      seasonOdds = { asOf: today, N: res.N, weeks: res.weeks, third: res.third, teams: res.teams };
      md.push(...seasonOddsMarkdown(res, league, prior, source));
    } catch (e) { warn.push(`Season odds failed: ${e.message}`); }
  }

  if (warn.length) md.push('## Notes', '', ...warn.map(w => `- ${w}`), '');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, `${today}${focus ? `-${focus.slug}` : ''}.md`);
  fs.writeFileSync(out, md.join('\n'));
  if (standingsJson) fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify({ ...standingsJson, tradeWatch, seasonOdds }, null, 2) + '\n');
  console.log(md.join('\n'));
  console.log(`\nSaved ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`morning_report: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { dueQuestions, buildScorer, gameLines, activeLineups, mondayOf };
