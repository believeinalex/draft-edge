const path = require('path');
const { normName } = require('../engine.js');

/**
 * Booms & busts: season-to-date production vs. draft price.
 *
 * "Earned $" is rank-matched to the draft: the k-th best player by Yahoo's
 * season-to-date total is worth the k-th highest price paid at the draft, and
 * anyone outside the top 180 (the number drafted) is worth $0. Surplus = earned − paid.
 *
 * Drafted players whose NBA team hasn't played yet are left out. Drafted players
 * whose team has played but who haven't (injured or benched) earn $0.
 *
 * Usage: node season/value_report.js [count]   (reads season/league.json and stats/latest.json)
 */

const NBA_TEAM_ALIASES = { SAS: 'SA', PHX: 'PHO', NYK: 'NY', GSW: 'GS', NOP: 'NO' };
const normTeam = t => NBA_TEAM_ALIASES[t] || t;

function valueReport(league, stats) {
  const prices = league.draft.map(p => p.price).sort((a, b) => b - a);
  const ranked = [...stats.players].sort((a, b) => b.yahooTotal - a.yahooTotal);
  const earnedByName = new Map(ranked.map((p, i) => [normName(p.name), i < prices.length ? prices[i] : 0]));
  const teamsPlayed = new Set(stats.players.map(p => p.nbaTeam));

  const owners = new Map();
  for (const t of league.teams) for (const r of t.roster) owners.set(normName(r.name), t.name);

  const rows = [];
  const waiting = [];
  const allRostered = league.teams.flatMap(t => t.roster.map(r => ({ ...r, owner: t.name })));
  const drafted = new Map(league.draft.map(d => [normName(d.name), d]));
  const seen = new Set();
  for (const r of [...league.draft.map(d => ({ ...d, owner: d.team, draftedBy: d.team })), ...allRostered.filter(r => r.acquired !== 'draft')]) {
    const key = normName(r.name);
    if (seen.has(key)) continue;
    seen.add(key);
    const line = r.stats || allRostered.find(a => normName(a.name) === key && a.stats)?.stats;
    const statLine = stats.players.find(p => line && p.rank === line.rank);
    if (!statLine && !teamsPlayed.has(normTeam(r.nbaTeam))) {
      waiting.push(r.name);
      continue;
    }
    const d = drafted.get(key);
    const paid = d ? d.price : 0;
    const earned = statLine ? earnedByName.get(normName(statLine.name)) : 0;
    rows.push({
      name: r.name,
      draftedBy: d ? d.team : null,
      owner: owners.get(key) || 'free agent',
      paid,
      earned,
      surplus: earned - paid,
      yahooRank: statLine ? statLine.rank : null,
      yahooTotal: statLine ? statLine.yahooTotal : null,
      line: statLine
    });
  }
  return { rows, waiting, gamesMax: Math.max(...stats.players.map(p => p.gp)) };
}

function fmtLine(p) {
  if (!p) return 'DNP';
  return `${p.pts}p ${p.treb}r ${p.ast}a ${p.stl}s ${p.blk}b ${p.tpm}3pm, ${p.fgm}/${p.fga} FG, ${p.ftm}/${p.fta} FT`;
}

function main() {
  const league = require(path.join(__dirname, 'league.json'));
  const stats = require(path.join(__dirname, '..', 'stats', 'latest.json'));
  const n = parseInt(process.argv[2], 10) || 10;
  const { rows, waiting } = valueReport(league, stats);
  const mark = r => (r.owner === league.myTeam ? '*' : (league.managedTeams || []).includes(r.owner) ? '+' : ' ');
  const show = (title, list) => {
    console.log(`\n${title}`);
    console.log('   Player                     Paid  Earned  Surplus  YRk  Owner                       Line');
    for (const r of list) {
      const owner = r.draftedBy && r.draftedBy !== r.owner ? `${r.owner} (via ${r.draftedBy})` : r.owner;
      console.log(`${mark(r)}  ${r.name.padEnd(25).slice(0, 25)} ${('$' + r.paid).padStart(5)} ${('$' + r.earned).padStart(7)} ` +
        `${((r.surplus >= 0 ? '+' : '') + r.surplus).padStart(8)}  ${String(r.yahooRank ?? '-').padStart(4)}  ${owner.padEnd(27)} ${fmtLine(r.line)}`);
    }
  };
  console.log(`Stats as of ${stats.asOf}. Earned $ = draft price at the same rank as Yahoo season-to-date total (* mine, + managed).`);
  const draftedRows = rows.filter(r => r.draftedBy);
  show(`Top ${n} booms (drafted players):`, [...draftedRows].sort((a, b) => b.surplus - a.surplus).slice(0, n));
  show(`Top ${n} busts (drafted players):`, [...draftedRows].sort((a, b) => a.surplus - b.surplus).slice(0, n));
  const pickups = rows.filter(r => !r.draftedBy).sort((a, b) => b.earned - a.earned);
  if (pickups.length) show('Post-draft pickups:', pickups);
  if (waiting.length) console.log(`\nNot yet played (team hasn't played): ${waiting.join(', ')}`);
}

if (require.main === module) main();

module.exports = { valueReport };
