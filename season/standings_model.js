const fs = require('fs');
const path = require('path');
const { normName } = require('../engine.js');

/**
 * Shared pieces of the standings projection, used by the morning report (tonight / end of
 * week) and the Monday lineup optimizer (next week / end of season):
 * - the latest complete Yahoo standings, with games since rebuilt from player stats
 * - ESPN's daily schedule
 * - injury-weighted play probability per player per day
 * - a lineup's projected stats over a set of days
 */

const COUNT = ['tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const SUMS = ['fgm', 'fga', 'ftm', 'fta', ...COUNT];
const ESPN_TEAM = { WAS: 'WSH', SAS: 'SA', NOP: 'NO', NYK: 'NY', GSW: 'GS', UTA: 'UTAH', PHO: 'PHX' };
// Share of a game a player is expected to play, by Yahoo injury status
const PLAY_WEIGHT = { O: 0, D: 0, INJ: 0, SUSP: 0, Q: 0.5, GTD: 0.5, DTD: 0.5, P: 0.9 };

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const zeroLine = () => Object.fromEntries(SUMS.map(k => [k, 0]));
// Matches a team by its current name or a name it had earlier (league.json previousNames)
const findTeam = (league, name) => league.teams.find(t => t.name === name || (t.previousNames || []).includes(name));

function datedFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => path.join(dir, f));
}

const addDays = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

// NBA teams playing on a date (ESPN abbreviations), skipping games already final
async function scheduleFor(dateIso) {
  const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateIso.replace(/-/g, '')}`);
  if (!res.ok) throw new Error(`ESPN scoreboard -> ${res.status}`);
  const teams = new Set();
  for (const e of (await res.json()).events || []) {
    if (e.status && e.status.type && e.status.type.state === 'post') continue; // already final
    for (const c of e.competitions[0].competitors) teams.add(c.team.abbreviation);
  }
  return teams;
}

const espnTeam = t => ESPN_TEAM[t] || t;

// Box-score lines for games played between two snapshots (season totals differenced)
function gameLines(prev, cur) {
  const before = new Map(prev.players.map(p => [normName(p.name), p]));
  const lines = new Map();
  for (const p of cur.players) {
    const b = before.get(normName(p.name));
    const games = p.gp - (b ? b.gp : 0);
    if (games <= 0) continue;
    const line = { name: p.name, nbaTeam: p.nbaTeam, games, mpg: p.mpg };
    // Snapshots hold per-game averages rounded to 0.1, so differenced totals carry noise;
    // box-score stats are whole numbers, so round (and never go below zero)
    for (const k of SUMS) line[k] = Math.max(0, Math.round(p[k] * p.gp - (b ? b[k] * b.gp : 0)));
    lines.set(normName(p.name), line);
  }
  return lines;
}

/**
 * Base standings: the latest complete Yahoo standings plus every game since, rebuilt from
 * stat snapshots and the locked lineups (activeKey: player key -> team counting him).
 * Returns { st, rows: [{ team, yahooRank, gp, nowT }] } where nowT holds makes, attempts and
 * counting totals; attempts behind Yahoo's percentages are estimated from the active
 * players' season lines scaled to Yahoo's games played.
 */
function baseStandings({ league, snaps, cur, active, activeKey, stFiles, warn }) {
  if (!stFiles.length) return null;
  // Standings copied while games were still being played are marked complete: false and
  // skipped; the base is the latest complete standings, and later games are rebuilt
  // from player stats (validated to match Yahoo within rounding).
  const stAll = stFiles.map(readJson);
  const st = [...stAll].reverse().find(x => x.complete !== false) || stAll[stAll.length - 1];
  const skipped = stAll.filter(x => x.asOf > st.asOf && x.complete === false).map(x => x.asOf);
  if (skipped.length) warn.push(`Skipped standings ${skipped.join(', ')}: copied while games were still in progress.`);
  let base = st.teams.map(r => ({ ...r, team: (findTeam(league, r.team) || { name: r.team }).name }));
  if (st.asOf < cur.asOf) {
    warn.push(`Base standings ${st.asOf}; games since then (through stats ${cur.asOf}) are rebuilt from player stats and locked lineups. Paste standings each morning, after every game has finished, for an exact base.`);
    const since = snaps.map(readJson).filter(s => s.asOf >= st.asOf);
    const extra = new Map();
    for (let i = 1; i < since.length; i++) {
      for (const [k, l] of gameLines(since[i - 1], since[i])) {
        const team = activeKey.get(k);
        if (!team) continue;
        const e = extra.get(team) || { gp: 0, ...zeroLine() };
        e.gp += l.games;
        for (const c of Object.keys(e)) if (c !== 'gp') e[c] += l[c];
        extra.set(team, e);
      }
    }
    base = base.map(r => ({ ...r, _extra: extra.get(r.team) }));
  }
  const statLine = new Map(cur.players.map(p => [normName(p.name), p]));
  const rows = base.map(r => {
    const a = active.get(r.team) || { players: [], estimated: false };
    // Shot volume so far, estimated from active players' season lines (scaled to Yahoo GP)
    let fga = 0, fta = 0, gp = 0;
    for (const p of a.players) {
      const s = statLine.get(normName(p.name));
      if (s) { fga += s.fga * s.gp; fta += s.fta * s.gp; gp += s.gp; }
    }
    const x = r._extra || { gp: 0, ...zeroLine() };
    const scale = gp ? r.gp / gp : 1;
    const fgaBase = fga * scale || 1, ftaBase = fta * scale || 1;
    const nowT = {
      fgm: r.fgPct * fgaBase + x.fgm, fga: fgaBase + x.fga, ftm: r.ftPct * ftaBase + x.ftm, fta: ftaBase + x.fta,
      ...Object.fromEntries(COUNT.map(c => [c, r[c] + x[c]]))
    };
    return { team: r.team, yahooRank: r.yahooRank, gp: r.gp + x.gp, nowT, estimated: a.estimated };
  });
  return { st, rows };
}

/**
 * Expected-play function from the latest injury report and ESPN return dates:
 * (playerKey, dateIso) -> share of a game he's expected to play.
 */
function playWeights({ injBy, newsFiles, today, warn }) {
  const injNow = new Map([...injBy].map(([k, p]) => [k, p.status]));
  // ESPN expected-return dates (latest digest) let an "out" player count again once he's due back
  const retDate = new Map();
  if (newsFiles.length) {
    const nj = readJson(newsFiles[newsFiles.length - 1]);
    for (const i of nj.injuries || []) if (i.returnDate) retDate.set(normName(i.name), i.returnDate.slice(0, 10));
    if (nj.asOf < today) warn.push(`Expected-return dates come from the ${nj.asOf} news digest.`);
  }
  // Share of a game expected on day d: injury weight, but an out player counts at 0.7 from his ESPN return date
  const fn = (k, d) => {
    const w = PLAY_WEIGHT[injNow.get(k)] ?? 1;
    return w === 0 && retDate.has(k) && d >= retDate.get(k) ? 0.7 : w;
  };
  fn.status = k => injNow.get(k) || null;
  fn.returnDate = k => retDate.get(k) || null;
  return fn;
}

// Per-game source line and NBA team for a player: projection first, else his season stats
function sourceFor(name, projByName, statLine, fallbackTeam) {
  const k = normName(name);
  const src = projByName.get(k) || statLine.get(k);
  const team = (projByName.get(k) || {}).team || fallbackTeam || (src && src.nbaTeam);
  return { k, src, team };
}

// Projected stats from a list of players over the given days (games weighted by injury status)
function projectPlayers(players, days, { sched, playWeight, projByName, statLine }) {
  const add = zeroLine();
  let games = 0;
  for (const p of players) {
    const { k, src, team } = sourceFor(p.name, projByName, statLine, p.nbaTeam);
    if (!src) continue;
    for (const d of days) {
      const w = sched.get(d).has(espnTeam(team)) ? playWeight(k, d) : 0;
      if (!w) continue;
      games += w;
      for (const c of Object.keys(add)) add[c] += (src[c] || 0) * w;
    }
  }
  return { add, games };
}

module.exports = {
  COUNT, SUMS, ESPN_TEAM, PLAY_WEIGHT, readJson, zeroLine, findTeam, datedFiles, addDays,
  scheduleFor, espnTeam, gameLines, baseStandings, playWeights, sourceFor, projectPlayers
};
