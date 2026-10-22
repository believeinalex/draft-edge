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

// The user's own team, plus other teams the user manages (their son Finn's team)
const MY_TEAM = 'Shut Up and Jam Gaiden';
const MANAGED_TEAMS = [MY_TEAM, 'Finn will cook Burt'];

// Teams renamed since the draft: current name -> earlier names
const TEAM_ALIASES = {
  'Cole is like that': ["Cole's aura tuff team"]
};

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

// Projected season totals: per-game stats x projected games played
function projectTeam(roster) {
  const byRk = new Map(PLAYERS.map(p => [p.rk, p]));
  const tot = { fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
  for (const r of roster) {
    const p = byRk.get(r.rk);
    if (!p) continue;
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

// Roto points: best team in a category gets N points, worst gets 1 (ties share the average)
function rotoPoints(teams) {
  const n = teams.length;
  for (const t of teams) t.projRoto = { total: 0 };
  for (const c of CATS) {
    const sorted = [...teams].sort((a, b) => a.projTotals[c] - b.projTotals[c]);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && sorted[j + 1].projTotals[c] === sorted[i].projTotals[c]) j++;
      const pts = (i + 1 + j + 1) / 2;
      for (let k = i; k <= j; k++) sorted[k].projRoto[c] = pts;
      i = j + 1;
    }
  }
  for (const t of teams) {
    t.projRoto.total = CATS.reduce((s, c) => s + t.projRoto[c], 0);
  }
  [...teams].sort((a, b) => b.projRoto.total - a.projRoto.total)
    .forEach((t, i) => { t.projRank = i + 1; });
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
    const t = teamByName.get(name);
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

  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    if (t.type === 'add_drop') {
      const team = getTeam(t.team);
      for (const d of t.drop || []) removeFrom(team, d.name);
      for (const a of t.add || []) {
        team.roster.push(entryFor(a, a.via, t.date));
        team.acquisitions++;
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
      }
    } else {
      throw new Error(`Unknown transaction type: ${t.type}`);
    }
  }
}

function main() {
  const { picks, unmatched } = parseDraft(fs.readFileSync(DRAFT_FILE, 'utf8'));
  const byRk = new Map(PLAYERS.map(p => [p.rk, p]));

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
}

if (require.main === module) main();

module.exports = { parseDraft, projectTeam, rotoPoints, applyTransactions };
