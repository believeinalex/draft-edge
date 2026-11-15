const fs = require('fs');
const path = require('path');
const { normName, CATS } = require('../engine.js');
const { buildScorer } = require('./morning_report.js');

/**
 * Next-week lineup optimizer + full roto simulation for the whole league.
 *
 * Usage: node season/week_plan.js <projections.csv> [weekStartISO]   (default: next Monday)
 *
 * - Per-game projections come from the CSV (Hashtag-style "Blended Projections" sheet).
 * - Games = the NBA team's games Mon-Sun from season/schedule_cache.json.
 * - Injuries (season/injuries/latest): O / OFS / D = out all week; Q, P or healthy = full games.
 * - Yahoo slots: PG, SG, SF, PF, C, Util x4 (9 active). Rosters lock Monday for the week.
 * - Base = projected end-of-this-week standings (reports/<latest>.json "eow"), so the output is the
 *   cumulative roto standings after next week, plus next week's categories on their own.
 * - Every other team plays its best feasible nine (the inactive manager keeps the locked lineup).
 * - Monte Carlo (common random numbers across candidate lineups) scores every feasible nine by
 *   expected cumulative roto points.
 */

const ROOT = path.join(__dirname, '..');
const COUNT = ['tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const KEYS = ['fgm', 'fga', 'ftm', 'fta', ...COUNT];
const CV = { pts: 0.30, treb: 0.40, ast: 0.50, tpm: 0.65, stl: 0.75, blk: 0.85 };
const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C'];
const OUT = new Set(['O', 'OFS', 'D', 'INJ', 'SUSP']);
const ESPN = { WAS: 'WSH', PHO: 'PHX', UTA: 'UTAH' };
const INACTIVE_MANAGER = 'The New Day Co-op';
const N = +process.env.SIMS || 3000;

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const latest = dir => { const f = fs.readdirSync(dir).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().pop(); return path.join(dir, f); };

// ---- seeded RNG so reruns match
let seed = +process.env.SEED || 20261116;
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const randn = () => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());

function parseCSV(file) {
  const out = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const split = l => { const r = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { r.push(c.trim()); c = ''; } else c += ch; } r.push(c.trim()); return r; };
  const att = s => { const m = (s || '').match(/\(([\d.]+)\/([\d.]+)\)/); return m ? [+m[1], +m[2]] : [0, 0]; };
  for (const l of lines.slice(1)) {
    const c = split(l);
    const [fgm, fga] = att(c[6]), [ftm, fta] = att(c[7]);
    out.push({ name: c[0], team: c[3], pos: c[2].split(','), gp: +c[4], mpg: +c[5], fgm, fga, ftm, fta, tpm: +c[8], pts: +c[9], treb: +c[10], ast: +c[11], stl: +c[12], blk: +c[13], total: +c[14] });
  }
  return out;
}

function feasible(players) { // can these (<=9) players fill the Yahoo slots? returns slot per player or null
  const n = players.length;
  if (n > 9) return null;
  let best = null, bestCount = -1;
  const asg = new Array(n).fill(null), used = new Array(n).fill(false);
  const rec = (s, cnt) => {
    if (s === SLOTS.length) { if (cnt > bestCount) { bestCount = cnt; best = [...asg]; } return; }
    for (let i = 0; i < n; i++) {
      if (used[i] || !players[i].pos.includes(SLOTS[s])) continue;
      used[i] = true; asg[i] = SLOTS[s]; rec(s + 1, cnt + 1); used[i] = false; asg[i] = null;
    }
    rec(s + 1, cnt); // slot left to a Util / empty
  };
  rec(0, 0);
  if (n - bestCount > 4) return null; // more than 4 players would need Util
  return best.map(a => a || 'Util');
}

function subsets(arr, k, cb, start = 0, cur = []) {
  if (cur.length === k) return cb(cur);
  for (let i = start; i <= arr.length - (k - cur.length); i++) { cur.push(arr[i]); subsets(arr, k, cb, i + 1, cur); cur.pop(); }
}

async function main() {
  const csv = process.argv[2];
  if (!csv) throw new Error('usage: node season/week_plan.js <projections.csv> [weekStart]');
  const league = readJson(path.join(ROOT, 'season/league.json'));
  const proj = parseCSV(csv);
  const projBy = new Map(proj.map(p => [normName(p.name), p]));
  const injFile = readJson(latest(path.join(ROOT, 'season/injuries')));
  const inj = new Map(injFile.players.map(p => [normName(p.name), p]));
  const sched = readJson(path.join(ROOT, 'season/schedule_cache.json')).days;
  const rep = readJson(latest(path.join(ROOT, 'reports')).replace(/\/(\d{4}-\d{2}-\d{2})\.json$/, '/$1.json'));
  const score = buildScorer();

  // ---- week
  let start = process.argv[3];
  if (!start) { const d = new Date(league.asOf ? league.asOf.slice(0, 10) + 'T12:00:00Z' : Date.now()); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); start = d.toISOString().slice(0, 10); }
  const days = [...Array(7).keys()].map(i => new Date(new Date(start + 'T12:00:00Z').getTime() + i * 864e5).toISOString().slice(0, 10));
  const games = {};
  for (const d of days) for (const g of sched[d] || []) for (const t of g) games[t] = (games[t] || 0) + 1;
  const gamesFor = team => games[ESPN[team] || team] || 0;

  // ---- players
  const mkPlayer = (name, pos, owner) => {
    const k = normName(name), p = projBy.get(k);
    const i = inj.get(k);
    const status = i ? i.status : null;
    const o = { name, key: k, owner, pos: pos && pos.length ? pos : (p ? p.pos : []), status, note: i ? i.note : '', proj: p || null };
    if (!p) { o.g = 0; o.reason = 'no projection'; }
    else if (status && OUT.has(status)) { o.g = 0; o.reason = `${status} (${o.note})`; }
    else { o.g = gamesFor(p.team); o.team = p.team; if (!o.g) o.reason = 'no games'; }
    o.team = p ? p.team : null;
    o.z = p ? score(p) : -99;
    o.value = o.g * (p ? score(p) : 0);
    return o;
  };
  const rosters = new Map();
  const ownedKeys = new Set();
  for (const t of league.teams) {
    rosters.set(t.name, t.roster.map(r => { ownedKeys.add(normName(r.name)); return mkPlayer(r.name, r.pos, t.name); }));
  }
  const fas = proj.filter(p => !ownedKeys.has(normName(p.name))).map(p => mkPlayer(p.name, p.pos, null)).filter(p => p.g > 0);

  // ---- base totals (projected end of this week)
  const baseRaw = new Map(rep.teams.map(t => [t.name, t]));
  const names = league.teams.map(t => t.name);
  const base = names.map(n => {
    const b = baseRaw.get(n);
    const ros = rosters.get(n).filter(p => p.proj).sort((a, c) => c.z - a.z).slice(0, 9);
    const gp = b.gpNow + (b.gamesEow - b.gamesTonight || 0);
    const fga = ros.reduce((s, p) => s + p.proj.fga, 0) / ros.length * b.gpNow;
    const fta = ros.reduce((s, p) => s + p.proj.fta, 0) / ros.length * b.gpNow;
    return { name: n, fga, fta, fgm: b.eow.fgPct * fga, ftm: b.eow.ftPct * fta, ...Object.fromEntries(COUNT.map(c => [c, b.eow[c]])) };
  });

  // ---- simulated weekly lines per player (common random numbers)
  const simPlayer = p => {
    if (!p.g) return null;
    const arr = new Float32Array(N * 10);
    const r = p.proj;
    for (let s = 0; s < N; s++) {
      const talent = Math.max(0.5, 1 + 0.12 * randn());
      const sq = Math.sqrt(p.g), vol = Math.max(0.3, 1 + 0.30 / sq * randn());
      const fga = r.fga * p.g * talent * vol;
      const pf = r.fga ? r.fgm / r.fga : 0.45;
      arr[s * 10] = fga * Math.max(0, Math.min(1, pf * (1 + 0.03 * randn()) + Math.sqrt(Math.max(1e-6, pf * (1 - pf)) / Math.max(1, fga)) * randn()));
      arr[s * 10 + 1] = fga;
      const fta = r.fta * p.g * talent * vol;
      const pt = r.fta ? r.ftm / r.fta : 0.75;
      arr[s * 10 + 2] = fta * Math.max(0, Math.min(1, pt * (1 + 0.02 * randn()) + Math.sqrt(Math.max(1e-6, pt * (1 - pt)) / Math.max(1, fta)) * randn()));
      arr[s * 10 + 3] = fta;
      COUNT.forEach((c, j) => { arr[s * 10 + 4 + j] = Math.max(0, r[c] * p.g * talent * vol * (1 + CV[c] / sq * randn())); });
    }
    return arr;
  };
  for (const list of [...rosters.values(), fas]) for (const p of list) p.sim = simPlayer(p);

  const mine = league.managedTeams;
  // ---- lineups
  const detMean = lineup => { // expected weekly totals (no noise)
    const t = { fgm: 0, fga: 0, ftm: 0, fta: 0, ...Object.fromEntries(COUNT.map(c => [c, 0])) };
    for (const p of lineup) if (p.g) for (const k of KEYS) t[k] += p.proj[k] * p.g;
    return t;
  };
  const best9ByValue = pool => {
    const cand = pool.filter(p => p.g > 0);
    const k = Math.min(9, cand.length);
    let best = null, bv = -1e9;
    subsets(cand, k, sub => {
      if (!feasible(sub)) return;
      const v = sub.reduce((s, p) => s + p.value, 0);
      if (v > bv) { bv = v; best = [...sub]; }
    });
    return best || cand.slice(0, k);
  };
  const lineups = new Map();
  for (const t of league.teams) {
    const ros = rosters.get(t.name);
    lineups.set(t.name, best9ByValue(ros));
  }

  // Other managers replace players who are out with real free agents: every empty active slot
  // (and a locked-lineup slot held by an out player) is filled by the best free agent that fits.
  const taken = new Set();
  const fillWithFAs = (tn) => {
    let L = lineups.get(tn);
    while (L.length < 9) {
      let bestF = null, bv = -1e9;
      for (const f of fas) {
        if (taken.has(f.key) || !f.proj) continue;
        if (!feasible([...L, f])) continue;
        if (f.value > bv) { bv = f.value; bestF = f; }
      }
      if (!bestF) break;
      taken.add(bestF.key); L = [...L, bestF]; filled.push([tn, bestF.name]);
    }
    lineups.set(tn, L);
  };
  const filled = [];
  for (const t of league.teams) if (!mine.includes(t.name)) fillWithFAs(t.name);

  // ---- roto scoring over simulations
  const teamTotals = (name, lineup, s) => {
    const b = base[names.indexOf(name)];
    const w = { fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
    for (const p of lineup) { const a = p.sim; if (!a) continue; w.fgm += a[s * 10]; w.fga += a[s * 10 + 1]; w.ftm += a[s * 10 + 2]; w.fta += a[s * 10 + 3]; COUNT.forEach((c, j) => { w[c] += a[s * 10 + 4 + j]; }); }
    return { w, cum: [(b.fgm + w.fgm) / (b.fga + w.fga), (b.ftm + w.ftm) / (b.fta + w.fta), ...COUNT.map(c => b[c] + w[c])], wk: [w.fga ? w.fgm / w.fga : 0, w.fta ? w.ftm / w.fta : 0, ...COUNT.map(c => w[c])] };
  };
  const totalsFor = (lineupMap, which) => { // [sim][team] -> 8-vector
    const out = [];
    for (let s = 0; s < N; s++) out.push(names.map(n => teamTotals(n, lineupMap.get(n), s)[which]));
    return out;
  };
  const points = (vecs, i) => { // roto points for team i given all teams' vectors
    let tot = 0; const per = [];
    for (let c = 0; c < 8; c++) {
      let below = 0, tie = 0;
      for (let j = 0; j < vecs.length; j++) { if (j === i) continue; if (vecs[j][c] < vecs[i][c]) below++; else if (vecs[j][c] === vecs[i][c]) tie++; }
      const pts = below + 1 + tie / 2; per.push(pts); tot += pts;
    }
    return { tot, per };
  };
  const expectedPoints = (teamName, lineup, lineupMap) => {
    const i = names.indexOf(teamName);
    const tmp = new Map(lineupMap); tmp.set(teamName, lineup);
    // others' vectors cached per sim for speed
    let sum = 0;
    for (let s = 0; s < N; s++) {
      const vecs = names.map(n => (n === teamName ? teamTotals(n, lineup, s) : cacheOthers(n, s)).cum);
      sum += points(vecs, i).tot;
    }
    return sum / N;
  };
  const otherCache = new Map();
  const cacheOthers = (n, s) => { const key = n; let c = otherCache.get(key); if (!c) { c = new Array(N); const l = lineups.get(n); for (let i = 0; i < N; i++) c[i] = teamTotals(n, l, i); otherCache.set(key, c); } return c[s]; };

  // optimise my two teams (2 passes so they react to each other)
  const picks = {};
  for (let pass = 0; pass < 2; pass++) {
    for (const tn of mine) {
      otherCache.clear();
      const cand = rosters.get(tn).filter(p => p.g > 0);
      const k = Math.min(9, cand.length);
      let best = null, bv = -1, results = [];
      // precompute others once for this team
      const others = names.map(n => n === tn ? null : Array.from({ length: N }, (_, s) => teamTotals(n, lineups.get(n), s).cum));
      const i0 = names.indexOf(tn);
      const evalLineup = lineup => {
        let sum = 0;
        for (let s = 0; s < N; s++) {
          const vecs = names.map((n, j) => j === i0 ? teamTotals(tn, lineup, s).cum : others[j][s]);
          sum += points(vecs, i0).tot;
        }
        return sum / N;
      };
      subsets(cand, k, sub => {
        if (!feasible(sub)) return;
        const v = evalLineup(sub);
        results.push({ lineup: [...sub], v });
        if (v > bv) { bv = v; best = [...sub]; }
      });
      results.sort((a, b) => b.v - a.v);
      lineups.set(tn, best);
      picks[tn] = { results, evalLineup, others, i0, cand };
    }
  }

  // ---- final sims with final lineups
  otherCache.clear();
  const cum = totalsFor(lineups, 'cum'), wk = totalsFor(lineups, 'wk');
  const stat = names.map(() => ({ pts: 0, ranks: new Array(16).fill(0), wkPts: 0, cat: new Array(8).fill(0), wcat: new Array(8).fill(0), wRanks: new Array(16).fill(0) }));
  for (let s = 0; s < N; s++) {
    const pc = names.map((_, i) => points(cum[s], i));
    const pw = names.map((_, i) => points(wk[s], i));
    const order = pc.map((x, i) => [x.tot, i]).sort((a, b) => b[0] - a[0]);
    order.forEach(([, i], r) => { stat[i].ranks[r + 1]++; });
    const ow = pw.map((x, i) => [x.tot, i]).sort((a, b) => b[0] - a[0]);
    ow.forEach(([, i], r) => { stat[i].wRanks[r + 1]++; });
    names.forEach((_, i) => { stat[i].pts += pc[i].tot; stat[i].wkPts += pw[i].tot; pc[i].per.forEach((v, c) => { stat[i].cat[c] += v; }); pw[i].per.forEach((v, c) => { stat[i].wcat[c] += v; }); });
  }
  // baseline "points now" = base totals roto (before next week)
  const baseVecs = base.map(b => [b.fgm / b.fga, b.ftm / b.fta, ...COUNT.map(c => b[c])]);
  const basePts = names.map((_, i) => points(baseVecs, i));
  // deterministic expected week
  const det = names.map(n => detMean(lineups.get(n)));
  const detWk = det.map(t => [t.fgm / t.fga, t.ftm / t.fta, ...COUNT.map(c => t[c])]);
  const detCum = names.map((n, i) => { const b = base[i]; return [(b.fgm + det[i].fgm) / (b.fga + det[i].fga), (b.ftm + det[i].ftm) / (b.fta + det[i].fta), ...COUNT.map(c => b[c] + det[i][c])]; });
  const detWkPts = names.map((_, i) => points(detWk, i));
  const detCumPts = names.map((_, i) => points(detCum, i));

  // ---- free-agent scan for the managed teams (swap into best lineup)
  const faScan = {};
  const faN = fas.filter(f => !taken.has(f.key)).sort((a, b) => b.value - a.value).slice(0, 45);
  for (const tn of mine) {
    const { others, i0 } = picks[tn];
    const cur = lineups.get(tn);
    const evalL = lineup => { let sum = 0; for (let s = 0; s < N; s++) { const vecs = names.map((n, j) => j === i0 ? teamTotals(tn, lineup, s).cum : others[j][s]); sum += points(vecs, i0).tot; } return sum / N; };
    const baseV = evalL(cur);
    const rows = [];
    for (const f of faN) {
      let bestV = baseV, bestL = null, out = null;
      for (let drop = 0; drop < cur.length; drop++) {
        const l = [...cur.slice(0, drop), ...cur.slice(drop + 1), f];
        if (!feasible(l)) continue;
        const v = evalL(l);
        if (v > bestV) { bestV = v; bestL = l; out = cur[drop]; }
      }
      rows.push({ f, delta: bestV - baseV, replaces: out });
    }
    rows.sort((a, b) => b.delta - a.delta);
    faScan[tn] = { baseV, rows: rows.slice(0, 8) };
  }

  // ---- output
  const f1 = v => v.toFixed(1), f3 = v => v.toFixed(3).replace(/^0/, '');
  const catNames = ['FG%', 'FT%', '3PM', 'PTS', 'REB', 'AST', 'STL', 'BLK'];
  const mark = n => n === league.myTeam ? ' **(you)**' : mine.includes(n) ? ' **(Finn)**' : '';
  const md = [];
  md.push(`# Week plan: Mon ${days[0]} to Sun ${days[6]}`, '');
  md.push(`Projections: ${path.basename(csv)}. Injuries: Yahoo report ${injFile.asOf} (O/OFS/D out all week; Q or better = full games). Schedule: ESPN (cached). ${N.toLocaleString('en-US')} simulated weeks. Base = projected end-of-this-week standings from reports (before next week's games).`, '');
  const gl = Object.entries(games).sort((a, b) => b[1] - a[1]);
  md.push(`NBA games next week: ${gl.map(([t, g]) => `${t} ${g}`).join(', ')}.`, '');

  for (const tn of mine) {
    const L = lineups.get(tn);
    const asg = feasible(L);
    const ros = rosters.get(tn);
    md.push(`## ${tn}${mark(tn)}`, '');
    md.push('| Slot | Player | NBA | Games | Status | Week line (FG% FT% 3 PTS R A S B) |', '|---|---|---|---|---|---|');
    const order = ['PG', 'SG', 'SF', 'PF', 'C', 'Util'];
    const rows = L.map((p, i) => ({ p, s: asg[i] })).sort((a, b) => order.indexOf(a.s) - order.indexOf(b.s));
    for (const { p, s } of rows) md.push(`| ${s} | ${p.name} | ${p.team} | ${p.g} | ${p.status || '-'} | ${f3(p.proj.fgm / p.proj.fga)} ${f3(p.proj.ftm / p.proj.fta)} ${f1(p.proj.tpm * p.g)} ${f1(p.proj.pts * p.g)} ${f1(p.proj.treb * p.g)} ${f1(p.proj.ast * p.g)} ${f1(p.proj.stl * p.g)} ${f1(p.proj.blk * p.g)} |`);
    md.push('');
    const bench = ros.filter(p => !L.includes(p));
    md.push('**Bench / not playing:** ' + bench.map(p => `${p.name} (${p.reason || (p.g + ' g, ' + p.team)})`).join('; '), '');
    const { results } = picks[tn];
    md.push(`Top alternatives by expected roto points (cumulative, after the week):`, '');
    md.push('| Rank | Exp. pts | Change vs best | Who is out of the lineup (among healthy) |', '|---|---|---|---|');
    const healthy = rosters.get(tn).filter(p => p.g > 0);
    results.slice(0, 6).forEach((r, i) => md.push(`| ${i + 1} | ${r.v.toFixed(2)} | ${(r.v - results[0].v).toFixed(2)} | ${healthy.filter(p => !r.lineup.includes(p)).map(p => p.name).join(', ')} |`));
    md.push('');
  }

  md.push('## Full roto sim: standings after the week (cumulative)', '');
  md.push('Pts before = roto points from projected end-of-this-week totals. Exp = mean over simulations. Weekly column = the week judged on its own (15 = best weekly category).', '');
  md.push('| Rank | Team | Pts before | Exp. pts after | Δ | Avg rank (P10-P90) | P(top 5) | P(1st) | Week alone: exp. pts | ' + catNames.join(' | ') + ' (week rank pts) |', '|---|---|---|---|---|---|---|---|---|' + catNames.map(() => '---').join('|') + '|');
  const rows = names.map((n, i) => {
    const s = stat[i];
    const avgRank = s.ranks.reduce((a, c, r) => a + c * r, 0) / N;
    const cdf = r => { let a = 0; for (let k = 1; k <= r; k++) a += s.ranks[k]; return a / N; };
    const pc = q => { let a = 0; for (let k = 1; k <= 15; k++) { a += s.ranks[k] / N; if (a >= q) return k; } return 15; };
    return { n, i, pts: s.pts / N, avgRank, top5: cdf(5), first: cdf(1), p10: pc(0.1), p90: pc(0.9), wk: s.wkPts / N, wcat: s.wcat.map(v => v / N) };
  }).sort((a, b) => b.pts - a.pts);
  rows.forEach((r, k) => md.push(`| ${k + 1} | ${r.n}${mark(r.n)} | ${basePts[r.i].tot} | ${r.pts.toFixed(1)} | ${(r.pts - basePts[r.i].tot >= 0 ? '+' : '') + (r.pts - basePts[r.i].tot).toFixed(1)} | ${r.avgRank.toFixed(1)} (${r.p10}-${r.p90}) | ${Math.round(r.top5 * 100)}% | ${Math.round(r.first * 100)}% | ${r.wk.toFixed(1)} | ${r.wcat.map(f1).join(' | ')} |`));
  md.push('');

  md.push('## Cumulative category points for your two teams (before -> expected after)', '');
  md.push('| Team | ' + catNames.join(' | ') + ' |', '|---|' + catNames.map(() => '---').join('|') + '|');
  for (const tn of mine) { const i = names.indexOf(tn); md.push(`| ${tn} | ${catNames.map((_, c) => `${basePts[i].per[c]} -> ${(stat[i].cat[c] / N).toFixed(1)}`).join(' | ')} |`); }
  md.push('');

  md.push('## Projected week totals by team (expected, no noise)', '');
  md.push('| Team | Games | ' + catNames.join(' | ') + ' |', '|---|---|' + catNames.map(() => '---').join('|') + '|');
  names.map((n, i) => ({ n, i })).sort((a, b) => detWkPts[b.i].tot - detWkPts[a.i].tot).forEach(({ n, i }) => {
    const g = lineups.get(n).reduce((s, p) => s + p.g, 0);
    md.push(`| ${n}${mark(n)} | ${g} | ${f3(detWk[i][0])} (${detWkPts[i].per[0]}) | ${f3(detWk[i][1])} (${detWkPts[i].per[1]}) | ${COUNT.map((c, j) => `${Math.round(detWk[i][2 + j])} (${detWkPts[i].per[2 + j]})`).join(' | ')} |`);
  });
  md.push('', 'Numbers in brackets are the weekly roto points in that category (15 = best of 15).', '');

  md.push('## Free-agent adds that would improve the lineup', '');
  md.push('Expected roto points gained over the best current lineup if the player is added (and starts in place of the player named). An add made before Monday\'s lock counts for the week. Remember the drop: you must cut someone.', '');
  for (const tn of mine) {
    md.push(`**${tn}** (acquisitions left: ${league.teams.find(t => t.name === tn).acquisitionsLeft})`, '');
    const good = faScan[tn].rows.filter(r => r.delta > 0.05);
    if (!good.length) md.push('No free agent beats the current lineup by more than 0.05 expected points.', '');
    else { md.push('| Add | NBA | Games | Replaces in lineup | Δ exp. pts |', '|---|---|---|---|---|'); good.forEach(r => md.push(`| ${r.f.name} | ${r.f.team} | ${r.f.g} | ${r.replaces.name} | +${r.delta.toFixed(2)} |`)); md.push(''); }
  }

  const notes = [];
  for (const [tn, ros] of rosters) for (const p of ros) if (!p.proj) notes.push(`${p.name} (${tn}) has no projection in the sheet and counts as zero.`);
  md.push('## Notes', '', `- Other teams play their best feasible nine (value = games x per-game z); bench players are used before free agents.`, '- Other teams fill any empty active slot (players who are out) with the best free agent that fits: ' + (filled.map(x => x[1] + ' (' + x[0] + ')').join('; ') || 'none') + '.', '- Players out at the lock all week count zero. Q and P players count full games, as requested; they will sometimes miss games, so the rank bands are slightly optimistic.', '- Unrostered/unprojected: ' + (notes.join(' ') || 'none') + '', '');
  const outFile = path.join(ROOT, 'reports', `${start}-week-plan.md`);
  fs.writeFileSync(outFile, md.join('\n'));
  console.log(md.join('\n'));
  console.error('wrote', outFile);
}

main().catch(e => { console.error(e); process.exit(1); });
