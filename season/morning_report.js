const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { normName, CATS } = require('../engine.js');
const { rotoPoints } = require('./build_season.js');

/**
 * Morning report: last night's over/under performers, injury changes, and projected
 * standings after tonight's games. Writes reports/YYYY-MM-DD.md and prints it.
 *
 * Inputs (all already in the repo after `npm run fetch-stats` + `npm run injuries`):
 * - stats/snapshots: the two latest snapshots. Their difference is last night's box score.
 * - season/league.json: ownership, this week's locked lineup (thisWeek) and injuries.
 * - season/standings: the latest real Yahoo standings, the base for the projection.
 * - season/injuries: the two latest reports, compared to find new, changed and cleared injuries.
 * - Tonight's schedule from ESPN's public scoreboard.
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
function datedFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => path.join(dir, f));
}
const etDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
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
    const t = league.teams.find(x => x.name === teamName);
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
  const projByName = new Map(PLAYERS.map(p => [normName(p.name), p]));
  const owner = new Map();
  for (const t of league.teams) for (const r of t.roster) owner.set(normName(r.name), t.name);
  const tag = name => {
    const o = owner.get(normName(name));
    return o === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(o) ? ' **(Finn)**' : o ? ` (${o})` : ' (FA)';
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

  const rated = [];
  for (const [key, l] of lines) {
    if (!owner.has(key)) continue;
    const per = { ...l };
    for (const k of ['fgm', 'fga', 'ftm', 'fta', ...COUNT]) per[k] = l[k] / l.games;
    const proj = projByName.get(key) || cur.players.find(p => normName(p.name) === key);
    const gameZ = score(per), projZ = proj ? score(proj) : 0;
    rated.push({ ...l, key, delta: (gameZ - projZ) * l.games, gameZ, projZ, counted: activeKey.has(key) });
  }
  rated.sort((a, b) => b.delta - a.delta);
  const row = r => {
    const team = activeKey.get(r.key);
    const note = !team ? ' *(not in an active lineup)*' : team !== owner.get(r.key) ? ` *(counts for ${team} this week)*` : '';
    return `| ${r.name}${tag(r.name)}${note} | ${fmtLine(r)} | ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} |`;
  };
  md.push(`## Last night (games in snapshot ${cur.asOf})`, '');
  if (!rated.length) {
    md.push('No rostered player games between the last two snapshots.', '');
  } else {
    md.push('Value vs projection is the game\'s 8-cat z-score minus the player\'s projected per-game z-score.', '');
    md.push('**Biggest over-performers (rostered)**', '', '| Player | Line | vs proj |', '|---|---|---|', ...rated.slice(0, 6).map(row), '');
    md.push('**Biggest under-performers (rostered)**', '', '| Player | Line | vs proj |', '|---|---|---|', ...rated.slice(-6).reverse().map(row), '');
    for (const tn of league.managedTeams || []) {
      // Lineup first: a player traded mid-week still counts for his locked-lineup team until the next lock
      const mine = rated.filter(r => (activeKey.get(r.key) || owner.get(r.key)) === tn);
      md.push(`**${tn}** — ${mine.length} played`, '');
      if (mine.length) md.push('| Player | Line | vs proj |', '|---|---|---|', ...mine.map(row), '');
    }
  }

  // 2. Injuries: changes since the previous report
  md.push('## Injury changes (rostered players)', '');
  const injFiles = datedFiles(path.join(__dirname, 'injuries'));
  if (injFiles.length < 2) {
    md.push('Need two injury reports to compare; only one so far.', '');
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
    md.push(`Comparing ${a.asOf} → ${b.asOf}.`, '', ...(changes.length ? changes : ['No changes for rostered players.']), '');
    for (const tn of league.managedTeams || []) {
      const t = league.teams.find(x => x.name === tn);
      const hurt = t.roster.filter(r => now.has(normName(r.name))).map(r => `${r.name} ${now.get(normName(r.name)).status}`);
      md.push(`- ${tn}: ${hurt.length ? hurt.join(', ') : 'no injuries'}`);
    }
    md.push('');
  }

  // 3. Projected standings after tonight
  md.push('## Projected standings after tonight', '');
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
    let base = st.teams;
    if (st.asOf < cur.asOf) {
      warn.push(`Base standings ${st.asOf}; games since then (through stats ${cur.asOf}) are rebuilt from player stats and locked lineups. Paste standings each morning, after every game has finished, for an exact base.`);
      const since = snaps.map(readJson).filter(s => s.asOf >= st.asOf);
      const extra = new Map();
      for (let i = 1; i < since.length; i++) {
        for (const [k, l] of gameLines(since[i - 1], since[i])) {
          const team = activeKey.get(k);
          if (!team) continue;
          const e = extra.get(team) || { gp: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
          e.gp += l.games;
          for (const c of Object.keys(e)) if (c !== 'gp') e[c] += l[c];
          extra.set(team, e);
        }
      }
      base = base.map(r => ({ ...r, _extra: extra.get(r.team) }));
    }

    let tonight = new Set();
    try { tonight = await tonightsSchedule(today); } catch (e) { warn.push(`Couldn't load tonight's schedule: ${e.message}`); }
    const injNow = injFiles.length ? new Map(readJson(injFiles[injFiles.length - 1]).players.map(p => [normName(p.name), p.status])) : new Map();
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
      const add = { fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
      for (const p of a.players) {
        const k = normName(p.name);
        const src = projByName.get(k) || statLine.get(k);
        const team = (projByName.get(k) || {}).team || p.nbaTeam;
        const w = tonight.has(ESPN_TEAM[team] || team) ? (PLAY_WEIGHT[injNow.get(k)] ?? 1) : 0;
        if (!src || !w) continue;
        t.games += w;
        for (const c of Object.keys(add)) add[c] += (src[c] || 0) * w;
      }
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
    standingsJson = { base: st.asOf, statsThrough: cur.asOf, teams: teams.map(t => ({ name: t.name, gpNow: t.gpNow, gamesTonight: t.games, now: t.realTotals, nowRoto: t.realRoto, nowRank: t.realRank, proj: t.projTotals, projRoto: t.projRoto, projRank: t.projRank })) };
    md.push(`"Now" = Yahoo standings ${st.asOf}${st.asOf < cur.asOf ? ` plus games through stats ${cur.asOf}, rebuilt from player stats` : ''}. Tonight: ${tonight.size / 2} NBA games; each player in a locked active lineup counts his projected per-game stats, weighted by injury status (O/D 0, Q 0.5, P 0.9). Players traded or dropped mid-week keep counting for the team whose lineup they're locked into until the next lock, as Yahoo does.`, '');
    md.push('| Now | Proj | Team | GP now | Games tonight | Points now → proj | ' + CATS.join(' | ') + ' |');
    md.push('|---|---|---|---|---|---|' + CATS.map(() => '---').join('|') + '|');
    for (const t of [...teams].sort((a, b) => a.projRank - b.projRank)) {
      const mark = t.name === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(t.name) ? ' **(Finn)**' : '';
      md.push(`| ${t.realRank} | ${t.projRank} | ${t.name}${mark}${t.estimated ? ' †' : ''} | ${t.gpNow} | ${t.games} | ${t.realRoto.total} → ${t.projRoto.total} | ` +
        CATS.map(c => t.projRoto[c]).join(' | ') + ' |');
    }
    if (teams.some(t => t.estimated)) md.push('', '† lineup paste was cut off; missing starters estimated from best-projected players.');
    md.push('');
    for (const tn of league.managedTeams || []) {
      const t = teams.find(x => x.name === tn);
      if (!t) continue;
      md.push(`- **${tn}:** ${t.realRank} → ${t.projRank} (${t.realRoto.total} → ${t.projRoto.total} pts), ${t.games} games tonight. ` +
        `Projected: FG ${fmtPct(t.projTotals.fgPct)}, FT ${fmtPct(t.projTotals.ftPct)}, ${COUNT.map(c => `${Math.round(t.projTotals[c])} ${c}`).join(', ')}.`);
    }
    md.push('');
  }

  if (warn.length) md.push('## Notes', '', ...warn.map(w => `- ${w}`), '');
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, `${today}.md`);
  fs.writeFileSync(out, md.join('\n'));
  if (standingsJson) fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(standingsJson, null, 2) + '\n');
  console.log(md.join('\n'));
  console.log(`\nSaved ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`morning_report: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { buildScorer, gameLines, activeLineups, mondayOf };
