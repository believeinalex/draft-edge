const path = require('path');
const PLAYERS = require('../players.js');
const { CATS } = require('../engine.js');
const { sumTotals, rotoPoints } = require('./build_season.js');

/**
 * Trade finder: 1-for-1 and 2-for-2 trades that improve BOTH teams' projected roto
 * standings, where the user's team gains more projected roto points than the partner.
 *
 * Projections are the same model as league.json's projRoto: players.js per-game stats
 * x projected GP, summed over every rostered player, scored into roto points across all
 * 15 teams. Only the two teams in a trade change; every other team's totals stay fixed,
 * so a trade can also move points between the two teams and the rest of the league.
 *
 * A trade is listed when:
 *   - my projected roto points go up,
 *   - the partner's projected roto points go up (mutually beneficial), and
 *   - my gain is larger than theirs (I come out ahead), and my projected rank does not drop.
 * Fairness (would they accept it?) is judged by ADP, the best read of how managers value
 * players this early in the season. Each player's ADP is turned into dollars with this
 * league's own draft-price curve (the k-th pick is worth the k-th highest price paid), so
 * a 2-for-2 compares like-for-like: two ADP-50 players are not worth one ADP-1 player.
 * Players with no ADP (undrafted in public drafts) count as $1. By default I may receive at
 * most $5 more ADP value than I send.
 *
 * A 2-for-2 is only listed when it beats every 1-for-1 swap inside it, so it isn't just a
 * good 1-for-1 with filler attached.
 *
 * Usage: node season/trade_finder.js [options]   (npm run trades -- [options])
 *   --team "<name>"     perspective team (default: league.myTeam)
 *   --with "<text>"     only partners whose name contains this text (case-insensitive)
 *   --size 1|2          only 1-for-1 or only 2-for-2 (default: both)
 *   --top N             trades to show (default 15)
 *   --per-team N        at most N trades per partner (default 3)
 *   --min-edge X        my gain must beat theirs by at least X roto points (default 0.5)
 *   --max-adp-gain X    max ADP $ I may receive over what I send (default 5; "off" to disable)
 *   --max-z-gain X      skip trades where I receive more than X projZ over what I send
 *                       (a rough "would they accept it?" filter; off by default)
 *   --include-managed   also trade with other teams the user manages (Finn's), skipped by default
 *   --json              print JSON instead of a table
 */

const byRk = new Map(PLAYERS.map(p => [p.rk, p]));
const CAT_LABEL = { fgPct: 'FG%', ftPct: 'FT%', tpm: '3PM', pts: 'PTS', treb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK' };

// Projected totals for a roster (array of league.json roster entries); unmatched players count as zero
const project = roster => sumTotals(roster.map(r => byRk.get(r.rk)).filter(Boolean));

function scoreLeague(totalsByTeam) {
  const rows = [...totalsByTeam].map(([name, projTotals]) => ({ name, projTotals }));
  rotoPoints(rows);
  return new Map(rows.map(r => [r.name, { roto: r.projRoto, rank: r.projRank }]));
}

function combos(list, k) {
  if (k === 1) return list.map(x => [x]);
  const out = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
  return out;
}

/**
 * Returns every qualifying trade for `teamName`, best first.
 * opts: { partnerFilter, sizes: [1,2], minEdge, includeManaged }
 */
function findTrades(league, teamName, opts = {}) {
  const { partnerFilter = null, sizes = [1, 2], minEdge = 0.5, includeManaged = false, maxZGain = Infinity, maxAdpGain = 5 } = opts;
  const me = league.teams.find(t => t.name === teamName);
  if (!me) throw new Error(`No team named "${teamName}"`);
  const managed = new Set(league.managedTeams || []);

  const baseTotals = new Map(league.teams.map(t => [t.name, project(t.roster)]));
  const base = scoreLeague(baseTotals);

  const partners = league.teams.filter(t => t.name !== me.name &&
    (includeManaged || !managed.has(t.name) || !managed.has(me.name)) &&
    (!partnerFilter || t.name.toLowerCase().includes(partnerFilter.toLowerCase())));

  const trades = [];
  for (const them of partners) {
    // Best 1-for-1 result per pair, so 2-for-2s can be checked against the swaps inside them
    const oneForOne = new Map();
    const evaluate = (give, get) => {
      const giveSet = new Set(give), getSet = new Set(get);
      const myRoster = me.roster.filter(r => !giveSet.has(r)).concat(get);
      const theirRoster = them.roster.filter(r => !getSet.has(r)).concat(give);
      const totals = new Map(baseTotals);
      totals.set(me.name, project(myRoster));
      totals.set(them.name, project(theirRoster));
      const after = scoreLeague(totals);
      return {
        give, get, partner: them.name,
        myBefore: base.get(me.name), myAfter: after.get(me.name),
        theirBefore: base.get(them.name), theirAfter: after.get(them.name),
        myGain: after.get(me.name).roto.total - base.get(me.name).roto.total,
        theirGain: after.get(them.name).roto.total - base.get(them.name).roto.total
      };
    };
    const qualifies = t => t.myGain > 0 && t.theirGain > 0 && t.myGain - t.theirGain >= minEdge &&
      t.myAfter.rank <= t.myBefore.rank;

    // Always score 1-for-1s (2-for-2s are compared against them)
    for (const g of me.roster) for (const r of them.roster) {
      const t = evaluate([g], [r]);
      oneForOne.set(`${g.name}|${r.name}`, t);
      if (sizes.includes(1) && qualifies(t)) trades.push(t);
    }
    if (sizes.includes(2)) {
      for (const give of combos(me.roster, 2)) for (const get of combos(them.roster, 2)) {
        const t = evaluate(give, get);
        if (!qualifies(t)) continue;
        const inner = give.flatMap(g => get.map(r => oneForOne.get(`${g.name}|${r.name}`)));
        if (inner.some(s => qualifies(s) && s.myGain >= t.myGain)) continue;
        trades.push(t);
      }
    }
  }
  const projZ = list => list.reduce((s, r) => s + (r.projZ || 0), 0);
  const adpDollars = adpValuer(league);
  const adp$ = list => list.reduce((s, r) => s + adpDollars(adpOf(r)), 0);
  for (const t of trades) {
    t.zBalance = +(projZ(t.get) - projZ(t.give)).toFixed(2);
    t.adpGet = +adp$(t.get).toFixed(1);
    t.adpGive = +adp$(t.give).toFixed(1);
    t.adpBalance = +(t.adpGet - t.adpGive).toFixed(1);
  }
  const fair = trades.filter(t => t.zBalance <= maxZGain && t.adpBalance <= maxAdpGain);
  trades.length = 0;
  trades.push(...fair);
  // Best for me first; then the more even trade (more likely to be accepted)
  trades.sort((a, b) => b.myGain - a.myGain || b.theirGain - a.theirGain || a.adpBalance - b.adpBalance);
  return { team: me.name, base: base.get(me.name), trades };
}

const adpOf = r => (byRk.get(r.rk) || {}).adp ?? null;

// ADP -> $: the league's draft prices sorted high to low, read at pick number ADP (interpolated)
function adpValuer(league) {
  const prices = league.draft.map(p => p.price).sort((a, b) => b - a);
  return adp => {
    if (adp == null) return 1;
    const i = Math.max(0, adp - 1);
    const lo = Math.floor(i), hi = Math.min(lo + 1, prices.length - 1);
    if (lo >= prices.length) return 1;
    return prices[lo] + (prices[hi] - prices[lo]) * (i - lo);
  };
}

function catSwing(before, after) {
  return CATS.map(c => [c, after.roto[c] - before.roto[c]]).filter(([, d]) => d !== 0)
    .map(([c, d]) => `${d > 0 ? '+' : ''}${d} ${CAT_LABEL[c]}`).join(', ');
}

function fmtPlayer(r) {
  const inj = r.injury && r.injury.status ? ` [${r.injury.status}]` : '';
  const adp = adpOf(r);
  const z = r.projZ == null ? 'unproj.' : (r.projZ >= 0 ? '+' : '') + r.projZ.toFixed(1) + 'z';
  return `${r.name}${inj} (ADP ${adp == null ? '-' : adp}, ${z})`;
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--team') opts.team = val();
    else if (a === '--with') opts.partnerFilter = val();
    else if (a === '--size') opts.sizes = [parseInt(val(), 10)];
    else if (a === '--top') opts.top = parseInt(val(), 10);
    else if (a === '--per-team') opts.perTeam = parseInt(val(), 10);
    else if (a === '--min-edge') opts.minEdge = parseFloat(val());
    else if (a === '--max-adp-gain') { const v = val(); opts.maxAdpGain = v === 'off' ? Infinity : parseFloat(v); }
    else if (a === '--max-z-gain') opts.maxZGain = parseFloat(val());
    else if (a === '--include-managed') opts.includeManaged = true;
    else if (a === '--json') opts.json = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return opts;
}

function main() {
  const league = require(path.join(__dirname, 'league.json'));
  const opts = parseArgs(process.argv.slice(2));
  const top = opts.top || 15, perTeam = opts.perTeam || 3;
  const { team, base, trades } = findTrades(league, opts.team || league.myTeam, opts);

  const shown = [];
  const count = new Map();
  for (const t of trades) {
    if ((count.get(t.partner) || 0) >= perTeam) continue;
    count.set(t.partner, (count.get(t.partner) || 0) + 1);
    shown.push(t);
    if (shown.length >= top) break;
  }

  if (opts.json) {
    const slim = r => ({ name: r.name, adp: adpOf(r), projZ: r.projZ, injury: r.injury || null });
    console.log(JSON.stringify(shown.map(t => ({
      partner: t.partner, give: t.give.map(slim), get: t.get.map(slim), myGain: t.myGain, theirGain: t.theirGain,
      myRank: [t.myBefore.rank, t.myAfter.rank], theirRank: [t.theirBefore.rank, t.theirAfter.rank], zBalance: t.zBalance, adpGet: t.adpGet, adpGive: t.adpGive
    })), null, 2));
    return;
  }

  console.log(`Trade finder for ${team}: projected ${base.roto.total} roto pts, rank ${base.rank} of ${league.teams.length}.`);
  console.log(`Projections as of ${league.asOf || 'latest build'} (players.js per-game x projected GP; positions and the weekly lineup lock are not modeled).`);
  console.log(`${trades.length} trades raise both teams' projected roto points with me gaining more and pass the ADP fairness check; showing ${shown.length} (max ${perTeam} per partner).\n`);
  if (!shown.length) {
    console.log('No qualifying trades. Try --max-adp-gain 10, --min-edge 0 or --include-managed.');
    return;
  }
  shown.forEach((t, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${t.give.length}-for-${t.get.length} with ${t.partner}`);
    console.log(`    Give: ${t.give.map(fmtPlayer).join(' + ')}`);
    console.log(`    Get:  ${t.get.map(fmtPlayer).join(' + ')}`);
    console.log(`    Me:   +${t.myGain} pts (${t.myBefore.roto.total} -> ${t.myAfter.roto.total}, rank ${t.myBefore.rank} -> ${t.myAfter.rank})  ${catSwing(t.myBefore, t.myAfter)}`);
    console.log(`    Them: +${t.theirGain} pts (${t.theirBefore.roto.total} -> ${t.theirAfter.roto.total}, rank ${t.theirBefore.rank} -> ${t.theirAfter.rank})  ${catSwing(t.theirBefore, t.theirAfter)}`);
    const sign = x => (x >= 0 ? '+' : '') + x;
    console.log(`    ADP value: get $${t.adpGet} vs give $${t.adpGive} (${sign(t.adpBalance)});  projZ ${sign(t.zBalance)}\n`);
  });
}

if (require.main === module) main();

module.exports = { findTrades };
