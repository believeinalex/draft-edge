const fs = require('fs');
const path = require('path');
const { normName } = require('../engine.js');

/**
 * Exact box-score lines per player per day from ESPN (scoreboard + game summaries).
 * The stats snapshots only hold per-game averages rounded to 0.1, so differencing them adds a few
 * counts of noise per team and flips tight roto ranks. Box scores are whole numbers.
 * Finished days are cached in season/boxscores/YYYY-MM-DD.json (only when every game is final).
 */

const DIR = path.join(__dirname, 'boxscores');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const pair = s => { const m = /^(\d+)-(\d+)$/.exec(s || ''); return m ? [+m[1], +m[2]] : [0, 0]; };
const num = s => { const n = parseInt(s, 10); return Number.isFinite(n) ? n : 0; };

async function getJson(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
  }
  throw err;
}

// Turns one ESPN summary's boxscore into per-player lines
function parseSummary(summary) {
  const out = [];
  for (const team of (summary.boxscore && summary.boxscore.players) || []) {
    for (const group of team.statistics || []) {
      const idx = Object.fromEntries((group.labels || []).map((l, i) => [l, i]));
      for (const a of group.athletes || []) {
        const s = a.stats || [];
        if (!s.length || a.didNotPlay) continue;
        const min = s[idx.MIN];
        if (min === undefined || min === '' || min === '--' || num(min) === 0 && !/^\d/.test(min)) continue;
        const [fgm, fga] = pair(s[idx.FG]), [tpm] = pair(s[idx['3PT']]), [ftm, fta] = pair(s[idx.FT]);
        out.push({
          name: a.athlete.displayName, nbaTeam: team.team.abbreviation, games: 1,
          fgm, fga, ftm, fta, tpm, pts: num(s[idx.PTS]), treb: num(s[idx.REB]), ast: num(s[idx.AST]), stl: num(s[idx.STL]), blk: num(s[idx.BLK])
        });
      }
    }
  }
  return out;
}

// Lines for every finished game on dateIso (ET). Returns { complete, players } where complete is
// false if any game that day isn't final yet (so the result isn't cached).
async function fetchDay(dateIso, { cache = true } = {}) {
  const file = path.join(DIR, `${dateIso}.json`);
  if (cache && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const board = await getJson(`${API}/scoreboard?dates=${dateIso.replace(/-/g, '')}`);
  const events = board.events || [];
  const players = [];
  let complete = true;
  for (const e of events) {
    if (e.status.type.state !== 'post') { complete = false; continue; }
    players.push(...parseSummary(await getJson(`${API}/summary?event=${e.id}`)));
  }
  const day = { date: dateIso, complete, games: events.length, players };
  if (cache && complete && events.length) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(day)); }
  return day;
}

const addDays = (iso, n) => new Date(new Date(iso + 'T12:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);

// Games played on the dates from..to inclusive, as Map(normName -> summed line)
async function linesBetween(fromIso, toIso, opts) {
  const lines = new Map();
  const days = [];
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) {
    const day = await fetchDay(d, opts);
    days.push({ date: d, complete: day.complete, games: day.games });
    for (const p of day.players) {
      const k = normName(p.name);
      const l = lines.get(k) || { name: p.name, nbaTeam: p.nbaTeam, games: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0 };
      for (const c of Object.keys(l)) if (typeof l[c] === 'number') l[c] += p[c] || 0;
      lines.set(k, l);
    }
  }
  return { lines, days };
}

module.exports = { parseSummary, fetchDay, linesBetween, addDays };
