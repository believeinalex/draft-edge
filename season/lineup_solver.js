#!/usr/bin/env node
/**
 * Weekly lineup solver.
 *
 * For a managed team, finds the 9-man active lineup (PG, SG, SF, PF, C + 4 Util, positions enforced)
 * that maximises the team's EXPECTED roto points at the end of the target Monday-to-Sunday week.
 *
 * - Starting totals: the latest daily report's standings (reports/YYYY-MM-DD.json). If the report
 *   is from before the target week, its end-of-week projection (`eow`) is the base; otherwise `now`.
 * - Next week: each player's games (season/schedule_cache.json) x per-game projection (players.js;
 *   `--blend` mixes in season-to-date stats) x availability (Yahoo injury status, ESPN return dates).
 * - Other teams: their locked lineup for the target week if one has been pasted, otherwise their best
 *   healthy nine by projected value.
 * - Objective: expected roto points = sum over categories of 1 + sum over rivals P(beat rival), using a
 *   normal approximation of each team's week-end total (game-to-game variance, injury uncertainty and
 *   shooting luck). This is smooth, so near-ties count for half a point instead of flipping whole ranks.
 * - Search: every legal 9-player subset of the roster (a few hundred to a few thousand), exhaustively.
 *
 * Usage: node season/lineup_solver.js [--team Finn] [--week YYYY-MM-DD] [--top 5] [--blend] [--json] [--swap "In:Out" ...]
 * Default teams: both managed teams. Default week: the week starting today if today is Monday, else next Monday.
 */
const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { normName } = require('../engine.js');
const { activeLineups, mondayOf, buildScorer } = require('./morning_report.js');

const ROOT = path.join(__dirname, '..');
const CATS = ['fgPct', 'ftPct', 'tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const COUNT = ['tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
const ESPN_TEAM = { WAS: 'WSH', SAS: 'SA', NOP: 'NO', NYK: 'NY', GSW: 'GS', UTA: 'UTAH', PHO: 'PHX' };
const PLAY_WEIGHT = { O: 0, D: 0, INJ: 0, SUSP: 0, Q: 0.5, GTD: 0.5, DTD: 0.5, P: 0.9 };
// Game-to-game coefficient of variation of each counting stat (roughly Poisson-like for the rare ones)
const CV = { tpm: 0.7, pts: 0.35, treb: 0.4, ast: 0.45, stl: 0.8, blk: 0.9 };

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const datedFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().map(f => path.join(dir, f)) : [];
const addDays = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const etToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Standard normal CDF (Abramowitz-Stegun)
function phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

// Can these players fill PG, SG, SF, PF and C (one each)? The 4 Util slots take anyone.
function feasible(posLists) {
  const match = (i, used) => {
    if (i === SLOTS.length) return true;
    for (let k = 0; k < posLists.length; k++) {
      if (used & (1 << k) || !posLists[k].includes(SLOTS[i])) continue;
      if (match(i + 1, used | (1 << k))) return true;
    }
    return false;
  };
  return match(0, 0);
}
// One legal slot assignment for display
function assignSlots(players) {
  const out = {};
  const go = (i, used) => {
    if (i === SLOTS.length) return true;
    for (let k = 0; k < players.length; k++) {
      if (used.has(k) || !players[k].pos.includes(SLOTS[i])) continue;
      used.add(k); out[SLOTS[i]] = players[k];
      if (go(i + 1, used)) return true;
      used.delete(k);
    }
    return false;
  };
  go(0, new Set());
  const placed = new Set(Object.values(out));
  out.Util = players.filter(p => !placed.has(p));
  return out;
}
function combos(arr, k) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

/**
 * Expected roto points for every team from per-category means and standard deviations.
 * dist: Map(team -> {cat: {mean, sd}}). Higher is better in every category.
 */
function expectedRoto(dist) {
  const names = [...dist.keys()];
  const out = new Map(names.map(n => [n, { total: 0 }]));
  for (const c of CATS) {
    for (const a of names) {
      const A = dist.get(a)[c];
      let pts = 1;
      for (const b of names) {
        if (b === a) continue;
        const B = dist.get(b)[c];
        const s = Math.sqrt(A.sd ** 2 + B.sd ** 2) || 1e-9;
        pts += phi((A.mean - B.mean) / s);
      }
      out.get(a)[c] = pts;
      out.get(a).total += pts;
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i === -1 ? null : args[i + 1]; };
  const flag = k => args.includes(k);
  const league = readJson(path.join(__dirname, 'league.json'));
  const today = etToday();
  const weekStart = opt('--week') || (new Date(today + 'T12:00:00Z').getUTCDay() === 1 ? today : addDays(mondayOf(today), 7));
  const days = [...Array(7).keys()].map(i => addDays(weekStart, i));
  const topN = parseInt(opt('--top') || '5', 10);
  const blend = flag('--blend');

  // Schedule
  const sched = readJson(path.join(__dirname, 'schedule_cache.json')).days || {};
  const missing = days.filter(d => !sched[d]);
  const plays = (team, d) => (sched[d] || []).some(g => g.includes(ESPN_TEAM[team] || team));

  // Base totals from the latest report
  const repFile = datedFiles(path.join(ROOT, 'reports')).pop();
  if (!repFile) throw new Error('No daily report JSON in reports/; run npm run report first');
  const rep = readJson(repFile);
  const repDate = path.basename(repFile, '.json');
  const useEow = repDate < weekStart;

  // Projections and availability
  const projBy = new Map(PLAYERS.map(p => [normName(p.name), p]));
  const stats = readJson(path.join(ROOT, 'stats', 'latest.json'));
  const statBy = new Map(stats.players.map(p => [normName(p.name), p]));
  const KEYS = ['fgm', 'fga', 'ftm', 'fta', ...COUNT];
  const rateOf = name => {
    const k = normName(name), p = projBy.get(k), s = statBy.get(k);
    if (!p && !s) return null;
    if (!p) return Object.fromEntries(KEYS.map(x => [x, s[x] || 0]));
    if (!blend || !s || !s.gp) return Object.fromEntries(KEYS.map(x => [x, p[x] || 0]));
    const w = s.gp / (s.gp + 20);
    return Object.fromEntries(KEYS.map(x => [x, w * (s[x] || 0) + (1 - w) * (p[x] || 0)]));
  };
  const injFile = datedFiles(path.join(__dirname, 'injuries')).pop();
  const injBy = new Map(injFile ? readJson(injFile).players.map(p => [normName(p.name), p.status]) : []);
  const newsFile = datedFiles(path.join(__dirname, 'news')).pop();
  const retBy = new Map();
  if (newsFile) for (const i of readJson(newsFile).injuries || []) if (i.returnDate) retBy.set(normName(i.name), i.returnDate.slice(0, 10));
  const weight = (name, d) => {
    const k = normName(name);
    const w = PLAY_WEIGHT[injBy.get(k)] ?? 1;
    return w === 0 && retBy.has(k) && d >= retBy.get(k) ? 0.7 : w;
  };

  // Per-player weekly contribution: mean and variance of each stat
  const contrib = r => {
    const rate = rateOf(r.name);
    if (!rate) return null;
    const team = r.nbaTeam;
    const m = Object.fromEntries(KEYS.map(k => [k, 0])), v = Object.fromEntries(KEYS.map(k => [k, 0]));
    let games = 0, sched = 0;
    for (const d of days) {
      if (!plays(team, d)) continue;
      sched++;
      const w = weight(r.name, d);
      if (!w) continue;
      games += w;
      for (const k of KEYS) {
        const mu = rate[k] || 0;
        m[k] += w * mu;
        const cv = CV[k] ?? 0.35;
        v[k] += w * (cv * mu) ** 2 + w * (1 - w) * mu * mu;
      }
      // Shooting luck: binomial variance on makes given attempts
      const fgp = rate.fga ? rate.fgm / rate.fga : 0, ftp = rate.fta ? rate.ftm / rate.fta : 0;
      v.fgm += w * rate.fga * fgp * (1 - fgp);
      v.ftm += w * rate.fta * ftp * (1 - ftp);
    }
    return { name: r.name, pos: r.pos || [], nbaTeam: team, games, sched, m, v, rate };
  };

  // Base totals and attempt estimates for every team
  const teamByName = new Map(league.teams.map(t => [t.name, t]));
  const base = new Map();
  for (const t of rep.teams) {
    const tot = useEow ? t.eow : t.now;
    const gp = t.gpNow + (useEow ? (t.gamesEow || 0) : 0);
    const lt = teamByName.get(t.name);
    const rates = (lt ? lt.roster : []).map(r => rateOf(r.name)).filter(Boolean).sort((a, b) => (b.fga + b.fta) - (a.fga + a.fta)).slice(0, 10);
    const avg = k => rates.length ? rates.reduce((s, r) => s + r[k], 0) / rates.length : (k === 'fga' ? 12 : 3);
    const fga = avg('fga') * gp, fta = avg('fta') * gp;
    base.set(t.name, { fgm: tot.fgPct * fga, fga, ftm: tot.ftPct * fta, fta, ...Object.fromEntries(COUNT.map(c => [c, tot[c]])) });
  }

  // Each team's weekly roster options
  const lineupFile = datedFiles(path.join(__dirname, 'lineups')).filter(f => path.basename(f, '.json') >= weekStart && path.basename(f, '.json') <= days[6]).pop();
  const locked = lineupFile ? activeLineups(league, readJson(lineupFile), projBy) : new Map();
  // Projected value used to pick other teams' nine (and as a comparison lineup): games x (per-game
  // 8-cat z-score - replacement level), the same scale as the morning report
  const score = buildScorer();
  const REPL = -3.5;
  const value = c => (c.games || 0) * (score(c.rate) - REPL);
  const bestByValue = cs => {
    const healthy = cs.filter(c => c.games > 0);
    const k = Math.min(9, healthy.length);
    let best = null, bv = -Infinity;
    for (const s of combos(healthy, k)) {
      if (k === 9 && !feasible(s.map(c => c.pos))) continue;
      const v = s.reduce((a, c) => a + value(c), 0);
      if (v > bv) { bv = v; best = s; }
    }
    return best || healthy.slice(0, 9);
  };
  const weekly = new Map();
  for (const t of league.teams) {
    const cs = t.roster.map(contrib).filter(Boolean);
    let lineup;
    const lk = locked.get(t.name);
    if (lk) lineup = lk.players.map(p => cs.find(c => normName(c.name) === normName(p.name))).filter(Boolean);
    else lineup = bestByValue(cs);
    weekly.set(t.name, { all: cs, lineup, source: lk ? 'locked' : 'best nine' });
  }

  const distFor = (teamName, lineup) => {
    const b = base.get(teamName);
    if (!b) return null;
    const s = { ...b }, v = Object.fromEntries(['fgm', 'fga', 'ftm', 'fta', ...COUNT].map(k => [k, 0]));
    for (const c of lineup) for (const k of Object.keys(v)) { s[k] += c.m[k]; v[k] += c.v[k]; }
    const out = {};
    out.fgPct = { mean: s.fgm / s.fga, sd: Math.sqrt(v.fgm) / s.fga + 1e-6 };
    out.ftPct = { mean: s.ftm / s.fta, sd: Math.sqrt(v.ftm) / s.fta + 1e-6 };
    for (const c of COUNT) out[c] = { mean: s[c], sd: Math.sqrt(v[c]) + 1e-6 };
    return out;
  };
  const baseDist = new Map();
  for (const [name, w] of weekly) { const d = distFor(name, w.lineup); if (d) baseDist.set(name, d); }

  const want = opt('--team');
  const managed = want ? league.teams.filter(t => t.name.toLowerCase().includes(want.toLowerCase())).map(t => t.name)
    : [league.myTeam, ...(league.managedTeams || ['Finn will turn Bert into bacon'])].filter((x, i, a) => x && a.indexOf(x) === i && teamByName.has(x));

  const results = [];
  const md = [`# Lineup solver: week of ${weekStart}`, '',
    `Base totals: ${useEow ? 'end-of-week projection' : 'current totals'} from reports/${repDate}.json (standings base ${rep.base}). Projections: ${blend ? 'players.js blended with season-to-date stats' : 'players.js per-game'} x games x availability. Other teams: ${lineupFile ? `locked lineups from ${path.basename(lineupFile)}` : 'their best healthy nine'}.`
    + (missing.length ? ` WARNING: no schedule for ${missing.join(', ')}.` : ''), ''];
  for (const name of managed) {
    const w = weekly.get(name);
    const pool = w.all.filter(c => c.games > 0);
    const k = Math.min(9, pool.length);
    const scored = [];
    for (const s of combos(pool, k)) {
      if (k === 9 && !feasible(s.map(c => c.pos))) continue;
      const dist = new Map(baseDist);
      dist.set(name, distFor(name, s));
      const r = expectedRoto(dist).get(name);
      scored.push({ lineup: s, exp: r.total, cats: r });
    }
    scored.sort((a, b) => b.exp - a.exp);
    const best = scored[0];
    const byValue = bestByValue(w.all);
    const dv = new Map(baseDist); dv.set(name, distFor(name, byValue));
    const valueExp = expectedRoto(dv).get(name);
    const slots = assignSlots(best.lineup);
    const bench = w.all.filter(c => !best.lineup.includes(c));
    md.push(`## ${name}`, '');
    md.push(`**Best lineup: ${best.exp.toFixed(1)} expected roto points** at the end of the week (${scored.length} legal lineups checked; best-nine-by-projected-value lineup: ${valueExp.total.toFixed(1)}).`, '');
    md.push('| Slot | Player | Games | Per game (proj) |', '|---|---|---|---|');
    const line = c => `${c.rate.pts.toFixed(1)}p ${c.rate.treb.toFixed(1)}r ${c.rate.ast.toFixed(1)}a ${c.rate.stl.toFixed(1)}s ${c.rate.blk.toFixed(1)}b ${c.rate.tpm.toFixed(1)} 3s`;
    for (const sl of SLOTS) if (slots[sl]) md.push(`| ${sl} | ${slots[sl].name} | ${slots[sl].games.toFixed(1)}${slots[sl].games < slots[sl].sched ? ` of ${slots[sl].sched}` : ''} | ${line(slots[sl])} |`);
    for (const c of slots.Util) md.push(`| Util | ${c.name} | ${c.games.toFixed(1)}${c.games < c.sched ? ` of ${c.sched}` : ''} | ${line(c)} |`);
    md.push('', `Bench: ${bench.map(c => `${c.name} (${c.games.toFixed(1)}${c.games < c.sched ? ` of ${c.sched}` : ''} g)`).join(', ') || 'none'}.`, '');
    md.push(`Expected category points: ${CATS.map(c => `${c} ${best.cats[c].toFixed(1)}`).join(', ')}.`, '');
    // Swap table: best single change for each bench player
    md.push('| Swap in (bench) | For | Change |', '|---|---|---|');
    for (const b of bench.filter(c => c.games > 0)) {
      let bestSwap = null;
      for (const out of best.lineup) {
        const s = best.lineup.filter(c => c !== out).concat([b]);
        if (!feasible(s.map(c => c.pos))) continue;
        const hit = scored.find(x => x.lineup.length === s.length && s.every(c => x.lineup.includes(c)));
        if (hit && (!bestSwap || hit.exp > bestSwap.exp)) bestSwap = { out, exp: hit.exp };
      }
      if (bestSwap) md.push(`| ${b.name} | ${bestSwap.out.name} | ${(bestSwap.exp - best.exp).toFixed(2)} |`);
    }
    // Requested swaps: --swap "In Player:Out Player" (repeatable)
    const swaps = args.map((a, i) => a === '--swap' ? args[i + 1] : null).filter(Boolean);
    for (const sw of swaps) {
      const [inN, outN] = sw.split(':').map(x => x.trim().toLowerCase());
      const inP = w.all.find(c => c.name.toLowerCase().includes(inN)), outP = best.lineup.find(c => c.name.toLowerCase().includes(outN));
      if (!inP || !outP) { md.push(`Swap "${sw}": player not found in this lineup/roster.`); continue; }
      const s = best.lineup.filter(c => c !== outP).concat([inP]);
      const hit = scored.find(x => s.every(c => x.lineup.includes(c)));
      md.push(hit ? `Swap ${inP.name} in for ${outP.name}: ${hit.exp.toFixed(1)} expected (${(hit.exp - best.exp).toFixed(2)}); categories ${CATS.map(c => `${c} ${(hit.cats[c] - best.cats[c] >= 0 ? '+' : '')}${(hit.cats[c] - best.cats[c]).toFixed(2)}`).join(', ')}.`
        : `Swap ${inP.name} in for ${outP.name}: not a legal lineup (positions).`);
    }
    md.push('', `Next best lineups: ${scored.slice(1, topN).map(x => `${x.exp.toFixed(1)} (bench ${w.all.filter(c => !x.lineup.includes(c) && c.games > 0).map(c => c.name.split(' ').slice(-1)[0]).join(', ')})`).join('; ')}.`, '');
    results.push({ team: name, week: weekStart, expected: best.exp, cats: best.cats, lineup: Object.fromEntries([...SLOTS.filter(s => slots[s]).map(s => [s, slots[s].name]), ['Util', slots.Util.map(c => c.name)]]), bench: bench.map(c => c.name), byValueExpected: valueExp.total });
  }
  if (flag('--json')) console.log(JSON.stringify(results, null, 2));
  else console.log(md.join('\n'));
  return results;
}

if (require.main === module) main();

module.exports = { phi, feasible, assignSlots, expectedRoto, combos };
