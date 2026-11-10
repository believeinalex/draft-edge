const fs = require('fs');
const path = require('path');
const { normName } = require('../engine.js');
const { rotoPoints } = require('./build_season.js');

/**
 * Rest-of-season Monte Carlo: odds that each team finishes in the top third (top 5 of 15), top 3 and 1st.
 *
 * Each simulated season plays the remaining weeks (Monday to Sunday) one at a time, starting from the
 * latest category totals:
 * - Games per week come from ESPN's NBA schedule (cached in season/schedule_cache.json).
 * - Week 0 uses the locked lineup; later weeks use each manager's best nine among players who are
 *   healthy at the lock, ranked by games that week x per-game z-score.
 * - Per-game rates blend the preseason projection with this season's stats (the more games played,
 *   the more weight on this season). Each player also gets a persistent talent draw that is wider
 *   for players with few games.
 * - Injuries: current injuries use ESPN return dates; everyone else can get hurt in any week
 *   (frequency from his projected games played), lose the rest of that week, and miss a short
 *   (85%) or long (15%) stretch. Healthy players also sit about 3% of games.
 * - Weekly stat noise (shared volume swing plus per-stat noise) and shooting luck for FG% and FT%.
 * - Other managers' waiver moves: about 60% of each team's remaining acquisitions (of 18) are used at
 *   random weeks, each swapping the worst player for a random top free agent when that's an upgrade.
 *
 * It uses the same preseason projections the teams were drafted with, so managed teams that were built on
 * them look a little better than they should; treat it as an estimate. Run with
 * SEASON_SIM_N=0 to skip it in the morning report.
 */

const COUNT = ['tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const SK = ['fgm', 'fga', 'ftm', 'fta', ...COUNT];
const CV = { pts: 0.30, treb: 0.40, ast: 0.50, tpm: 0.65, stl: 0.75, blk: 0.85 };
const ABBR = { WSH: 'WAS', SA: 'SAS', NO: 'NOP', NY: 'NYK', GS: 'GSW', UTAH: 'UTA', PHX: 'PHO' };
const canon = t => ABBR[t] || t;
const CACHE_FILE = path.join(__dirname, 'schedule_cache.json');
const DAY = 864e5;
const isoPlus = (iso, d) => new Date(new Date(iso + 'T12:00:00Z').getTime() + d * DAY).toISOString().slice(0, 10);
const mondayOf = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };

/**
 * Unfinished NBA games from `startIso` for `days` days: {date: [[abbrA, abbrB], ...]}.
 * Falls back to season/schedule_cache.json if ESPN is unreachable; refreshes the cache on success.
 */
async function fetchSchedule(startIso, days = 160, cacheFile = CACHE_FILE) {
  const dates = Array.from({ length: days }, (_, i) => isoPlus(startIso, i));
  const one = async d => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${d.replace(/-/g, '')}`);
        if (!r.ok) throw new Error(r.status);
        return ((await r.json()).events || []).filter(e => !(e.status && e.status.type && e.status.type.state === 'post')).map(e => e.competitions[0].competitors.map(c => c.team.abbreviation));
      } catch (e) { if (a === 2) return null; }
    }
  };
  const out = {};
  let failed = 0;
  for (let i = 0; i < dates.length; i += 12) {
    const batch = dates.slice(i, i + 12);
    const res = await Promise.all(batch.map(one));
    batch.forEach((d, k) => { out[d] = res[k]; if (res[k] === null) failed++; });
  }
  if (failed > days * 0.1) {
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return { schedule: cached.days, source: `cache from ${cached.fetchedAt.slice(0, 10)} (ESPN schedule fetch failed)` };
    }
    throw new Error('Could not load the NBA schedule from ESPN and no cache exists');
  }
  for (const d of Object.keys(out)) if (out[d] === null) out[d] = [];
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), start: startIso, days: out }));
  return { schedule: out, source: 'ESPN' };
}

// Remaining acquisitions per team (the season limit minus adds so far), mapping old team names forward
function movesLeft(league, transactions, limit = 18) {
  const prev = new Map();
  for (const t of league.teams) { prev.set(t.name, t.name); for (const p of t.previousNames || []) prev.set(p, t.name); }
  const used = {};
  for (const t of transactions) if (t.type === 'add_drop') used[prev.get(t.team)] = (used[prev.get(t.team)] || 0) + (t.add || []).length;
  return Object.fromEntries(league.teams.map(t => [t.name, Math.max(0, limit - (used[t.name] || 0))]));
}

/**
 * @param {object} o
 * @param {{name:string, now:object, gpNow:number, roster:{name:string,nbaTeam:string}[], activeNames:Set<string>, movesLeft:number}[]} o.teams
 *   now = current category totals {fgPct, ftPct, tpm, pts, treb, ast, stl, blk}; activeNames = normalised names in this week's locked lineup
 * @param {object[]} o.players projections (players.js)
 * @param {object[]} o.stats season-to-date per-game stats (stats snapshot players)
 * @param {Function} o.score per-game z-score of a stat line
 * @param {Map<string,string>} o.injuries normalised name -> Yahoo status
 * @param {Map<string,string>} o.returns normalised name -> ESPN expected-return date
 * @param {Object<string,string[][]>} o.schedule date -> [[abbr, abbr], ...] unfinished games
 * @param {string} o.today ISO date
 * @param {number} [o.N] simulated seasons
 * @param {number} [o.noise] multiplier on talent uncertainty (1 = base)
 * @param {Function} [o.rng] uniform [0,1) generator
 */
function simulateSeason(o) {
  const { players: P, stats: S, score, injuries, returns, schedule, today, N = 4000, noise = 1 } = o;
  const rng = o.rng || Math.random;
  const randn = () => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
  const mon0 = mondayOf(today);
  const todayMs = new Date(today + 'T12:00:00Z').getTime();
  const lastDate = Object.keys(schedule).filter(d => schedule[d] && schedule[d].length).sort().pop();
  const W = lastDate ? Math.floor((new Date(lastDate + 'T12:00:00Z') - new Date(mon0 + 'T12:00:00Z')) / (7 * DAY)) + 1 : 1;
  const gw = {};
  for (const [d, evs] of Object.entries(schedule)) {
    if (!evs || d < today) continue;
    const wk = Math.floor((new Date(d + 'T12:00:00Z') - new Date(mon0 + 'T12:00:00Z')) / (7 * DAY));
    for (const ts of evs) for (const t of ts) { const c = canon(t); (gw[c] = gw[c] || new Array(W).fill(0))[wk]++; }
  }
  const games = (team, w) => (gw[team] || [])[w] || 0;

  const mk = (name, nbaTeam) => {
    const proj = P.find(p => normName(p.name) === normName(name)), act = S.find(p => normName(p.name) === normName(name));
    const gp = act ? act.gp : 0;
    if (!proj && (!act || gp < 3)) return null;
    const w = gp / (gp + 25);
    const rate = {};
    for (const k of SK) { const a = act && gp >= 1 ? act[k] : 0, pv = proj ? proj[k] : a; rate[k] = proj ? (w * a + (1 - w) * pv) : a; }
    const u = 1 - Math.min(0.95, (proj ? (proj.gp || 70) : 65) / 82);
    const q = Math.min(0.2, u / (3.2 * (1 - u)));
    const key = normName(name);
    return { name, key, team: canon((proj && proj.team) || nbaTeam || (act && act.nbaTeam)), rate, z: score(rate), q, sd: 0.22 * Math.sqrt(25 / (25 + gp)) + 0.04, status: injuries.get(key), ret: returns.get(key) };
  };
  const owned = new Set(o.teams.flatMap(t => t.roster.map(r => normName(r.name))));
  const pool = S.filter(p => !owned.has(normName(p.name)) && p.gp >= 5).sort((a, b) => a.rank - b.rank).slice(0, 30).map(p => mk(p.name, p.nbaTeam)).filter(Boolean);
  const teams = o.teams.map(t => {
    const roster = t.roster.map(r => mk(r.name, r.nbaTeam)).filter(Boolean);
    const top9 = [...roster].sort((a, b) => b.z - a.z).slice(0, 9);
    const nTop = Math.max(1, top9.length);
    return { ...t, roster, fga0: top9.reduce((s, p) => s + p.rate.fga, 0) / nTop * t.gpNow, fta0: top9.reduce((s, p) => s + p.rate.fta, 0) / nTop * t.gpNow };
  });

  const fresh = p0 => {
    const s = Math.max(0.5, 1 + p0.sd * noise * randn());
    const mult = {};
    for (const k of SK) mult[k] = s * (1 + 0.05 * randn());
    let injw = 0;
    const st = p0.status;
    if (st === 'O' || st === 'INJ' || st === 'SUSP') injw = p0.ret ? Math.max(0, (new Date(p0.ret + 'T12:00:00Z') - todayMs) / (7 * DAY)) : 1.5;
    else if (st === 'Q' || st === 'GTD' || st === 'DTD') injw = rng() < 0.5 ? 0.4 : 0;
    else if (st === 'P') injw = rng() < 0.1 ? 0.3 : 0;
    return { p: p0, mult, injw };
  };

  const simOnce = () => {
    const T = teams.map(t => {
      const mv = [];
      const k = Math.round(t.movesLeft * 0.6 * (0.5 + rng()));
      for (let i = 0; i < k; i++) mv.push(1 + Math.floor(rng() * Math.max(1, W - 1)));
      mv.sort((a, b) => a - b);
      return {
        t, roster: t.roster.map(fresh), mv,
        tot: { fgm: t.now.fgPct * t.fga0, fga: t.fga0, ftm: t.now.ftPct * t.fta0, fta: t.fta0, ...Object.fromEntries(COUNT.map(c => [c, t.now[c]])) }
      };
    });
    for (let w = 0; w < W; w++) {
      for (const X of T) {
        while (X.mv.length && X.mv[0] === w && pool.length) {
          X.mv.shift();
          let wi = 0, wz = 1e9;
          X.roster.forEach((r, i) => { if (r.p.z < wz) { wz = r.p.z; wi = i; } });
          const cand = pool[Math.floor(rng() * pool.length)];
          if (cand.z > wz && !X.roster.some(r => r.p.key === cand.key)) { X.roster[wi] = fresh(cand); X.roster[wi].injw = 0; }
        }
        const act = w === 0
          ? X.roster.filter(r => X.t.activeNames.has(r.p.key))
          : [...X.roster].filter(r => r.injw <= 0.35).sort((a, b) => games(b.p.team, w) * b.p.z - games(a.p.team, w) * a.p.z).slice(0, 9);
        const activeSet = new Set(act);
        for (const r of X.roster) {
          const g = games(r.p.team, w);
          let gp = g;
          if (r.injw > 0) { gp = Math.max(0, Math.ceil(g * (1 - Math.min(1, r.injw)))); r.injw = Math.max(0, r.injw - 1); }
          else if (rng() < r.p.q) {
            gp = Math.floor(rng() * (g + 1));
            const D = rng() < 0.85 ? 1 + (-Math.log(rng() || 1e-9)) : 4 + (-Math.log(rng() || 1e-9)) * 6;
            r.injw = Math.max(0, D - 1);
          }
          let played = 0;
          for (let i = 0; i < gp; i++) if (rng() > 0.03) played++;
          if (!activeSet.has(r) || played === 0) continue;
          const sq = Math.sqrt(played), m = Math.max(0.3, 1 + 0.30 / sq * randn());
          const rt = r.p.rate, mu = r.mult;
          const fga = rt.fga * mu.fga * played * m;
          const pf = rt.fga ? rt.fgm / rt.fga * (mu.fgm / mu.fga) : 0.45;
          X.tot.fgm += fga * Math.max(0, Math.min(1, pf + Math.sqrt(Math.max(1e-6, pf * (1 - pf)) / Math.max(1, fga)) * randn()));
          X.tot.fga += fga;
          const fta = rt.fta * mu.fta * played * m;
          const pt = rt.fta ? rt.ftm / rt.fta * (mu.ftm / mu.fta) : 0.75;
          X.tot.ftm += fta * Math.max(0, Math.min(1, pt + Math.sqrt(Math.max(1e-6, pt * (1 - pt)) / Math.max(1, fta)) * randn()));
          X.tot.fta += fta;
          for (const c of COUNT) X.tot[c] += Math.max(0, rt[c] * mu[c] * played * m * (1 + CV[c] / sq * randn()));
        }
      }
    }
    const out = T.map(X => ({ name: X.t.name, projTotals: { fgPct: X.tot.fgm / X.tot.fga, ftPct: X.tot.ftm / X.tot.fta, ...Object.fromEntries(COUNT.map(c => [c, X.tot[c]])) } }));
    rotoPoints(out, 'proj');
    return out;
  };

  const third = Math.ceil(teams.length / 3);
  const st = Object.fromEntries(teams.map(t => [t.name, { first: 0, top3: 0, third: 0, ranks: [], pts: 0 }]));
  for (let i = 0; i < N; i++) {
    for (const t of simOnce()) {
      const x = st[t.name];
      x.ranks.push(t.projRank); x.pts += t.projRoto.total;
      if (t.projRank === 1) x.first++;
      if (t.projRank <= 3) x.top3++;
      if (t.projRank <= third) x.third++;
    }
  }
  const pc = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  return {
    N, weeks: W, third,
    teams: teams.map(t => {
      const x = st[t.name];
      return { name: t.name, topThird: x.third / N, top3: x.top3 / N, first: x.first / N, avgRank: x.ranks.reduce((a, b) => a + b, 0) / N, p10: pc(x.ranks, 0.1), p90: pc(x.ranks, 0.9), avgPts: x.pts / N };
    }).sort((a, b) => b.topThird - a.topThird || a.avgRank - b.avgRank)
  };
}

const pct = v => `${Math.round(v * 100)}%`;
const sgnPts = d => (Math.abs(d) < 0.005 ? '0' : `${d > 0 ? '+' : ''}${Math.round(d * 100)}`);

// prev = the previous report's seasonOdds (optional), to show the change in top-third odds
function seasonOddsMarkdown(res, league, prev, source) {
  const tag = name => name === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(name) ? ' **(Finn)**' : '';
  const before = new Map(prev && prev.teams ? prev.teams.map(t => [t.name, t.topThird]) : []);
  const md = ['## Season odds (rest-of-season simulation)', ''];
  md.push(`${res.N.toLocaleString('en-US')} simulated seasons over ${res.weeks} weeks (schedule: ${source}) with weekly lineups, injuries, shooting luck and other managers' waiver moves. Top third = top ${res.third} of ${res.teams.length}. It uses the preseason projections the teams were drafted with, so managed teams run a little optimistic.`, '');
  md.push(`| Team | Top third | vs ${prev ? prev.asOf : 'last report'} | Top 3 | 1st | Avg finish (10-90%) |`, '|---|---|---|---|---|---|');
  for (const t of res.teams) {
    const delta = before.has(t.name) ? `${sgnPts(t.topThird - before.get(t.name))} pts` : '-';
    md.push(`| ${t.name}${tag(t.name)} | ${pct(t.topThird)} | ${delta} | ${pct(t.top3)} | ${pct(t.first)} | ${t.avgRank.toFixed(1)} (${t.p10}-${t.p90}) |`);
  }
  md.push('');
  return md;
}

module.exports = { fetchSchedule, movesLeft, simulateSeason, seasonOddsMarkdown, mondayOf, canon };
