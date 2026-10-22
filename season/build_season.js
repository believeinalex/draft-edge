const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { buildNameIndex, matchPlayer, CATS } = require('../engine.js');

/**
 * Builds season/league.json from the official league draft results.
 *
 * Input format (Yahoo draft results, tab-separated):
 *   1.	Tyrese Maxey (PHI - PG)	$54	Grilled Teampura
 *
 * Usage: node season/build_season.js [path-to-draft-results]
 */

const DRAFT_FILE = process.argv[2] || path.join(__dirname, 'draft_2026-10-18.txt');
const OUT_FILE = path.join(__dirname, 'league.json');

// The user's fantasy team name (unknown at time of import)
const MY_TEAM = null;

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
      projZ: p.rk && byRk.has(p.rk) ? byRk.get(p.rk).totalZ : null
    }));
    return {
      name,
      previousNames: TEAM_ALIASES[name] || [],
      spent: roster.reduce((s, r) => s + r.price, 0),
      roster,
      projTotals: projectTeam(roster)
    };
  });
  rotoPoints(teams);

  const league = {
    league: 'LePrawn',
    yahooLeagueId: 45771,
    season: '2026-27',
    draftDate: '2026-10-18',
    myTeam: MY_TEAM,
    generatedFrom: path.relative(path.join(__dirname, '..'), DRAFT_FILE),
    teams: teams.sort((a, b) => a.projRank - b.projRank),
    draft: picks
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(league, null, 2) + '\n');

  console.log(`Parsed ${picks.length} picks across ${teams.length} teams -> ${path.relative(process.cwd(), OUT_FILE)}`);
  for (const t of teams) {
    if (t.roster.length !== 12) console.warn(`Warning: ${t.name} has ${t.roster.length} players (expected 12)`);
  }
  if (unmatched.length) {
    console.log(`Notice: ${unmatched.length} picks could not be matched to players.js: ${unmatched.join(', ')}`);
  }
  console.log('\nProjected Roto Standings (draft-day rosters, full-season projections):');
  console.log('Rk  Team                              $    ' + CATS.map(c => c.padStart(6)).join('') + '   Total');
  for (const t of teams) {
    console.log(
      `${String(t.projRank).padStart(2)}  ${t.name.padEnd(32).slice(0, 32)} ${String(t.spent).padStart(4)}  ` +
      CATS.map(c => String(t.projRoto[c]).padStart(6)).join('') +
      `   ${String(t.projRoto.total).padStart(5)}`
    );
  }
}

if (require.main === module) main();

module.exports = { parseDraft, projectTeam, rotoPoints };
