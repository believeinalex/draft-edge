const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { normName, CATS } = require('../engine.js');
const { activeLineups, mondayOf } = require('./morning_report.js');
const {
  COUNT, SUMS, readJson, zeroLine, findTeam, datedFiles, addDays, scheduleFor, espnTeam,
  baseStandings, playWeights, sourceFor, projectPlayers
} = require('./standings_model.js');

/**
 * Monday lineup optimizer. For each managed team, tries every legal 9-man active lineup for
 * the coming week and scores it by expected roto points at the END OF THE SEASON, from a
 * Monte Carlo of next week's games and the rest of the season for all 15 teams.
 *
 * Model (see LINEUP_MODEL below for the constants):
 * - Base: latest complete Yahoo standings + games since (rebuilt from stats), plus the
 *   expected rest of the current week from each team's locked lineup.
 * - Next week: every active player's scheduled games (ESPN), each played with probability
 *   from his injury status (healthy 0.95, P 0.9, Q 0.5, O/D 0; an out player counts 0.7 from
 *   his ESPN return date). Per-game rates blend players.js projections with season-to-date stats, scaled by a shared
 *   weekly role factor, with game-to-game noise per category; makes are binomial on attempts.
 * - Opponents' next-week lineup: their current locked actives they still own, filled to 9
 *   by projected value × games. The other managed team is treated the same way.
 * - Rest of season: each team's top 9 by projection plays its NBA team's remaining games ×
 *   projected availability (projected GP / 82), with a per-player projection error.
 * - Score: roto points in each category vs the 14 other teams, averaged over simulations.
 *   All lineups share the same random draws, so differences between them are precise.
 *   "End of week" points (next Sunday's standings, no rest of season) are shown alongside:
 *   they react to bunched-up categories much more than the season-end score does.
 *
 * Usage: node season/lineup_optimizer.js [--team="Name"] [--sims=4000] [--week=YYYY-MM-DD] [--seed=1]
 * (npm run lineup). Writes reports/YYYY-MM-DD-lineup.md. REPORT_DATE=YYYY-MM-DD overrides today.
 */

const ROOT = path.join(__dirname, '..');
const LINEUP_MODEL = {
  healthyPlay: 0.95,      // chance a healthy player plays a scheduled game (rest, late scratches)
  weekRoleSd: 0.12,       // lognormal sd of a player's rates for one week (minutes/role swings)
  rosPlayerSd: 0.2,       // lognormal sd of a player's rest-of-season output (projection error, injury)
  rosPctSd: { fg: 0.02, ft: 0.04 },  // sd of a player's true rest-of-season FG% / FT%
  // Variance-to-mean ratio of one game's total (Poisson = 1; points come in 2s and 3s)
  disp: { pts: 2.5, treb: 1.4, ast: 1.4, stl: 1.1, blk: 1.3, tpm: 1.3, fga: 1.2, fta: 1.6 },
  seasonGames: 82,
  // Per-game rates blend the projection with season-to-date stats: the season line gets
  // weight gp / (gp + statsPrior), so 10 games count about a third and 20 games half
  statsPrior: 20,
  slots: ['PG', 'SG', 'SF', 'PF', 'C'],
  starters: 9
};

// ---- random numbers (seeded, so reruns match) ----
function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  const n = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, r;
    do { x = u() * 2 - 1; y = u() * 2 - 1; r = x * x + y * y; } while (r >= 1 || r === 0);
    const m = Math.sqrt(-2 * Math.log(r) / r);
    spare = y * m;
    return x * m;
  };
  return { u, n };
}

const K = SUMS.length; // fgm fga ftm fta tpm pts treb ast stl blk
const IDX = Object.fromEntries(SUMS.map((k, i) => [k, i]));

// One player's stat totals over a stretch: g games at rates r scaled by factor f, with
// game noise. pctNoise shifts his shooting percentages (rest-of-season uncertainty).
function drawLine(r, g, f, R, out, off, pctNoise = { fg: 0, ft: 0 }) {
  if (g <= 0) return;
  const D = LINEUP_MODEL.disp;
  const noisy = (mean, disp) => (mean > 0 ? Math.max(0, mean + R.n() * Math.sqrt(disp * mean)) : 0);
  for (const c of COUNT) out[off + IDX[c]] += noisy((r[c] || 0) * g * f, D[c]);
  for (const [m, a, key] of [['fgm', 'fga', 'fg'], ['ftm', 'fta', 'ft']]) {
    const att = noisy((r[a] || 0) * g * f, D[a]);
    if (!att) continue;
    const p = Math.min(0.98, Math.max(0.05, (r[a] ? r[m] / r[a] : 0) + pctNoise[key]));
    const made = Math.min(att, Math.max(0, att * p + R.n() * Math.sqrt(att * p * (1 - p))));
    out[off + IDX[a]] += att;
    out[off + IDX[m]] += made;
  }
}

// Category values from summed makes/attempts/counts (CATS order)
function catValues(v, off = 0) {
  return [
    v[off + IDX.fga] ? v[off + IDX.fgm] / v[off + IDX.fga] : 0,
    v[off + IDX.fta] ? v[off + IDX.ftm] / v[off + IDX.fta] : 0,
    ...COUNT.map(c => v[off + IDX[c]])
  ];
}

// Largest number of PG/SG/SF/PF/C slots a set of players can fill (each player once)
function slotCoverage(players) {
  const slots = LINEUP_MODEL.slots;
  let best = 0;
  const used = new Array(players.length).fill(false);
  const go = (si, filled) => {
    if (filled + (slots.length - si) <= best) return;
    if (si === slots.length) { best = Math.max(best, filled); return; }
    for (let i = 0; i < players.length; i++) {
      if (!used[i] && (players[i].pos || []).includes(slots[si])) {
        used[i] = true; go(si + 1, filled + 1); used[i] = false;
        if (best === slots.length) return;
      }
    }
    go(si + 1, filled);
  };
  go(0, 0);
  return best;
}

function combinations(n, k) {
  const out = [];
  const cur = [];
  const go = start => {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = start; i <= n - (k - cur.length); i++) { cur.push(i); go(i + 1); cur.pop(); }
  };
  go(0);
  return out;
}

// Per-game rates: projection blended with the season-to-date line, weighted by games played
function blendRates(proj, season, prior = LINEUP_MODEL.statsPrior) {
  if (!proj) return season || null;
  if (!season || !season.gp) return proj;
  const w = season.gp / (season.gp + prior);
  const out = { ...proj };
  for (const c of SUMS) out[c] = (1 - w) * (proj[c] || 0) + w * (season[c] || 0);
  out.statsWeight = w;
  return out;
}

const parseArgs = argv => Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => {
  const [k, ...v] = a.slice(2).split('=');
  return [k, v.length ? v.join('=') : true];
}));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const today = process.env.REPORT_DATE || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const thisMon = mondayOf(today);
  const targetMon = args.week ? mondayOf(args.week) : (today === thisMon ? thisMon : addDays(thisMon, 7));
  const targetDays = [...Array(7).keys()].map(i => addDays(targetMon, i));
  const restDays = [];
  for (let d = today; d < targetMon; d = addDays(d, 1)) restDays.push(d);
  const sims = +args.sims || 4000;
  const R = rng(+args.seed || 1);
  const warn = [];

  const league = readJson(path.join(__dirname, 'league.json'));
  const projByName = new Map(PLAYERS.map(p => [normName(p.name), p]));
  const snaps = datedFiles(path.join(ROOT, 'stats', 'snapshots'));
  const cur = readJson(snaps[snaps.length - 1]);
  const statLine = new Map(cur.players.map(p => [normName(p.name), p]));
  const lineupFiles = datedFiles(path.join(__dirname, 'lineups'));
  const lineupSnap = lineupFiles.length ? readJson(lineupFiles[lineupFiles.length - 1]) : null;
  const active = activeLineups(league, lineupSnap, projByName);
  const activeKey = new Map();
  for (const [team, a] of active) for (const r of a.players) activeKey.set(normName(r.name), team);
  if (league.lineupAsOf && mondayOf(league.lineupAsOf) !== thisMon) {
    warn.push(`The latest locked lineup (${league.lineupAsOf}) is from an earlier week, so "carried over" lineups and the rest of this week use it anyway.`);
  }
  const injFiles = datedFiles(path.join(__dirname, 'injuries'));
  const injBy = new Map((injFiles.length ? readJson(injFiles[injFiles.length - 1]).players : []).map(p => [normName(p.name), p]));
  const playWeight = playWeights({ injBy, newsFiles: datedFiles(path.join(__dirname, 'news')), today, warn });

  const base = baseStandings({ league, snaps, cur, active, activeKey, stFiles: datedFiles(path.join(__dirname, 'standings')), warn });
  if (!base) throw new Error('No Yahoo standings saved yet (season/standings).');

  // Schedules for the rest of this week and all of next week
  const sched = new Map();
  await Promise.all([...restDays, ...targetDays].map(async d => {
    try { sched.set(d, await scheduleFor(d)); } catch (e) { sched.set(d, new Set()); warn.push(`Couldn't load the ${d} schedule: ${e.message}`); }
  }));
  const ctx = { sched, playWeight, projByName, statLine };

  // NBA team games played so far (from the stats snapshot) and remaining after next week
  const teamGp = new Map();
  for (const p of cur.players) {
    const t = espnTeam(p.nbaTeam);
    teamGp.set(t, Math.max(teamGp.get(t) || 0, p.gp));
  }
  const gamesIn = (team, days) => days.filter(d => sched.get(d).has(espnTeam(team))).length;
  const rosGamesFor = team => Math.max(0, LINEUP_MODEL.seasonGames - (teamGp.get(espnTeam(team)) || 0) - gamesIn(team, restDays) - gamesIn(team, targetDays));

  // Player info used by the simulation
  const info = name => {
    const { k, team } = sourceFor(name, projByName, statLine);
    const src = blendRates(projByName.get(k), statLine.get(k), +args.prior || LINEUP_MODEL.statsPrior);
    const proj = projByName.get(k);
    const days = targetDays.map(d => (src && sched.get(d).has(espnTeam(team)) ? playWeight(k, d) : 0));
    const games = days.filter(w => w > 0).length;
    const expGames = days.reduce((s, w) => s + (w === 1 ? LINEUP_MODEL.healthyPlay : w), 0);
    const avail = proj ? Math.min(1, (proj.gp || LINEUP_MODEL.seasonGames) / LINEUP_MODEL.seasonGames) : 0.8;
    const z = proj ? proj.totalZ : (statLine.get(k) ? -1 : -99);
    return { name, k, src, team, days, games, expGames, avail, z, status: playWeight.status(k), ret: playWeight.returnDate(k) };
  };

  // Each team's next-week lineup if it doesn't change anything: current locked actives it
  // still owns, filled to 9 with owned players by projected value × games next week
  const carriedOver = t => {
    const owned = t.roster.map(r => ({ ...info(r.name), pos: r.pos }));
    const ownedKeys = new Set(owned.map(p => p.k));
    const act = ((active.get(t.name) || {}).players || []).map(p => normName(p.name)).filter(k => ownedKeys.has(k));
    const keep = owned.filter(p => act.includes(p.k));
    const rest = owned.filter(p => !act.includes(p.k)).sort((a, b) => (b.z + 3) * b.expGames - (a.z + 3) * a.expGames);
    return { owned, lineup: keep.concat(rest).slice(0, LINEUP_MODEL.starters) };
  };
  // Rest-of-season regulars: top 9 owned by projection × availability
  const rosPlayers = t => t.roster.map(r => info(r.name)).filter(p => p.src)
    .sort((a, b) => b.z * b.avail - a.z * a.avail).slice(0, LINEUP_MODEL.starters);

  // Base totals per team: now + expected rest of the current week (locked lineup)
  const baseT = new Map();
  for (const row of base.rows) {
    const a = active.get(row.team) || { players: [] };
    const { add } = projectPlayers(a.players, restDays, ctx);
    baseT.set(row.team, SUMS.map(k => row.nowT[k] + add[k]));
  }
  const teamNames = base.rows.map(r => r.team);

  // ---- simulate ----
  // Draws per team: rest of season (sums), and next-week lines for each player who might be
  // active (opponents: carried-over lineup; managed team being optimized: whole roster).
  const simTeam = (players, kind, buf) => {
    // buf: Float64Array(sims * K)
    for (let s = 0; s < sims; s++) {
      const off = s * K;
      for (const p of players) {
        if (kind === 'week') {
          let g = 0;
          for (const w of p.days) if (w > 0 && R.u() < (w === 1 ? LINEUP_MODEL.healthyPlay : w)) g++;
          const sd = LINEUP_MODEL.weekRoleSd;
          drawLine(p.src, g, Math.exp(R.n() * sd - sd * sd / 2), R, buf, off);
        } else {
          const g = rosGamesFor(p.team) * p.avail;
          const sd = LINEUP_MODEL.rosPlayerSd;
          drawLine(p.src, g, Math.exp(R.n() * sd - sd * sd / 2), R, buf, off,
            { fg: R.n() * LINEUP_MODEL.rosPctSd.fg, ft: R.n() * LINEUP_MODEL.rosPctSd.ft });
        }
      }
    }
    return buf;
  };

  const managed = args.team ? [findTeam(league, args.team)] : (league.managedTeams || []).map(n => findTeam(league, n));
  if (managed.some(t => !t)) throw new Error(`Unknown team ${args.team}`);

  // Opponent draws are shared by every managed team's run (same seed stream)
  const oppSeason = new Map(), oppWeek = new Map(), carried = new Map();
  for (const name of teamNames) {
    const t = findTeam(league, name);
    const c = carriedOver(t);
    carried.set(name, c);
    const ros = simTeam(rosPlayers(t), 'ros', new Float64Array(sims * K));
    const wk = simTeam(c.lineup.filter(p => p.src), 'week', new Float64Array(sims * K));
    const b = baseT.get(name);
    const season = new Float64Array(sims * 8), week = new Float64Array(sims * 8);
    const tmp = new Float64Array(K);
    for (let s = 0; s < sims; s++) {
      for (let i = 0; i < K; i++) tmp[i] = b[i] + wk[s * K + i];
      week.set(catValues(tmp), s * 8);
      for (let i = 0; i < K; i++) tmp[i] += ros[s * K + i];
      season.set(catValues(tmp), s * 8);
    }
    oppSeason.set(name, season);
    oppWeek.set(name, week);
  }

  const md = [];
  const weekLabel = `${targetDays[0]} to ${targetDays[6]}`;
  md.push(`# Lineup optimizer — week of ${weekLabel}`, '');
  md.push(`Run ${today}. Standings base ${base.st.asOf} (+ games through stats ${cur.asOf}${restDays.length ? ` + expected ${restDays[0]}${restDays.length > 1 ? `–${restDays[restDays.length - 1]}` : ''} from locked lineups` : ''}); injuries ${league.injuriesAsOf || 'none'}; lineups ${league.lineupAsOf || 'none'}; ${sims} simulations.`, '');
  md.push('**Season-end Δ** is the change in expected roto points at the end of the season versus the carried-over lineup (this week\'s locked actives, filled to 9). One week is a small slice of the season, so these numbers are small. The ± is simulation noise only; differences under about 0.1 are within the model’s own error, so treat them as coin flips. **Week-end Δ** scores next Sunday\'s standings instead, which overreacts when teams are bunched in a category: use it to see which categories move, not for the size of the edge.', '');

  for (const team of managed) {
    const name = team.name;
    const c = carried.get(name);
    const pool = c.owned;
    const keepIdx = c.lineup.map(p => pool.indexOf(p));
    const others = teamNames.filter(n => n !== name);
    // This team's rest-of-season and every pool player's week draws
    const ros = simTeam(rosPlayers(team), 'ros', new Float64Array(sims * K));
    const wk = pool.map(p => (p.src ? simTeam([p], 'week', new Float64Array(sims * K)) : new Float64Array(sims * K)));
    const b = baseT.get(name);

    const k = Math.min(LINEUP_MODEL.starters, pool.length);
    const need = slotCoverage(pool);
    const legal = combinations(pool.length, k).filter(ix => slotCoverage(ix.map(i => pool[i])) === need);
    if (need < LINEUP_MODEL.slots.length) warn.push(`${name}: the roster can only fill ${need} of the PG/SG/SF/PF/C slots.`);

    // Evaluate a lineup over sims [0, n): per-sim season and week points, plus per-category means
    const tmp = new Float64Array(K);
    const evaluate = (ix, n) => {
      const season = new Float64Array(n), week = new Float64Array(n);
      const catS = new Float64Array(8), catW = new Float64Array(8);
      for (let s = 0; s < n; s++) {
        const off = s * K;
        for (let i = 0; i < K; i++) { let v = b[i]; for (const j of ix) v += wk[j][off + i]; tmp[i] = v; }
        const vw = catValues(tmp);
        for (let i = 0; i < K; i++) tmp[i] += ros[off + i];
        const vs = catValues(tmp);
        for (let ci = 0; ci < 8; ci++) {
          let ps = 1, pw = 1;
          for (const o of others) {
            const os = oppSeason.get(o)[s * 8 + ci], ow = oppWeek.get(o)[s * 8 + ci];
            ps += vs[ci] > os ? 1 : vs[ci] === os ? 0.5 : 0;
            pw += vw[ci] > ow ? 1 : vw[ci] === ow ? 0.5 : 0;
          }
          season[s] += ps; week[s] += pw; catS[ci] += ps; catW[ci] += pw;
        }
      }
      const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
      return { ix, season, week, mS: mean(season), mW: mean(week), catS: [...catS].map(x => x / n), catW: [...catW].map(x => x / n) };
    };

    // Pass 1: every legal lineup on a subset of sims; pass 2: the best ones (plus, for each
    // player, the best lineup with and without him) on all sims
    const n1 = Math.min(sims, 600);
    const first = legal.map(ix => evaluate(ix, n1)).sort((a, b) => b.mS - a.mS);
    const keyOf = ix => ix.join(',');
    const finalists = new Map();
    const addF = ix => finalists.set(keyOf(ix), ix);
    first.slice(0, 15).forEach(r => addF(r.ix));
    addF([...keepIdx].sort((x, y) => x - y));
    pool.forEach((_, j) => {
      const w = first.find(r => r.ix.includes(j)), wo = first.find(r => !r.ix.includes(j));
      if (w) addF(w.ix);
      if (wo) addF(wo.ix);
    });
    const results = [...finalists.values()].map(ix => evaluate(ix, sims)).sort((a, b) => b.mS - a.mS);
    const keep = results.find(r => keyOf(r.ix) === keyOf([...keepIdx].sort((x, y) => x - y)));
    const se = r => {
      let m = 0, q = 0;
      for (let s = 0; s < sims; s++) { const d = r.season[s] - keep.season[s]; m += d; q += d * d; }
      m /= sims;
      return Math.sqrt(Math.max(0, q / sims - m * m) / sims);
    };
    const sg = (v, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
    const names = ix => ix.map(i => pool[i].name);
    const bench = ix => pool.map((p, i) => i).filter(i => !ix.includes(i)).map(i => pool[i].name);
    const changes = ix => {
      const ins = ix.filter(i => !keep.ix.includes(i)).map(i => pool[i].name);
      const outs = keep.ix.filter(i => !ix.includes(i)).map(i => pool[i].name);
      return ins.length ? `start ${ins.join(', ')}; bench ${outs.join(', ')}` : '(same as carried over)';
    };
    const best = results[0];

    md.push(`## ${name}${team.name === league.myTeam ? ' (you)' : ' (Finn)'}`, '');
    md.push(`Expected season-end roto points: **${best.mS.toFixed(1)}** with the recommended lineup, ${keep.mS.toFixed(1)} carried over. ${legal.length} legal lineups checked.`, '');
    md.push(`**Recommended:** ${best === keep ? 'keep the carried-over lineup.' : changes(best.ix) + '.'} Not starting (bench or IL): ${bench(best.ix).join(', ') || 'nobody'}.`, '');
    md.push('| # | Not starting | Changes vs carried over | Season-end Δ (± se) | Week-end Δ |', '|---|---|---|---|---|');
    const shown = results.slice(0, 6);
    if (!shown.includes(keep)) shown.push(keep);
    for (const r of shown) {
      md.push(`| ${results.indexOf(r) + 1} | ${bench(r.ix).join(', ')} | ${r === keep ? '**carried over**' : changes(r.ix)} | ${sg(r.mS - keep.mS)} (± ${se(r).toFixed(2)}) | ${sg(r.mW - keep.mW, 1)} |`);
    }
    md.push('');
    if (best !== keep) {
      md.push('**By category, recommended vs carried over** (expected roto points):', '');
      md.push('| | ' + CATS.join(' | ') + ' |', '|---|' + CATS.map(() => '---').join('|') + '|');
      md.push('| Season-end | ' + CATS.map((_, i) => sg(best.catS[i] - keep.catS[i])).join(' | ') + ' |');
      md.push('| Week-end | ' + CATS.map((_, i) => sg(best.catW[i] - keep.catW[i], 1)).join(' | ') + ' |', '');
    }
    md.push('**Players** (value of starting = best lineup with him minus best without him, season-end points):', '');
    md.push('| Player | Pos | NBA | Games | Expected games | Injury | Recommended | Carried over | Value of starting |', '|---|---|---|---|---|---|---|---|---|');
    const rows = pool.map((p, j) => {
      const w = results.find(r => r.ix.includes(j)), wo = results.find(r => !r.ix.includes(j));
      const val = w && wo ? w.mS - wo.mS : null;
      return { p, j, val, w };
    }).sort((a, b) => (b.val ?? -9) - (a.val ?? -9));
    for (const { p, j, val, w } of rows) {
      const inj = p.status ? `${p.status}${p.ret && p.ret > today ? ` (back ~${p.ret})` : ''}` : '';
      md.push(`| ${p.name} | ${(p.pos || []).join('/')} | ${p.team || ''} | ${p.games} | ${p.expGames.toFixed(1)} | ${inj} | ${best.ix.includes(j) ? 'start' : 'bench'} | ${keep.ix.includes(j) ? 'start' : 'bench'} | ${val === null ? (w ? 'always (needed for a position)' : 'n/a') : sg(val)} |`);
    }
    md.push('');
    if (pool.some(p => !p.src)) md.push(`No projection or stats for ${pool.filter(p => !p.src).map(p => p.name).join(', ')}: counted as zero.`, '');
  }

  md.push('## Model', '');
  md.push(`Per-game rates blend players.js projections with season-to-date stats (season weight gp / (gp + ${+args.prior || LINEUP_MODEL.statsPrior}); \`--prior=\` changes it). Healthy players play a scheduled game with probability ${LINEUP_MODEL.healthyPlay}; P 0.9, Q 0.5, O/D 0 (0.7 from an ESPN return date). Weekly role factor sd ${LINEUP_MODEL.weekRoleSd}; rest-of-season player error sd ${LINEUP_MODEL.rosPlayerSd}, FG%/FT% sd ${LINEUP_MODEL.rosPctSd.fg}/${LINEUP_MODEL.rosPctSd.ft}. Opponents keep their current locked actives (filled to 9). Rest of season: each team's top 9 by projection × availability, over its NBA team's remaining games. Constants are in \`LINEUP_MODEL\` in \`season/lineup_optimizer.js\`.`, '');
  if (warn.length) md.push('## Notes', '', ...warn.map(w => `- ${w}`), '');

  const out = path.join(ROOT, 'reports', `${today}-lineup.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md.join('\n'));
  console.log(md.join('\n'));
  console.log(`\nSaved ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`lineup_optimizer: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { blendRates, slotCoverage, combinations, drawLine, catValues, rng, LINEUP_MODEL };
