const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { buildNameIndex, matchPlayer, normName, CATS } = require('../engine.js');

/**
 * Builds season/league.json from the official league draft results.
 *
 * Input format (Yahoo draft results, tab-separated):
 *   1.	Tyrese Maxey (PHI - PG)	$54	Grilled Teampura
 *
 * Usage: node season/build_season.js [path-to-draft-results]
 */

const DRAFT_FILE = process.argv[2] || path.join(__dirname, 'draft_2026-10-18.txt');
const TXN_FILE = path.join(__dirname, 'transactions.json');
const OUT_FILE = path.join(__dirname, 'league.json');
const STATS_FILE = path.join(__dirname, '..', 'stats', 'latest.json');
const LINEUP_DIR = path.join(__dirname, 'lineups');
const STANDINGS_DIR = path.join(__dirname, 'standings');
const INJURY_DIR = path.join(__dirname, 'injuries');

// The user's own team, plus other teams the user manages (their son Finn's team)
const MY_TEAM = 'Shut Up and Jam Gaiden';
const MANAGED_TEAMS = [MY_TEAM, 'Finn will turn Bert into bacon'];

// Teams renamed since the draft: current name -> earlier names
const TEAM_ALIASES = {
  'Cole is like that': ["Cole's aura tuff team"],
  'Finn will turn Bert into bacon': ['Finn will cook Burt']
};
// Older names in the draft file, transactions, lineups and standings resolve to the current one
const canonTeam = name => (Object.entries(TEAM_ALIASES).find(([, old]) => old.includes(name)) || [name])[0];

const pickRegex = /^(\d+)\.\s+(.+?)\s+\(([A-Z]+)\s+-\s+([A-Z,]+)\)\s+\$(\d+)\s+(.+)$/;

function parseDraft(text) {
  const nameIndex = buildNameIndex(PLAYERS);
  const picks = [];
  const unmatched = [];
  for (const line of text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
    const m = line.match(pickRegex);
    if (!m) {
      console.warn(`Skipping unparseable line: ${line}`);
      continue;
    }
    const [, pick, name, nbaTeam, pos, price, fantasyTeam] = m;
    const player = matchPlayer(name, PLAYERS, nameIndex);
    if (!player) unmatched.push(name);
    picks.push({
      pick: parseInt(pick, 10),
      name,
      nbaTeam,
      pos: pos.split(','),
      price: parseInt(price, 10),
      team: fantasyTeam.trim(),
      rk: player ? player.rk : null
    });
  }
  return { picks, unmatched };
}

// Season totals from per-game stat lines: sum of per-game x games played
function sumTotals(lines) {
  const tot = { fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
  for (const p of lines) {
    for (const k of Object.keys(tot)) tot[k] += (p[k] || 0) * (p.gp || 0);
  }
  return {
    fgPct: tot.fga ? +(tot.fgm / tot.fga).toFixed(4) : 0,
    ftPct: tot.fta ? +(tot.ftm / tot.fta).toFixed(4) : 0,
    tpm: Math.round(tot.tpm),
    pts: Math.round(tot.pts),
    treb: Math.round(tot.treb),
    ast: Math.round(tot.ast),
    stl: Math.round(tot.stl),
    blk: Math.round(tot.blk)
  };
}

// Projected season totals: players.js per-game stats x projected games played
function projectTeam(roster) {
  const byRk = new Map(PLAYERS.map(p => [p.rk, p]));
  return sumTotals(roster.map(r => byRk.get(r.rk)).filter(Boolean));
}

// Roto points: best team in a category gets N points, worst gets 1 (ties share the average).
// prefix 'proj' reads projTotals and writes projRoto/projRank; 'actual' does the same for actuals.
function rotoPoints(teams, prefix = 'proj') {
  const totalsKey = `${prefix}Totals`, rotoKey = `${prefix}Roto`, rankKey = `${prefix}Rank`;
  const n = teams.length;
  for (const t of teams) t[rotoKey] = { total: 0 };
  for (const c of CATS) {
    const sorted = [...teams].sort((a, b) => a[totalsKey][c] - b[totalsKey][c]);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && sorted[j + 1][totalsKey][c] === sorted[i][totalsKey][c]) j++;
      const pts = (i + 1 + j + 1) / 2;
      for (let k = i; k <= j; k++) sorted[k][rotoKey][c] = pts;
      i = j + 1;
    }
  }
  for (const t of teams) {
    t[rotoKey].total = CATS.reduce((s, c) => s + t[rotoKey][c], 0);
  }
  [...teams].sort((a, b) => b[rotoKey].total - a[rotoKey].total)
    .forEach((t, i) => { t[rankKey] = i + 1; });
}

const STAT_KEYS = ['gp', 'mpg', 'fgPct', 'fgm', 'fga', 'ftPct', 'ftm', 'fta', 'tpm', 'pts', 'treb', 'ast', 'stl', 'blk', 'valueTotal', 'rank'];

/**
 * Attaches season-to-date stats (stats/latest.json) to every rostered player and
 * computes each team's actual totals and roto standings. Rostered players with no
 * stat line (haven't played yet) get stats: null. Returns the stat lines no team rosters.
 */
// Yahoo's draft results and player list use different team abbreviations
const NBA_TEAM_ALIASES = { SAS: 'SA', PHX: 'PHO', NYK: 'NY', GSW: 'GS', NOP: 'NO' };
const normTeam = t => NBA_TEAM_ALIASES[t] || t;

function attachSeasonStats(teams, statsPlayers) {
  const index = buildNameIndex(statsPlayers);
  const claimed = new Set();
  // Exact (accent-insensitive) name match first; the fuzzy fallback must also agree on
  // NBA team, otherwise e.g. Cameron Johnson would match Chaney Johnson.
  const findLine = r => {
    const exact = index.get(normName(r.name));
    if (exact) return exact;
    const fuzzy = matchPlayer(r.name, statsPlayers, index);
    return fuzzy && normTeam(fuzzy.nbaTeam) === normTeam(r.nbaTeam) ? fuzzy : null;
  };
  for (const t of teams) {
    for (const r of t.roster) {
      const line = findLine(r);
      if (line) claimed.add(line);
      r.stats = line ? Object.fromEntries(STAT_KEYS.map(k => [k, line[k]])) : null;
    }
    t.actualTotals = sumTotals(t.roster.map(r => r.stats).filter(Boolean));
    t.gamesPlayed = t.roster.reduce((s, r) => s + (r.stats ? r.stats.gp : 0), 0);
  }
  rotoPoints(teams, 'actual');
  return statsPlayers.filter(p => !claimed.has(p));
}

/**
 * Applies transactions.json to the draft-day rosters (mutates teams).
 * Throws when a drop or trade names a player who is not on the expected roster,
 * so typos are caught instead of silently producing wrong rosters.
 */
function applyTransactions(teams, transactions) {
  const nameIndex = buildNameIndex(PLAYERS);
  const byRk = new Map(PLAYERS.map(p => [p.rk, p]));
  const teamByName = new Map(teams.map(t => [t.name, t]));
  const getTeam = name => {
    const t = teamByName.get(canonTeam(name));
    if (!t) throw new Error(`Unknown team in transactions: ${name}`);
    return t;
  };
  const same = (a, b) => normName(a) === normName(b);
  const removeFrom = (team, name) => {
    const i = team.roster.findIndex(r => same(r.name, name));
    if (i < 0) throw new Error(`${name} is not on ${team.name}'s roster`);
    return team.roster.splice(i, 1)[0];
  };
  const entryFor = (p, acquired, date) => {
    const player = matchPlayer(p.name, PLAYERS, nameIndex);
    return {
      name: p.name,
      rk: player ? player.rk : null,
      nbaTeam: p.nbaTeam,
      pos: p.pos,
      price: 0,
      pick: null,
      acquired,
      acquiredDate: date,
      projZ: player && byRk.has(player.rk) ? byRk.get(player.rk).totalZ : null
    };
  };

  const log = (team, name, dir, how, date) => {
    (team.moveLog = team.moveLog || []).push({ date, name, dir, how });
  };
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    if (t.type === 'add_drop') {
      const team = getTeam(t.team);
      for (const d of t.drop || []) {
        removeFrom(team, d.name);
        log(team, d.name, 'out', 'drop', t.date);
      }
      for (const a of t.add || []) {
        team.roster.push(entryFor(a, a.via, t.date));
        team.acquisitions++;
        log(team, a.name, 'in', a.via, t.date);
      }
    } else if (t.type === 'trade') {
      // Resolve every from-team before moving anyone, so a two-way swap works
      const moves = t.moves.map(m => {
        const from = teams.find(tm => tm.roster.some(r => same(r.name, m.name)));
        if (!from) throw new Error(`Traded player ${m.name} is not on any roster`);
        return { m, from };
      });
      for (const { m, from } of moves) {
        const entry = removeFrom(from, m.name);
        entry.acquired = 'trade';
        entry.acquiredDate = t.date;
        getTeam(m.to).roster.push(entry);
        log(from, m.name, 'out', 'trade', t.date);
        log(getTeam(m.to), m.name, 'in', 'trade', t.date);
      }
    } else {
      throw new Error(`Unknown transaction type: ${t.type}`);
    }
  }
}

// Fewer listed players than starting slots means the paste was cut off mid-team
const MIN_COMPLETE_LINEUP = 9;

/**
 * Attaches this week's locked lineup (season/lineups/*.json) to current rosters.
 * Each rostered player gets thisWeek: { slot, status, gameToday }, or null when
 * they joined the team after the lineup locked. Differences between ownership and
 * the lineup must be explained by a logged transaction; anything else is returned
 * in `unexplained`, which usually means a transaction is missing from transactions.json.
 */
function attachLineups(teams, snapshot) {
  const unexplained = [];
  const blocks = snapshot.teams.map(b => ({ ...b, team: b.team && canonTeam(b.team), players: b.players.map(p => ({ ...p })) }));
  // A block whose team name was cut off: pick the team whose roster overlaps it most
  for (const b of blocks.filter(bl => !bl.team)) {
    const names = new Set(b.players.map(p => normName(p.name)));
    const taken = new Set(blocks.map(bl => bl.team).filter(Boolean));
    let best = null, bestOverlap = 0;
    for (const t of teams.filter(tm => !taken.has(tm.name))) {
      const overlap = t.roster.filter(r => names.has(normName(r.name))).length;
      if (overlap > bestOverlap) { best = t; bestOverlap = overlap; }
    }
    if (best) { b.team = best.name; b.inferred = true; }
  }
  for (const b of blocks) {
    const t = teams.find(tm => tm.name === b.team);
    if (!t) {
      unexplained.push(`Lineup block for unknown team "${b.team}"`);
      continue;
    }
    const complete = b.players.length >= MIN_COMPLETE_LINEUP;
    // Yahoo abbreviates long names ("N. Alexander-Walker"): expand from this team's roster
    const fullName = name => {
      const m = name.match(/^([A-Za-z])\.\s+(.+)$/);
      if (!m) return name;
      const hit = t.roster.find(r => {
        const n = normName(r.name);
        return n.startsWith(m[1].toLowerCase()) && n.endsWith(' ' + normName(m[2]));
      });
      return hit ? hit.name : name;
    };
    for (const p of b.players) p.name = fullName(p.name);
    const lineupByName = new Map(b.players.map(p => [normName(p.name), p]));
    const ownedNames = new Set(t.roster.map(r => normName(r.name)));
    const moved = dir => new Set((t.moveLog || []).filter(m => m.dir === dir).map(m => normName(m.name)));
    const movedIn = moved('in'), movedOut = moved('out');

    t.lineup = { asOf: snapshot.asOf, complete, teamNameInferred: !!b.inferred };
    t.pendingIn = [];
    for (const r of t.roster) {
      const p = lineupByName.get(normName(r.name));
      r.thisWeek = p ? { slot: p.slot, status: p.status, gameToday: p.gameToday } : null;
      if (!p && complete) {
        t.pendingIn.push(r.name);
        if (!movedIn.has(normName(r.name))) unexplained.push(`${t.name}: owns ${r.name}, but not in this week's lineup and no add/trade is logged`);
      }
    }
    t.pendingOut = b.players.filter(p => !ownedNames.has(normName(p.name))).map(p => p.name);
    for (const name of t.pendingOut) {
      if (!movedOut.has(normName(name))) unexplained.push(`${t.name}: ${name} is in this week's lineup, but not on the roster and no drop/trade is logged`);
    }
  }
  return unexplained;
}

function latestSnapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? JSON.parse(fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')) : null;
}

/**
 * Attaches Yahoo's real standings (season/standings/*.json: category totals per team)
 * and scores them into roto points (realTotals, realRoto, realRank). Returns team names
 * in the snapshot that don't match a league team.
 */
function attachStandings(teams, snapshot) {
  const unknown = [];
  for (const row of snapshot.teams) {
    const t = teams.find(tm => tm.name === canonTeam(row.team));
    if (!t) { unknown.push(row.team); continue; }
    t.realTotals = Object.fromEntries(CATS.map(c => [c, row[c]]));
    t.realGp = row.gp;
    t.yahooRank = row.yahooRank;
  }
  const scored = teams.filter(t => t.realTotals);
  if (scored.length) rotoPoints(scored, 'real');
  return unknown;
}

function main() {
  const { picks, unmatched } = parseDraft(fs.readFileSync(DRAFT_FILE, 'utf8'));
  const byRk = new Map(PLAYERS.map(p => [p.rk, p]));

  for (const p of picks) p.team = canonTeam(p.team);
  const teamNames = [...new Set(picks.map(p => p.team))];
  const teams = teamNames.map(name => {
    const roster = picks.filter(p => p.team === name).map(p => ({
      name: p.name,
      rk: p.rk,
      nbaTeam: p.nbaTeam,
      pos: p.pos,
      price: p.price,
      pick: p.pick,
      acquired: 'draft',
      acquiredDate: '2026-10-18',
      projZ: p.rk && byRk.has(p.rk) ? byRk.get(p.rk).totalZ : null
    }));
    return {
      name,
      previousNames: TEAM_ALIASES[name] || [],
      isMine: name === MY_TEAM,
      isManaged: MANAGED_TEAMS.includes(name),
      spent: roster.reduce((s, r) => s + r.price, 0),
      acquisitions: 0,
      roster
    };
  });

  const txns = fs.existsSync(TXN_FILE) ? JSON.parse(fs.readFileSync(TXN_FILE, 'utf8')) : { transactions: [], acquisitionLimit: 18 };
  applyTransactions(teams, txns.transactions);
  for (const t of teams) {
    t.acquisitionsLeft = txns.acquisitionLimit - t.acquisitions;
    t.projTotals = projectTeam(t.roster);
  }
  rotoPoints(teams);

  const stats = fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')) : null;
  const freeAgentLines = stats ? attachSeasonStats(teams, stats.players) : [];
  const lineupSnap = latestSnapshot(LINEUP_DIR);
  const standingsSnap = latestSnapshot(STANDINGS_DIR);
  const standingsIssues = standingsSnap ? attachStandings(teams, standingsSnap) : [];
  // Latest Yahoo injury report: tag rostered players with { status, note } (null when healthy)
  const injurySnap = latestSnapshot(INJURY_DIR);
  if (injurySnap) {
    const inj = new Map(injurySnap.players.map(p => [normName(p.name), p]));
    for (const t of teams) for (const r of t.roster) {
      const p = inj.get(normName(r.name));
      r.injury = p ? { status: p.status, note: p.note } : null;
    }
  }
  const lineupIssues = lineupSnap ? attachLineups(teams, lineupSnap) : [];

  const league = {
    league: 'LePrawn',
    yahooLeagueId: 45771,
    season: '2026-27',
    draftDate: '2026-10-18',
    myTeam: MY_TEAM,
    managedTeams: MANAGED_TEAMS,
    generatedFrom: path.relative(path.join(__dirname, '..'), DRAFT_FILE),
    transactionsApplied: txns.transactions.length,
    asOf: txns.transactions.reduce((m, t) => (t.date > m ? t.date : m), '2026-10-18'),
    statsAsOf: stats ? stats.asOf : null,
    lineupAsOf: lineupSnap ? lineupSnap.asOf : null,
    standingsAsOf: standingsSnap ? standingsSnap.asOf : null,
    injuriesAsOf: injurySnap ? injurySnap.asOf : null,
    teams: teams.sort((a, b) => a.projRank - b.projRank),
    draft: picks
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(league, null, 2) + '\n');

  console.log(`Parsed ${picks.length} picks across ${teams.length} teams -> ${path.relative(process.cwd(), OUT_FILE)}`);
  for (const t of teams) {
    if (t.roster.length !== 12) console.log(`Note: ${t.name} has ${t.roster.length} players (12 active/bench + up to 2 IL)`);
  }
  const unmatchedCurrent = teams.flatMap(t => t.roster.filter(r => !r.rk).map(r => r.name));
  if (unmatchedCurrent.length) {
    console.log(`Current rostered players outside players.js (no projections): ${unmatchedCurrent.join(', ')}`);
  }
  if (unmatched.length) {
    console.log(`Notice: ${unmatched.length} picks could not be matched to players.js: ${unmatched.join(', ')}`);
  }
  console.log('\n(* = my team, + = also managed by me)');
  console.log(`Projected Roto Standings (rosters as of ${league.asOf}, full-season projections):`);
  console.log('Rk   Team                              $    ' + CATS.map(c => c.padStart(6)).join('') + '   Total  Moves');
  for (const t of teams) {
    console.log(
      `${String(t.projRank).padStart(2)}${t.isMine ? '*' : t.isManaged ? '+' : ' '} ${t.name.padEnd(32).slice(0, 32)} ${String(t.spent).padStart(4)}  ` +
      CATS.map(c => String(t.projRoto[c]).padStart(6)).join('') +
      `   ${String(t.projRoto.total).padStart(5)}  ${String(t.acquisitions).padStart(2)}/${txns.acquisitionLimit}`
    );
  }

  if (lineupSnap) {
    console.log(`\nThis week's locked lineups (${lineupSnap.asOf}); moves since lock take effect next week:`);
    for (const t of teams) {
      if (!t.lineup) continue;
      const notes = [];
      if (t.lineup.teamNameInferred) notes.push('team name inferred');
      if (!t.lineup.complete) notes.push('paste cut off, partial check only');
      if (t.pendingIn.length) notes.push(`joining: ${t.pendingIn.join(', ')}`);
      if (t.pendingOut.length) notes.push(`leaving: ${t.pendingOut.join(', ')}`);
      const hurt = t.roster.filter(r => r.thisWeek && r.thisWeek.status).map(r => `${r.name} (${r.thisWeek.status}, ${r.thisWeek.slot})`);
      if (hurt.length) notes.push(`injury tags: ${hurt.join(', ')}`);
      if (notes.length) console.log(`  ${t.name}: ${notes.join('; ')}`);
    }
    const missing = teams.filter(t => !t.lineup).map(t => t.name);
    if (missing.length) console.log(`  No lineup in snapshot for: ${missing.join(', ')}`);
    for (const issue of lineupIssues) console.log(`  WARNING: ${issue}`);
  }

  if (injurySnap) {
    console.log(`\nInjuries on managed teams (Yahoo report ${injurySnap.asOf}):`);
    for (const t of teams.filter(tm => tm.isManaged)) {
      const hurt = t.roster.filter(r => r.injury).map(r => `${r.name} ${r.injury.status} (${r.injury.note})`);
      console.log(`  ${t.name}: ${hurt.length ? hurt.join(', ') : 'none'}`);
    }
  }

  if (standingsSnap) {
    console.log(`\nYahoo Standings (${standingsSnap.asOf}), scored as roto points:`);
    console.log('Rk   Team                              ' + CATS.map(c => c.padStart(6)).join('') + '   Total  (Proj)');
    for (const t of teams.filter(tm => tm.realRoto).sort((a, b) => a.realRank - b.realRank)) {
      console.log(
        `${String(t.yahooRank).padStart(2)}${t.isMine ? '*' : t.isManaged ? '+' : ' '} ${t.name.padEnd(32).slice(0, 32)}  ` +
        CATS.map(c => String(t.realRoto[c]).padStart(6)).join('') +
        `   ${String(t.realRoto.total).padStart(5)}  (${t.projRank})`
      );
    }
    for (const name of standingsIssues) console.log(`  WARNING: standings team "${name}" doesn't match any league team`);
  }

  if (!stats) return;
  console.log(`\nSeason-to-Date Roto (stats as of ${stats.asOf}, all rostered players counted):`);
  console.log('Rk   Team                              GP  ' + CATS.map(c => c.padStart(6)).join('') + '   Total  (Proj)');
  for (const t of [...teams].sort((a, b) => a.actualRank - b.actualRank)) {
    console.log(
      `${String(t.actualRank).padStart(2)}${t.isMine ? '*' : t.isManaged ? '+' : ' '} ${t.name.padEnd(32).slice(0, 32)} ${String(t.gamesPlayed).padStart(4)}  ` +
      CATS.map(c => String(t.actualRoto[c]).padStart(6)).join('') +
      `   ${String(t.actualRoto.total).padStart(5)}  (${t.projRank})`
    );
  }
  for (const t of teams.filter(tm => tm.isManaged)) {
    const dnp = t.roster.filter(r => !r.stats).map(r => r.name);
    if (dnp.length) console.log(`No stats yet for ${t.name}: ${dnp.join(', ')}`);
  }
  console.log('\nTop unrostered players by Hashtag Basketball season-to-date value:');
  for (const p of freeAgentLines.slice(0, 10)) {
    console.log(`  ${String(p.rank).padStart(3)}  ${p.name} (${p.nbaTeam} ${p.pos.join('/')}) GP ${p.gp}, ${p.mpg} mpg, total ${p.valueTotal}`);
  }
}

if (require.main === module) main();

module.exports = { parseDraft, sumTotals, projectTeam, rotoPoints, applyTransactions, attachSeasonStats, attachLineups, attachStandings };
