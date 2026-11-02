const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { normName, CATS } = require('../engine.js');
const { rotoPoints } = require('./build_season.js');
const { buildScorer } = require('./morning_report.js');

/**
 * Monday email for the four-team "league inside the league" (the user's team, Finn's,
 * Vince's and fishy's). Writes reports/weekly/<monday>/ with PNG charts, email.html (an
 * email-safe preview that references the PNGs), poster.png (the whole email as one image,
 * for pasting into Gmail) and email.txt (subject + plain-text body).
 *
 * Inputs: season/league.json, season/standings, season/lineups (this week's pre-lock paste),
 * stats/snapshots (last week's daily box scores), season/schedule/2026-27.txt.
 * Optional reports/weekly/<monday>/intro.md: hand-written trash talk placed at the top.
 *
 * Usage: node season/weekly_email.js [--date YYYY-MM-DD]   (npm run weekly)
 * Needs Playwright + Chromium to render the PNGs (pre-installed in the cloud container).
 */

const ROOT = path.join(__dirname, '..');
// Who's in the group email. Colors are categorical slots 1-4 (validated palette), fixed per team.
const GROUP = [
  { team: 'Shut Up and Jam Gaiden', who: 'Alex', short: 'Jam Gaiden', color: '#2a78d6' },
  { team: 'Finn will turn Bert into bacon', who: 'Finn', short: 'Bert Bacon', color: '#eb6834' },
  { team: 'vincemvpcarter', who: 'Vince', short: 'vincemvpcarter', color: '#1baf7a' },
  { team: 'Fishy Achilles', who: 'fishy', short: 'Fishy Achilles', color: '#eda100' }
];
const CAT_LABEL = { fgPct: 'FG%', ftPct: 'FT%', tpm: '3PM', pts: 'PTS', treb: 'REB', ast: 'AST', stl: 'STL', blk: 'BLK' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const INACTIVE = new Set(['BN', 'IL', 'IL+', 'NA']);
const PLAY_WEIGHT = { O: 0, D: 0, INJ: 0, SUSP: 0, Q: 0.5, GTD: 0.5, DTD: 0.5, P: 0.9 };
const SLOTS = ['PG', 'SG', 'SF', 'PF', 'C', 'Util', 'Util', 'Util', 'Util'];

const C = { // chart chrome + ramps (light mode only: email clients don't do dark charts)
  surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7',
  other: '#d6d5ce', neutral: '#f0efec',
  blue: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  red: ['#fbdcdb', '#f5b1b0', '#ec7f7e', '#e34948', '#c13534', '#962524']
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"; // single quotes inside: it goes into style="" attributes

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = iso => addDays(iso, -((new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7));
const etToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const fmtDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const datedFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort() : [];
const fmtVal = (c, v) => c.endsWith('Pct') ? v.toFixed(3).replace(/^0/, '') : String(Math.round(v));
const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);

function loadSchedule() {
  const byDate = new Map();
  for (const line of fs.readFileSync(path.join(__dirname, 'schedule', '2026-27.txt'), 'utf8').split('\n')) {
    if (!/^\d{4}-/.test(line)) continue;
    const [d, ...games] = line.trim().split(/\s+/);
    byDate.set(d, new Set(games.flatMap(g => g.split('@'))));
  }
  return byDate;
}

// ---------- data ----------

function standingsHistory(league) {
  const dir = path.join(__dirname, 'standings');
  const canon = name => (league.teams.find(t => t.name === name || (t.previousNames || []).includes(name)) || { name }).name;
  return datedFiles(dir).map(f => {
    const st = readJson(path.join(dir, f));
    const teams = st.teams.map(t => ({ name: canon(t.team), gp: t.gp, realTotals: Object.fromEntries(CATS.map(c => [c, t[c]])) }));
    rotoPoints(teams, 'real');
    return { date: st.asOf, teams };
  });
}

// Box-score line per player per ET game date: snapshot D holds games through D-1
function dailyLines(dates) {
  const dir = path.join(ROOT, 'stats', 'snapshots');
  const snap = d => { const p = path.join(dir, d + '.json'); return fs.existsSync(p) ? readJson(p) : null; };
  const keys = ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
  const out = new Map(); // date -> Map(normName -> line)
  for (const d of dates) {
    const a = snap(d), b = snap(addDays(d, 1));
    if (!a || !b) continue;
    const before = new Map(a.players.map(p => [normName(p.name), p]));
    const lines = new Map();
    for (const p of b.players) {
      const q = before.get(normName(p.name));
      const games = p.gp - (q ? q.gp : 0);
      if (games <= 0) continue;
      const line = { games };
      for (const k of keys) line[k] = Math.max(0, Math.round(p[k] * p.gp - (q ? q[k] * q.gp : 0)));
      lines.set(normName(p.name), line);
    }
    out.set(d, lines);
  }
  return out;
}

function latestLineupBetween(from, to) {
  const dir = path.join(__dirname, 'lineups');
  const f = datedFiles(dir).filter(x => x.slice(0, 10) >= from && x.slice(0, 10) <= to).pop();
  return f ? readJson(path.join(dir, f)) : null;
}

// Best legal 9 (PG SG SF PF C + 4 Util) by value; small rosters so exhaustive search is fine
function bestLineup(players) {
  let best = { value: -1, pick: [] };
  const n = players.length;
  const canFill = chosen => {
    const fixed = SLOTS.slice(0, 5), used = new Set();
    const assign = i => {
      if (i === fixed.length) return true;
      for (const p of chosen) if (!used.has(p) && p.pos.includes(fixed[i])) { used.add(p); if (assign(i + 1)) return true; used.delete(p); }
      return false;
    };
    return assign(0);
  };
  const rec = (start, chosen, value) => {
    if (chosen.length === 9 || start === n) {
      if (value > best.value && (chosen.length === Math.min(9, n)) && canFill(chosen)) best = { value, pick: [...chosen] };
      return;
    }
    for (let i = start; i < n; i++) { chosen.push(players[i]); rec(i + 1, chosen, value + players[i].weekValue); chosen.pop(); }
  };
  rec(0, [], 0);
  return best;
}

function build(monday) {
  const league = readJson(path.join(__dirname, 'league.json'));
  const schedule = loadSchedule();
  const score = buildScorer();
  const projByName = new Map(PLAYERS.map(p => [normName(p.name), p]));
  const latest = readJson(path.join(ROOT, 'stats', 'latest.json'));
  const statByName = new Map(latest.players.map(p => [normName(p.name), p]));
  // Per-game value scale: shift z so the 180th-best projected player is worth 0, so any
  // rostered player's game is worth something and games played count.
  const pool = [...PLAYERS].sort((a, b) => a.rk - b.rk).slice(0, 180).map(score).sort((a, b) => b - a);
  const floor = pool[pool.length - 1];
  const projPerGame = name => { const p = projByName.get(normName(name)) || statByName.get(normName(name)); return p ? score(p) : floor; };

  const week = DAYS.map((_, i) => addDays(monday, i));
  const lastWeek = DAYS.map((_, i) => addDays(monday, i - 7));
  const teamGames = (nba, dates) => dates.map(d => (schedule.get(d) || new Set()).has(nba));

  // Standings: latest file on/before Monday, and last Monday's for the weekly change
  const history = standingsHistory(league).filter(h => h.date <= monday);
  const now = history[history.length - 1];
  const prev = [...history].reverse().find(h => h.date <= addDays(monday, -7)) || history[0];

  // This week's lineup (the Monday paste) and last week's (for the bench award)
  const lineupNow = latestLineupBetween(monday, addDays(monday, 6));
  const lineupPrev = latestLineupBetween(lastWeek[0], lastWeek[6]);
  const lineupFor = (snap, team) => snap && snap.teams.find(b => b.team === team.team ||
    ((league.teams.find(t => t.name === team.team) || {}).previousNames || []).includes(b.team));

  const lines = dailyLines(lastWeek);
  const warnings = [];
  if (!lineupNow) warnings.push(`No lineup paste for the week of ${monday}: games-this-week uses current rosters with no bench info. Paste Yahoo's League > Rosters page first.`);
  if (now.date < monday) warnings.push(`Latest Yahoo standings are from ${now.date}; share Monday's standings for an exact table.`);
  const missingDays = lastWeek.filter(d => !lines.has(d));
  if (missingDays.length) warnings.push(`No stats snapshot pair for ${missingDays.join(', ')}; those days are blank in the hot/cold chart.`);

  const teams = GROUP.map(g => {
    const lt = league.teams.find(t => t.name === g.team);
    if (!lt) throw new Error(`Team not found in league.json: ${g.team}`);
    const st = now.teams.find(t => t.name === g.team), st0 = prev.teams.find(t => t.name === g.team);

    // Category gaps vs. the next team up (to gain a point) and down (at risk)
    const cats = CATS.map(c => {
      const mine = st.realTotals[c];
      const others = now.teams.filter(t => t.name !== g.team).map(t => t.realTotals[c]);
      const above = others.filter(v => v > mine).sort((a, b) => a - b)[0];
      const below = others.filter(v => v < mine).sort((a, b) => b - a)[0];
      return { c, pts: st.realRoto[c], prevPts: st0 ? st0.realRoto[c] : null, value: mine,
        up: above === undefined ? null : above - mine, down: below === undefined ? null : mine - below };
    });

    // This week: lineup players, games, projected value
    const block = lineupFor(lineupNow, g);
    const roster = (block ? block.players : lt.roster.map(r => ({ slot: 'BN', name: r.name, nbaTeam: r.nbaTeam, pos: r.pos, status: r.injury && r.injury.status }))).map(p => {
      const games = teamGames(p.nbaTeam, week);
      const w = PLAY_WEIGHT[p.status] ?? 1;
      const nGames = games.filter(Boolean).length;
      return { ...p, games, nGames, weight: w, weekValue: (projPerGame(p.name) - floor) * nGames * w };
    });
    const starters = roster.filter(p => !INACTIVE.has(p.slot));
    const eligible = roster.filter(p => p.slot !== 'IL' && p.slot !== 'IL+' && p.slot !== 'NA' || p.weight > 0);
    const best = bestLineup(eligible.filter(p => p.weight > 0));
    const curValue = starters.reduce((s, p) => s + p.weekValue, 0);
    const bestSet = new Set(best.pick.map(p => p.name));
    const startSet = new Set(starters.map(p => p.name));
    const benchIns = best.pick.filter(p => !startSet.has(p.name)).sort((a, b) => b.weekValue - a.weekValue);
    const sitOuts = starters.filter(p => !bestSet.has(p.name)).sort((a, b) => a.weekValue - b.weekValue);
    const perDay = week.map((_, i) => ({
      start: starters.filter(p => p.games[i] && p.weight > 0).length,
      bench: roster.filter(p => INACTIVE.has(p.slot) && p.games[i] && p.weight > 0).length
    }));

    // Last week: per player per day (game z minus projected per-game z)
    const blockPrev = lineupFor(lineupPrev, g);
    const benchPrev = new Set(blockPrev ? blockPrev.players.filter(p => INACTIVE.has(p.slot)).map(p => normName(p.name)) : []);
    const hot = lt.roster.map(r => {
      const k = normName(r.name), proj = projPerGame(r.name);
      const sched = teamGames(r.nbaTeam, lastWeek);
      const cells = lastWeek.map((d, i) => {
        const day = lines.get(d);
        const l = day && day.get(k);
        if (l) { const per = { ...l }; for (const x of Object.keys(per)) if (x !== 'games') per[x] /= l.games; return { delta: (score(per) - proj) * l.games, line: l }; }
        return sched[i] && day ? { dnp: true } : null;
      });
      const played = cells.filter(x => x && x.line);
      const total = played.reduce((s, x) => s + x.delta, 0);
      const benched = benchPrev.has(k) ? played.reduce((s, x) => s + score(x.line) - floor * x.line.games, 0) : 0;
      return { name: r.name, cells, total, games: played.length, benchedValue: benched, benchedGames: benchPrev.has(k) ? played.length : 0 };
    }).sort((a, b) => b.total - a.total);

    return { ...g, st, st0, cats, roster, starters, perDay, best, curValue, benchIns, sitOuts, hot,
      startGames: perDay.reduce((s, d) => s + d.start, 0), benchGames: perDay.reduce((s, d) => s + d.bench, 0) };
  });

  return { league, monday, week, lastWeek, now, prev, history, teams, warnings };
}

// ---------- charts (SVG strings) ----------

const svgWrap = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><rect width="${w}" height="${h}" fill="${C.surface}"/>${body}</svg>`;
const text = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 12}" fill="${o.fill || C.ink2}" text-anchor="${o.anchor || 'start'}" font-weight="${o.weight || 400}"${o.baseline ? ` dominant-baseline="${o.baseline}"` : ''}>${esc(s)}</text>`;
const inkOn = hex => { const n = parseInt(hex.slice(1), 16); const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.6 ? C.ink : '#ffffff'; };

function chartRotoRace(d) {
  const W = 600, H = 360, L = 34, R = 128, T = 16, B = 30;
  const hist = d.history;
  const n = hist[0].teams.length;
  const t0 = Date.parse(hist[0].date), t1 = Date.parse(hist[hist.length - 1].date);
  const x = iso => L + (W - L - R) * ((Date.parse(iso) - t0) / Math.max(1, t1 - t0));
  const y = r => T + (H - T - B) * ((r - 1) / (n - 1));
  let s = '';
  for (let r = 1; r <= n; r++) s += `<line x1="${L}" x2="${W - R}" y1="${y(r)}" y2="${y(r)}" stroke="${C.grid}" stroke-width="1"/>` + ([1, 5, 10, 15].includes(r) ? text(L - 8, y(r) + 4, r, { anchor: 'end', size: 11, fill: C.muted }) : '');
  for (const h of hist) s += text(x(h.date), H - 10, fmtDate(h.date), { anchor: 'middle', size: 11, fill: C.muted });
  const path = name => hist.map(h => { const t = h.teams.find(q => q.name === name); return t ? [x(h.date), y(t.realRank)] : null; }).filter(Boolean);
  const groupNames = new Set(d.teams.map(t => t.team));
  for (const t of hist[hist.length - 1].teams.filter(t => !groupNames.has(t.name))) {
    s += `<polyline points="${path(t.name).map(p => p.join(',')).join(' ')}" fill="none" stroke="${C.other}" stroke-width="1.5" stroke-linejoin="round"/>`;
  }
  // Direct labels at the right edge; nudge apart so they never collide
  const ends = d.teams.map(t => ({ t, p: path(t.team) })).map(o => ({ ...o, ly: o.p[o.p.length - 1][1] })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < ends.length; i++) if (ends[i].ly - ends[i - 1].ly < 15) ends[i].ly = ends[i - 1].ly + 15;
  for (const { t, p, ly } of ends) {
    s += `<polyline points="${p.map(q => q.join(',')).join(' ')}" fill="none" stroke="${t.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const q of p) s += `<circle cx="${q[0]}" cy="${q[1]}" r="4" fill="${t.color}" stroke="${C.surface}" stroke-width="2"/>`;
    const last = p[p.length - 1];
    s += text(last[0] + 10, ly + 4, `${t.st.realRank}. ${t.who}`, { size: 12, fill: C.ink, weight: 600 });
  }
  s += text(4, 10, 'Rank', { size: 10, fill: C.muted });
  return svgWrap(W, H, s);
}

function chartCategories(d) {
  const W = 600, L = 92, T = 30, cw = (W - L - 8) / CATS.length, ch = 50, H = T + ch * d.teams.length + 8;
  const fill = pts => C.blue[Math.min(6, Math.floor((pts - 1) / 15 * 7))];
  let s = '';
  CATS.forEach((c, j) => { s += text(L + cw * j + cw / 2, T - 10, CAT_LABEL[c], { anchor: 'middle', size: 11, fill: C.ink2, weight: 600 }); });
  d.teams.forEach((t, i) => {
    const y0 = T + ch * i;
    s += `<rect x="4" y="${y0 + 14}" width="10" height="10" rx="2" fill="${t.color}"/>` + text(20, y0 + 23, t.who, { size: 13, fill: C.ink, weight: 600 });
    s += text(20, y0 + 39, `${t.st.realRoto.total} pts`, { size: 11, fill: C.muted });
    t.cats.forEach((k, j) => {
      const x0 = L + cw * j, f = fill(k.pts), ink = inkOn(f);
      s += `<rect x="${x0 + 1}" y="${y0 + 1}" width="${cw - 2}" height="${ch - 2}" rx="4" fill="${f}"/>`;
      s += text(x0 + cw / 2, y0 + 22, Number.isInteger(k.pts) ? k.pts : k.pts.toFixed(1), { anchor: 'middle', size: 15, fill: ink, weight: 700 });
      const sub = k.up === null ? 'top' : `+${fmtVal(k.c, k.up)} ↑`;
      s += text(x0 + cw / 2, y0 + 39, sub, { anchor: 'middle', size: 10, fill: ink });
    });
  });
  return svgWrap(W, H, s);
}

function chartGames(d) {
  const W = 600, L = 92, T = 30, cols = 9, cw = (W - L - 8) / cols, ch = 44, H = T + ch * d.teams.length + 8;
  const fill = v => v === 0 ? C.neutral : C.blue[Math.min(6, Math.max(0, Math.round(v / 9 * 6)))];
  let s = '';
  [...DAYS, 'Starts', 'Bench'].forEach((lab, j) => { s += text(L + cw * j + cw / 2, T - 10, lab, { anchor: 'middle', size: 11, fill: j < 7 ? C.ink2 : C.ink, weight: 600 }); });
  d.teams.forEach((t, i) => {
    const y0 = T + ch * i;
    s += `<rect x="4" y="${y0 + 16}" width="10" height="10" rx="2" fill="${t.color}"/>` + text(20, y0 + 25, t.who, { size: 13, fill: C.ink, weight: 600 });
    t.perDay.forEach((p, j) => {
      const x0 = L + cw * j, f = fill(p.start);
      s += `<rect x="${x0 + 1}" y="${y0 + 1}" width="${cw - 2}" height="${ch - 2}" rx="4" fill="${f}"/>`;
      s += text(x0 + cw / 2, y0 + 22, p.start, { anchor: 'middle', size: 14, fill: inkOn(f), weight: 700 });
      if (p.bench) s += text(x0 + cw / 2, y0 + 36, `+${p.bench} BN`, { anchor: 'middle', size: 9, fill: inkOn(f) });
    });
    s += text(L + cw * 7 + cw / 2, y0 + 27, t.startGames, { anchor: 'middle', size: 16, fill: C.ink, weight: 700 });
    s += text(L + cw * 8 + cw / 2, y0 + 27, t.benchGames, { anchor: 'middle', size: 16, fill: t.benchGames ? '#c13534' : C.muted, weight: 700 });
  });
  return svgWrap(W, H, s);
}

function chartHotCold(d) {
  const W = 600, colW = 296, nameW = 112, cw = 21, rh = 17, T = 44;
  const maxRows = Math.max(...d.teams.map(t => t.hot.length));
  const panelH = 28 + rh * maxRows + 8, H = T + panelH * 2 + 6;
  const fill = v => {
    const a = Math.abs(v), step = a < 2 ? -1 : Math.min(5, Math.floor((a - 2) / 3));
    return step < 0 ? C.neutral : (v > 0 ? C.red : C.blue)[step];
  };
  let s = '';
  // legend: diverging scale, labelled ends (hot = above projection)
  const lx = 150, steps = [-14, -9, -5, 0, 5, 9, 14];
  s += text(lx - 8, 16, 'Below projection', { anchor: 'end', size: 11, fill: C.ink2 });
  steps.forEach((v, i) => { s += `<rect x="${lx + i * 22}" y="6" width="20" height="13" rx="3" fill="${fill(v)}"/>`; });
  s += text(lx + steps.length * 22 + 6, 16, 'Above projection', { size: 11, fill: C.ink2 });
  s += `<rect x="${lx + 260}" y="6" width="20" height="13" rx="3" fill="none" stroke="${C.axis}" stroke-dasharray="2 2"/>` + text(lx + 286, 16, 'DNP', { size: 11, fill: C.ink2 });
  s += text(4, 34, 'Each cell = one game, value vs. that player\'s projected game (8-cat z). Blank = no game.', { size: 10, fill: C.muted });
  d.teams.forEach((t, k) => {
    const x0 = (k % 2) * (colW + 8), y0 = T + Math.floor(k / 2) * panelH;
    s += `<rect x="${x0}" y="${y0 + 3}" width="10" height="10" rx="2" fill="${t.color}"/>` + text(x0 + 15, y0 + 12, t.who, { size: 12, fill: C.ink, weight: 700 });
    DAYS.forEach((dd, j) => { s += text(x0 + nameW + j * cw + cw / 2, y0 + 24, dd[0], { anchor: 'middle', size: 9, fill: C.muted }); });
    s += text(x0 + nameW + 7 * cw + 30, y0 + 24, 'Week', { anchor: 'end', size: 9, fill: C.muted });
    t.hot.forEach((p, r) => {
      const y = y0 + 28 + r * rh;
      const nm = p.name.length > 17 ? p.name.replace(/^(\S)\S*\s/, '$1. ') : p.name;
      s += text(x0, y + 12, nm.length > 18 ? nm.slice(0, 17) + '…' : nm, { size: 11, fill: C.ink2 });
      p.cells.forEach((cell, j) => {
        const cx = x0 + nameW + j * cw;
        if (cell && cell.line) s += `<rect x="${cx + 1}" y="${y + 1}" width="${cw - 2}" height="${rh - 2}" rx="3" fill="${fill(cell.delta)}"/>`;
        else if (cell && cell.dnp) s += `<rect x="${cx + 1.5}" y="${y + 1.5}" width="${cw - 3}" height="${rh - 3}" rx="3" fill="none" stroke="${C.axis}" stroke-dasharray="2 2"/>`;
      });
      s += text(x0 + nameW + 7 * cw + 30, y + 12, p.games ? signed(p.total) : '—', { anchor: 'end', size: 11, fill: C.ink, weight: 600 });
    });
  });
  return svgWrap(W, H, s);
}

// ---------- copy ----------

function awards(d) {
  const all = d.teams.flatMap(t => t.hot.filter(p => p.games).map(p => ({ ...p, t })));
  const hot = [...all].sort((a, b) => b.total - a.total)[0];
  const cold = [...all].sort((a, b) => a.total - b.total)[0];
  const bench = d.teams.map(t => ({ t, games: t.hot.reduce((s, p) => s + p.benchedGames, 0), top: [...t.hot].sort((a, b) => b.benchedValue - a.benchedValue)[0] }))
    .sort((a, b) => b.games - a.games)[0];
  const moves = d.teams.map(t => ({ t, delta: t.st0 ? t.st0.realRank - t.st.realRank : 0, pts: t.st0 ? t.st.realRoto.total - t.st0.realRoto.total : 0 }));
  const climber = [...moves].sort((a, b) => b.delta - a.delta || b.pts - a.pts)[0];
  const faller = [...moves].sort((a, b) => a.delta - b.delta || a.pts - b.pts)[0];
  const sched = [...d.teams].sort((a, b) => b.startGames - a.startGames);
  const leak = d.teams.map(t => ({ t, lost: t.best.value - t.curValue })).sort((a, b) => b.lost - a.lost)[0];
  return { hot, cold, bench, climber, faller, schedBest: sched[0], schedWorst: sched[sched.length - 1], leak, moves };
}

function trashTalk(d, a) {
  const out = [];
  const ord = [...d.teams].sort((x, y) => x.st.realRank - y.st.realRank);
  const top = ord[0], bot = ord[ord.length - 1];
  out.push(`${top.who} runs the group chat at #${top.st.realRank} overall. ${bot.who} is #${bot.st.realRank} and is currently paying for everyone's lunch.`);
  if (a.climber.delta > 0) out.push(`${a.climber.t.who} climbed ${a.climber.delta} spot${a.climber.delta > 1 ? 's' : ''} this week. Suspicious. We're checking for performance-enhancing waiver pickups.`);
  if (a.faller.delta < 0) out.push(`${a.faller.t.who} slid ${-a.faller.delta} spot${a.faller.delta < -1 ? 's' : ''}. Thoughts and prayers.`);
  if (a.hot) out.push(`Player of the week: ${a.hot.name} (${a.hot.t.who}), ${signed(a.hot.total)} above projection. Enjoy it, it won't last.`);
  if (a.cold && a.cold.total < 0) out.push(`Ice cube award: ${a.cold.name} (${a.cold.t.who}) at ${signed(a.cold.total)} vs. projection. Someone check if he's still in the league.`);
  if (a.bench.games > 0) out.push(`Bench warmer trophy: ${a.bench.t.who} had ${a.bench.games} game${a.bench.games > 1 ? 's' : ''} played on the bench last week${a.bench.top && a.bench.top.benchedGames ? `, led by ${a.bench.top.name}` : ''}.`);
  out.push(`Schedule luck this week: ${a.schedBest.who} gets ${a.schedBest.startGames} starter games, ${a.schedWorst.who} gets ${a.schedWorst.startGames}. Life isn't fair, and neither is the NBA calendar.`);
  for (const t of d.teams) {
    const last = t.cats.filter(k => k.pts <= 2).map(k => CAT_LABEL[k.c]);
    const first = t.cats.filter(k => k.pts >= 14).map(k => CAT_LABEL[k.c]);
    if (last.length) out.push(`${t.who} is bottom-2 in ${last.join(' and ')}${first.length ? ` but top-2 in ${first.join(' and ')}. Specialist or punting? You decide.` : '. Bold strategy.'}`);
  }
  return out;
}

function lineupAdvice(t) {
  const lost = t.best.value - t.curValue;
  if (lost < 0.5 || !t.benchIns.length) return `${t.who}: lineup looks right for this week's schedule.`;
  const swaps = t.benchIns.map((p, i) => `start ${p.name} (${p.nGames}g) over ${t.sitOuts[i] ? `${t.sitOuts[i].name} (${t.sitOuts[i].nGames}g${t.sitOuts[i].status ? ', ' + t.sitOuts[i].status : ''})` : '?'}`);
  return `${t.who}: ${swaps.join('; ')}.`;
}

// ---------- email ----------

function emailHtml(d, a, talk, intro, imgs) {
  const row = (cells, head) => `<tr>${cells.map((c, i) => `<${head ? 'th' : 'td'} style="padding:6px 8px;border-bottom:1px solid ${C.grid};text-align:${i === 0 ? 'left' : 'right'};font-size:13px;${head ? `color:${C.muted};font-weight:600;` : `color:${C.ink};`}">${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
  const ord = [...d.teams].sort((x, y) => x.st.realRank - y.st.realRank);
  const table = `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-family:${FONT}">` +
    row(['Team', 'Overall', 'Roto pts', 'Week Δ', 'Starter games'], true) +
    ord.map(t => { const m = a.moves.find(x => x.t === t); return row([
      `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${t.color};margin-right:6px"></span><b>${esc(t.who)}</b> <span style="color:${C.muted}">${esc(t.team)}</span>`,
      `#${t.st.realRank}`, t.st.realRoto.total, m.delta > 0 ? `▲ ${m.delta}` : m.delta < 0 ? `▼ ${-m.delta}` : '–', t.startGames]); }).join('') + '</table>';
  const h2 = s => `<h2 style="font-family:${FONT};font-size:17px;color:${C.ink};margin:28px 0 4px">${s}</h2>`;
  const p = s => `<p style="font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink2};margin:4px 0 10px">${s}</p>`;
  const img = (k, alt) => `<img src="${imgs[k]}" alt="${esc(alt)}" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0;margin:6px 0">`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monday Huddle ${d.monday}</title></head>
<body style="margin:0;padding:0;background:#f9f9f7"><div id="email" style="max-width:640px;margin:0 auto;padding:24px 20px;background:${C.surface}">
<div style="font-family:${FONT};font-size:12px;color:${C.muted};letter-spacing:.06em;text-transform:uppercase">LePrawn · Week of ${fmtDate(d.monday)}</div>
<h1 style="font-family:${FONT};font-size:26px;color:${C.ink};margin:4px 0 12px">The Monday Huddle</h1>
${intro ? intro.split(/\n\s*\n/).map(x => p(esc(x.trim()))).join('') : ''}
${talk.map(x => `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink};margin:0 0 6px">• ${esc(x)}</div>`).join('')}
${h2('The group table')}${p(`Yahoo standings through ${fmtDate(addDays(d.now.date, -1))}. Week Δ is the change in overall rank since ${fmtDate(d.prev.date)}.`)}${table}
${h2('The roto race')}${p('Overall rank in the 15-team league after each standings update. The four of us are in colour and the other 11 teams are grey.')}${img('race', 'Rank over time chart')}
${h2('Where the cheap points are')}${p('Roto points per category (15 = best). The small number is how much more you need to pass the next team up. Small gaps are where to aim this week.')}${img('cats', 'Category points heatmap')}
${h2('Games this week')}${p(`Starters with a game each day (Mon ${fmtDate(d.week[0])} – Sun ${fmtDate(d.week[6])}), not counting anyone listed Out. "BN" = bench players with a game who won't count. Lineups lock for the whole week, so set them now.`)}${img('games', 'Games this week grid')}
${p('<b>Lineup check</b> (best legal 9 by projected value × games, same math for everyone):')}
${d.teams.map(t => p('• ' + esc(lineupAdvice(t)))).join('')}
${h2('Last week, hot and cold')}${p(`${fmtDate(d.lastWeek[0])} – ${fmtDate(d.lastWeek[6])}. Red = beat his projection, blue = stunk.`)}${img('hot', 'Hot and cold strip chart')}
<p style="font-family:${FONT};font-size:11px;color:${C.muted};margin-top:28px">Generated by Draft Edge from Yahoo standings and lineups, Hashtag Basketball stats and the NBA schedule. Projections are draft-season estimates, so treat them as trash-talk grade.</p>
</div></body></html>`;
}

function emailText(d, a, talk, intro) {
  const ord = [...d.teams].sort((x, y) => x.st.realRank - y.st.realRank);
  return [`Subject: The Monday Huddle — week of ${fmtDate(d.monday)}`, '',
    ...(intro ? [intro.trim(), ''] : []),
    ...talk.map(x => '• ' + x), '',
    'THE GROUP TABLE',
    ...ord.map(t => { const m = a.moves.find(x => x.t === t); return `#${t.st.realRank}  ${t.who} (${t.team}) — ${t.st.realRoto.total} pts, ${m.delta > 0 ? '▲' + m.delta : m.delta < 0 ? '▼' + -m.delta : 'no change'}, ${t.startGames} starter games this week`; }), '',
    'LINEUP CHECK', ...d.teams.map(t => '• ' + lineupAdvice(t)), ''].join('\n');
}

async function render(outDir, charts, html) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 640, height: 800 } });
    for (const [name, svg] of Object.entries(charts)) {
      await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
      await page.locator('svg').screenshot({ path: path.join(outDir, `${name}.png`) });
    }
    await page.goto('file://' + path.join(outDir, 'email.html'));
    await page.locator('#email').screenshot({ path: path.join(outDir, 'poster.png') });
  } finally { await browser.close(); }
}

async function main() {
  const arg = process.argv.indexOf('--date');
  const monday = mondayOf(arg > -1 ? process.argv[arg + 1] : etToday());
  const d = build(monday);
  const a = awards(d);
  const outDir = path.join(ROOT, 'reports', 'weekly', monday);
  fs.mkdirSync(outDir, { recursive: true });
  const introPath = path.join(outDir, 'intro.md');
  const intro = fs.existsSync(introPath) ? fs.readFileSync(introPath, 'utf8') : '';
  const talk = trashTalk(d, a);
  const charts = { race: chartRotoRace(d), cats: chartCategories(d), games: chartGames(d), hot: chartHotCold(d) };
  const imgs = Object.fromEntries(Object.keys(charts).map(k => [k, `${k}.png`]));
  fs.writeFileSync(path.join(outDir, 'email.html'), emailHtml(d, a, talk, intro, imgs));
  fs.writeFileSync(path.join(outDir, 'email.txt'), emailText(d, a, talk, intro));
  await render(outDir, charts);
  for (const w of d.warnings) console.log('WARNING ' + w);
  console.log(fs.readFileSync(path.join(outDir, 'email.txt'), 'utf8'));
  console.log(`Wrote ${path.relative(ROOT, outDir)}/ (email.html, poster.png, ${Object.keys(charts).map(k => k + '.png').join(', ')})`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { build, bestLineup };
