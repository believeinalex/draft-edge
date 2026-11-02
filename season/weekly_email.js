const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { normName, CATS } = require('../engine.js');
const { rotoPoints } = require('./build_season.js');
const { buildScorer } = require('./morning_report.js');

/**
 * Monday email for the four-team "league inside the league" (the user's team, Finn's,
 * Vince's and fishy's). Writes reports/weekly/<monday>/: email.html (the email as rich HTML;
 * every chart is a colored table, so it pastes into Gmail as editable text), email.txt (subject +
 * plain text), data.json (every number behind it, for fact-checking) and preview.png.
 *
 * Inputs: season/league.json, season/standings, season/lineups (this week's pre-lock paste),
 * stats/snapshots (last week's daily box scores), season/schedule/2026-27.txt.
 * Optional reports/weekly/<monday>/intro.md: hand-written trash talk placed at the top.
 *
 * Usage: node season/weekly_email.js [--date YYYY-MM-DD]   (npm run weekly)
 * preview.png needs Playwright + Chromium (pre-installed in the cloud container); --no-preview skips it.
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

function lineupBetween(from, to, which = 'latest') {
  const dir = path.join(__dirname, 'lineups');
  const files = datedFiles(dir).filter(x => x.slice(0, 10) >= from && x.slice(0, 10) <= to);
  const f = which === 'first' ? files[0] : files.pop();
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
  const lineupNow = lineupBetween(monday, addDays(monday, 6));
  // Last week's stats counted for whoever had the player in the lineup locked that Monday (the
  // week's first paste); mid-week adds, drops and trades only take effect at the next lock.
  const lineupPrev = lineupBetween(lastWeek[0], lastWeek[6], 'first');
  const lineupFor = (snap, team) => snap && snap.teams.find(b => b.team === team.team ||
    ((league.teams.find(t => t.name === team.team) || {}).previousNames || []).includes(b.team));

  const lines = dailyLines(lastWeek);
  const warnings = [];
  if (!lineupPrev) warnings.push(`No lineup paste for the week of ${lastWeek[0]}: hot/cold uses current rosters, so mid-week moves are attributed to the wrong team.`);
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
    const prevPlayers = blockPrev ? blockPrev.players : lt.roster.map(r => ({ slot: 'Util', name: r.name, nbaTeam: r.nbaTeam }));
    const hot = prevPlayers.map(r => {
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
      return { name: r.name, bench: benchPrev.has(k), cells, total, games: played.length, benchedValue: benched, benchedGames: benchPrev.has(k) ? played.length : 0 };
    }).sort((a, b) => a.bench - b.bench || b.total - a.total);

    return { ...g, st, st0, cats, roster, starters, perDay, best, curValue, benchIns, sitOuts, hot,
      startGames: perDay.reduce((s, d) => s + d.start, 0), benchGames: perDay.reduce((s, d) => s + d.bench, 0) };
  });

  return { league, monday, week, lastWeek, now, prev, history, teams, warnings };
}

// ---------- charts (email-safe HTML tables: they paste into Gmail as editable rich text) ----------

const inkOn = hex => { const n = parseInt(hex.slice(1), 16); const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.6 ? C.ink : '#ffffff'; };
const TABLE = `cellpadding="0" cellspacing="2" border="0" style="border-collapse:separate;font-family:${FONT}"`;
// A filled cell: bgcolor attribute + inline background so the color survives paste and old clients
const cell = (fill, html, o = {}) => `<td align="center" bgcolor="${fill}" width="${o.w || ''}" style="background:${fill};color:${inkOn(fill)};text-align:center;padding:${o.pad || '6px 2px'};border-radius:4px;${o.w ? `width:${o.w}px;` : ''}font-size:${o.size || 14}px;line-height:1.2">${html}</td>`;
const plain = (html, o = {}) => `<td align="${o.align || 'left'}" style="padding:${o.pad || '4px 6px'};font-size:${o.size || 13}px;color:${o.color || C.ink2};text-align:${o.align || 'left'};${o.bold ? 'font-weight:700;' : ''}white-space:nowrap">${html}</td>`;
const chip = color => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:6px"></span>`;
const small = s => `<br><span style="font-size:10px">${s}</span>`;

function chartCategories(d) {
  const fill = pts => C.blue[Math.min(6, Math.floor((pts - 1) / 15 * 7))];
  let h = `<table ${TABLE} width="100%"><tr>${plain('')}${CATS.map(c => plain(CAT_LABEL[c], { align: 'center', size: 11, bold: true })).join('')}</tr>`;
  for (const t of d.teams) {
    h += `<tr>${plain(`${chip(t.color)}<b style="color:${C.ink}">${esc(t.who)}</b>${small(`<span style="color:${C.muted}">${t.st.realRoto.total} pts</span>`)}`)}`;
    h += t.cats.map(k => cell(fill(k.pts), `<b>${Number.isInteger(k.pts) ? k.pts : k.pts.toFixed(1)}</b>${small(k.up === null ? 'top' : `+${fmtVal(k.c, k.up)}`)}`, { w: 58 })).join('') + '</tr>';
  }
  return h + '</table>';
}

function chartGames(d) {
  const fill = v => v === 0 ? C.neutral : C.blue[Math.min(6, Math.max(0, Math.round(v / 9 * 6)))];
  let h = `<table ${TABLE} width="100%"><tr>${plain('')}${DAYS.map(x => plain(x, { align: 'center', size: 11, bold: true })).join('')}${plain('Starts', { align: 'center', size: 11, bold: true, color: C.ink })}${plain('Bench', { align: 'center', size: 11, bold: true, color: C.ink })}</tr>`;
  for (const t of d.teams) {
    h += `<tr>${plain(`${chip(t.color)}<b style="color:${C.ink}">${esc(t.who)}</b>`)}`;
    h += t.perDay.map(p => cell(fill(p.start), `<b>${p.start}</b>${small(p.bench ? `+${p.bench} BN` : '&nbsp;')}`, { w: 46 })).join('');
    h += plain(`<b style="font-size:16px;color:${C.ink}">${t.startGames}</b>`, { align: 'center' });
    h += plain(`<b style="font-size:16px;color:${t.benchGames ? '#c13534' : C.muted}">${t.benchGames}</b>`, { align: 'center' }) + '</tr>';
  }
  return h + '</table>';
}

const hotFill = v => {
  const a = Math.abs(v), step = a < 2 ? -1 : Math.min(5, Math.floor((a - 2) / 3));
  return step < 0 ? C.neutral : (v > 0 ? C.red : C.blue)[step];
};
const shortName = n => n.length > 17 ? n.replace(/^(\S)\S*\s/, '$1. ') : n;

function chartHotCold(d) {
  const sw = v => `<td bgcolor="${hotFill(v)}" style="background:${hotFill(v)};width:16px;height:12px;border-radius:3px;font-size:1px">&nbsp;</td>`;
  const legend = `<table cellpadding="0" cellspacing="2" border="0" style="font-family:${FONT};margin:4px 0 8px"><tr>${plain('Below projection', { size: 11 })}${[-14, -9, -5, 0, 5, 9, 14].map(sw).join('')}${plain('Above projection', { size: 11 })}${plain('&middot; = didn\'t play', { size: 11 })}</tr></table>`;
  const panel = t => {
    let h = `<table cellpadding="0" cellspacing="1" border="0" style="font-family:${FONT}"><tr><td colspan="9" style="padding:2px 0 4px;font-size:13px;color:${C.ink};font-weight:700">${chip(t.color)}${esc(t.who)}</td></tr>`;
    h += `<tr>${plain('', { pad: '0' })}${DAYS.map(x => plain(x[0], { align: 'center', size: 9, color: C.muted, pad: '0' })).join('')}${plain('Week', { align: 'right', size: 9, color: C.muted, pad: '0 0 0 4px' })}</tr>`;
    for (const p of t.hot) {
      h += `<tr>${plain(esc(shortName(p.name)) + (p.bench ? ` <span style="font-size:9px;color:${C.muted}">BN</span>` : ''), { size: 11, pad: '1px 4px 1px 0' })}`;
      h += p.cells.map(c => c && c.line ? `<td bgcolor="${hotFill(c.delta)}" style="background:${hotFill(c.delta)};width:18px;border-radius:3px;font-size:9px">&nbsp;</td>`
        : `<td style="width:18px;text-align:center;font-size:12px;color:${C.muted}">${c && c.dnp ? '&middot;' : '&nbsp;'}</td>`).join('');
      h += plain(p.games ? signed(p.total) : '—', { align: 'right', size: 11, bold: true, color: C.ink, pad: '1px 0 1px 6px' }) + '</tr>';
    }
    return h + '</table>';
  };
  const rows = [d.teams.slice(0, 2), d.teams.slice(2, 4)].map(pair => `<tr>${pair.map(t => `<td valign="top" style="padding:0 12px 14px 0;vertical-align:top">${panel(t)}</td>`).join('')}</tr>`).join('');
  return legend + `<table cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

// ---------- copy ----------

function awards(d) {
  const all = d.teams.flatMap(t => t.hot.filter(p => p.games && !p.bench).map(p => ({ ...p, t })));
  const hot = [...all].sort((a, b) => b.total - a.total)[0];
  const cold = [...all].sort((a, b) => a.total - b.total)[0];
  const bench = d.teams.map(t => { const most = Math.max(0, ...t.hot.map(p => p.benchedGames));
    return { t, games: t.hot.reduce((s, p) => s + p.benchedGames, 0), leaders: most ? t.hot.filter(p => p.benchedGames === most).map(p => p.name) : [] }; })
    .sort((a, b) => b.games - a.games)[0];
  const moves = d.teams.map(t => ({ t, delta: t.st0 ? t.st0.realRank - t.st.realRank : 0, pts: t.st0 ? t.st.realRoto.total - t.st0.realRoto.total : 0 }));
  const climber = [...moves].sort((a, b) => b.delta - a.delta || b.pts - a.pts)[0];
  const faller = [...moves].sort((a, b) => a.delta - b.delta || a.pts - b.pts)[0];
  const sched = [...d.teams].sort((a, b) => b.startGames - a.startGames);
  const fewest = sched[sched.length - 1].startGames;
  const leak = d.teams.map(t => ({ t, lost: t.best.value - t.curValue })).sort((a, b) => b.lost - a.lost)[0];
  return { hot, cold, bench, climber, faller, schedBest: sched[0], schedWorst: sched.filter(t => t.startGames === fewest), leak, moves };
}

function trashTalk(d, a) {
  const out = [];
  const list = xs => xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  const ord = [...d.teams].sort((x, y) => x.st.realRank - y.st.realRank);
  const top = ord[0], bot = ord[ord.length - 1];
  out.push(`${top.who} runs the group chat at #${top.st.realRank} overall. ${bot.who} is #${bot.st.realRank} and is currently paying for everyone's lunch.`);
  const best = bot.hot.filter(p => p.games && !p.bench).sort((x, y) => y.total - x.total)[0];
  if (best && best.total > 0) out.push(`Silver lining for ${bot.who}: ${best.name} went ${signed(best.total)} vs. projection. The comeback starts somewhere.`);
  if (a.climber.delta > 0) out.push(`${a.climber.t.who} climbed ${a.climber.delta} spot${a.climber.delta > 1 ? 's' : ''} this week. Big week, well earned.`);
  if (a.faller.delta < 0) out.push(`${a.faller.t.who} slid ${-a.faller.delta} spot${a.faller.delta < -1 ? 's' : ''}. Thoughts and prayers.`);
  if (a.hot) out.push(`Player of the week: ${a.hot.name} (${a.hot.t.who}), ${signed(a.hot.total)} vs. projection. Enjoy it, it won't last.`);
  if (a.cold && a.cold.total < 0) out.push(`Ice cube award: ${a.cold.name} (${a.cold.t.who}) at ${signed(a.cold.total)} vs. projection. Someone check if he's still in the league.`);
  if (a.bench.games > 0) out.push(`Bench warmer trophy: ${a.bench.t.who} left ${a.bench.games} game${a.bench.games > 1 ? 's' : ''} on the bench last week${a.bench.leaders.length ? `, ${a.bench.t.hot.filter(p => p.benchedGames).length === a.bench.leaders.length ? 'all from' : 'mostly'} ${list(a.bench.leaders)}` : ''}.`);
  const worst = a.schedWorst;
  out.push(`Schedule luck this week: ${a.schedBest.who} gets ${a.schedBest.startGames} starter games, ${list(worst.map(t => t.who))} get${worst.length > 1 ? '' : 's'} ${worst[0].startGames}. Life isn't fair, and neither is the NBA calendar.`);
  const quips = ['Bold strategy.', 'Punting or just vibes?', 'A choice was made.', 'Room to grow.'];
  let q = 0;
  for (const t of d.teams) {
    const last = t.cats.filter(k => k.pts <= 2).map(k => CAT_LABEL[k.c]);
    const first = t.cats.filter(k => k.pts >= 14).map(k => CAT_LABEL[k.c]);
    if (last.length) out.push(`${t.who} is bottom-2 in ${list(last)}${first.length ? ` but top-2 in ${list(first)}. Specialist or punting? You decide.` : `. ${quips[q++ % quips.length]}`}`);
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

function emailHtml(d, a, talk, intro) {
  const row = (cells, head) => `<tr>${cells.map((c, i) => `<${head ? 'th' : 'td'} style="padding:6px 8px;border-bottom:1px solid ${C.grid};text-align:${i === 0 ? 'left' : 'right'};font-size:13px;${head ? `color:${C.muted};font-weight:600;` : `color:${C.ink};`}">${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
  const ord = [...d.teams].sort((x, y) => x.st.realRank - y.st.realRank);
  const table = `<table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;font-family:${FONT}">` +
    row(['Team', 'Overall', 'Roto pts', 'Week Δ', 'Starter games'], true) +
    ord.map(t => { const m = a.moves.find(x => x.t === t); return row([
      `${chip(t.color)}<b>${esc(t.who)}</b> <span style="color:${C.muted}">${esc(t.team)}</span>`,
      `#${t.st.realRank}`, t.st.realRoto.total, m.delta > 0 ? `▲ ${m.delta}` : m.delta < 0 ? `▼ ${-m.delta}` : '–', t.startGames]); }).join('') + '</table>';
  const h2 = s => `<h2 style="font-family:${FONT};font-size:17px;color:${C.ink};margin:28px 0 4px">${s}</h2>`;
  const p = s => `<p style="font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink2};margin:4px 0 10px">${s}</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monday Huddle ${d.monday}</title></head>
<body style="margin:0;padding:0;background:#f9f9f7">
<div style="max-width:640px;margin:0 auto;padding:12px 20px;font-family:${FONT};font-size:12px;color:${C.muted}">To send: select everything below the line (Ctrl/Cmd+A selects only the email box after you click in it), copy, and paste into a new Gmail message. Text stays editable.</div>
<div id="email" contenteditable="true" style="max-width:640px;margin:0 auto;padding:24px 20px;background:${C.surface};outline:none">
<div style="font-family:${FONT};font-size:12px;color:${C.muted};letter-spacing:.06em;text-transform:uppercase">LePrawn · Week of ${fmtDate(d.monday)}</div>
<h1 style="font-family:${FONT};font-size:26px;color:${C.ink};margin:4px 0 12px">The Monday Huddle</h1>
${intro ? intro.split(/\n\s*\n/).map(x => p(esc(x.trim()))).join('') : ''}
${talk.map(x => `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink};margin:0 0 6px">• ${esc(x)}</div>`).join('')}
${h2('The group table')}${p(`Yahoo standings through ${fmtDate(addDays(d.now.date, -1))}. Week Δ is the change in overall rank (out of 15) since ${fmtDate(d.prev.date)}.`)}${table}
${h2('Where the cheap points are')}${p('Roto points per category (15 = best). The small number is how much more you need to pass the next team up. Small gaps are where to aim this week.')}${chartCategories(d)}
${h2('Games this week')}${p(`Starters with a game each day (Mon ${fmtDate(d.week[0])} – Sun ${fmtDate(d.week[6])}), not counting anyone listed Out. "BN" = bench players with a game who won't count. Lineups lock for the whole week, so set them now.`)}${chartGames(d)}
${p('<b>Lineup check</b> (best legal 9 by projected value × games, same math for everyone):')}
${d.teams.map(t => p('• ' + esc(lineupAdvice(t)))).join('')}
${h2('Last week, hot and cold')}${p(`${fmtDate(d.lastWeek[0])} – ${fmtDate(d.lastWeek[6])}. Rows are each team's locked lineup that week (pickups only count from the next lock; BN = benched, so those games didn't count). One square per game: red = beat his projection, blue = stunk. "Week" is the total vs. projection (8-category z-score, so +10 is a big week).`)}${chartHotCold(d)}
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

// Everything behind the email, for fact-checking (box-score line per player per day)
function emailData(d, a) {
  return {
    monday: d.monday, standingsAsOf: d.now.date, prevStandingsAsOf: d.prev.date, lastWeek: d.lastWeek, week: d.week,
    awards: { hot: a.hot && { name: a.hot.name, who: a.hot.t.who, total: +a.hot.total.toFixed(2) }, cold: a.cold && { name: a.cold.name, who: a.cold.t.who, total: +a.cold.total.toFixed(2) },
      bench: { who: a.bench.t.who, games: a.bench.games }, moves: a.moves.map(m => ({ who: m.t.who, rankNow: m.t.st.realRank, rankPrev: m.t.st0 && m.t.st0.realRank, delta: m.delta })) },
    teams: d.teams.map(t => ({ who: t.who, team: t.team, rank: t.st.realRank, rotoTotal: t.st.realRoto.total,
      cats: t.cats, startGames: t.startGames, benchGames: t.benchGames, perDay: t.perDay,
      lineup: t.roster.map(p => ({ slot: p.slot, name: p.name, nbaTeam: p.nbaTeam, status: p.status || null, games: p.nGames })),
      lastWeek: t.hot.map(p => ({ name: p.name, weekTotal: +p.total.toFixed(2), games: p.games, benchedGames: p.benchedGames,
        days: p.cells.map((c, i) => ({ date: d.lastWeek[i], ...(c && c.line ? { line: c.line, vsProj: +c.delta.toFixed(2) } : c && c.dnp ? { dnp: true } : { noGame: true }) })) })) }))
  };
}

async function render(outDir) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 680, height: 800 } });
    await page.goto('file://' + path.join(outDir, 'email.html'));
    await page.locator('#email').screenshot({ path: path.join(outDir, 'preview.png') });
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
  fs.writeFileSync(path.join(outDir, 'email.html'), emailHtml(d, a, talk, intro));
  fs.writeFileSync(path.join(outDir, 'email.txt'), emailText(d, a, talk, intro));
  fs.writeFileSync(path.join(outDir, 'data.json'), JSON.stringify(emailData(d, a), null, 1));
  if (!process.argv.includes('--no-preview')) await render(outDir);
  for (const w of d.warnings) console.log('WARNING ' + w);
  console.log(fs.readFileSync(path.join(outDir, 'email.txt'), 'utf8'));
  console.log(`Wrote ${path.relative(ROOT, outDir)}/ (email.html to paste, email.txt, data.json, preview.png)`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { build, bestLineup };
