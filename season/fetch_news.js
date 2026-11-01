const fs = require('fs');
const path = require('path');
const { normName } = require('../engine.js');
const PLAYERS = require('../players.js');
const { fetchCoverage, coverageMarkdown } = require('./team_coverage.js');

/**
 * Daily injury & news digest from ESPN's public NBA endpoints (no login needed).
 * - /injuries: every injured player with ESPN's short and long Rotowire-style comments.
 *   The long comment often names who gains minutes ("Mathurin could enter the starting
 *   lineup"), which is the role-impact signal this digest surfaces.
 * - /news: recent NBA articles tagged with players (fantasy columns, transactions).
 *
 * Writes season/news/YYYY-MM-DD.json (US Eastern date) and reports/YYYY-MM-DD-news.md:
 *   1. Players on the two managed teams: status, comments and expected return date.
 *   2. Role watch: injured teammates of managed players (their absence or return moves minutes).
 *   3. Changes since the previous saved digest, for every rostered player.
 *   4. Articles that mention a rostered player.
 *
 * Usage: node season/fetch_news.js   (npm run news)
 * In the cloud container, run with NODE_USE_ENV_PROXY=1 (the npm script does).
 */

const ROOT = path.join(__dirname, '..');
const NEWS_DIR = path.join(__dirname, 'news');
const REPORT_DIR = path.join(ROOT, 'reports');
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';

// ESPN and our data use different abbreviations for a few teams
const TEAM_ALIASES = { WSH: 'WAS', SA: 'SAS', NO: 'NOP', NY: 'NYK', GS: 'GSW', UTAH: 'UTA', PHO: 'PHX' };
const canonTeam = t => (t ? TEAM_ALIASES[t] || t : t);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (draft-edge personal league tool)' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

function parseInjuries(json) {
  const out = [];
  for (const team of json.injuries || []) {
    for (const i of team.injuries || []) {
      const a = i.athlete || {};
      out.push({
        name: a.displayName,
        team: canonTeam((a.team || {}).abbreviation),
        status: i.status,
        fantasyStatus: ((i.details || {}).fantasyStatus || {}).abbreviation || null,
        injury: (i.details || {}).type || null,
        returnDate: (i.details || {}).returnDate || null,
        date: i.date,
        shortComment: i.shortComment || '',
        longComment: i.longComment || ''
      });
    }
  }
  if (!out.length) throw new Error('No injury entries found: the ESPN response may have changed');
  return out;
}

function parseArticles(json) {
  return (json.articles || []).map(a => ({
    published: a.published,
    headline: a.headline,
    description: a.description || '',
    link: ((a.links || {}).web || {}).href || null,
    athletes: (a.categories || []).filter(c => c.type === 'athlete').map(c => c.description).filter(Boolean)
  }));
}

// Compare two digests' injury lists, keyed by player name
function diffInjuries(prev, cur, isRostered) {
  const was = new Map(prev.map(p => [normName(p.name), p]));
  const now = new Map(cur.map(p => [normName(p.name), p]));
  const changes = [];
  for (const [k, p] of now) {
    if (!isRostered(k)) continue;
    const o = was.get(k);
    if (!o) changes.push({ kind: 'new', now: p });
    else if (o.status !== p.status || o.returnDate !== p.returnDate || o.shortComment !== p.shortComment) changes.push({ kind: 'changed', was: o, now: p });
  }
  for (const [k, o] of was) if (isRostered(k) && !now.has(k)) changes.push({ kind: 'cleared', was: o });
  return changes;
}

// Trim ESPN's long comments to the first sentences that fit
const brief = (t, max = 420) => {
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return (end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '')) + (end > 120 ? '' : '…');
};

// A teammate matters if he's in the rotation (15+ mpg this season, or top-250 projection) or a comment names our player
function isRotation(name, stats) {
  const s = stats.get(normName(name));
  if (s && s.mpg >= 15) return true;
  const p = PLAYERS.find(x => normName(x.name) === normName(name));
  return !!(p && p.rk <= 250);
}

const line = p => `${p.status}${p.injury ? ` (${p.injury})` : ''}${p.returnDate ? `, expected back ${p.returnDate}` : ''}${p.date ? `, updated ${p.date.slice(0, 10)}` : ''}`;

function buildMarkdown({ today, league, injuries, articles, changes, owner, stats }) {
  const md = [`# Injury & news digest — ${today}`, '', 'Source: ESPN injuries and news feeds. Comments are ESPN\'s; role-impact reads are inferred.', ''];
  const tag = name => {
    const o = owner.get(normName(name));
    return o === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(o) ? ' **(Finn)**' : o ? ` (${o})` : '';
  };
  for (const tn of league.managedTeams) {
    const t = league.teams.find(x => x.name === tn);
    md.push(`## ${tn}`, '');
    const mine = t.roster.map(r => ({ r, inj: injuries.find(i => normName(i.name) === normName(r.name)) })).filter(x => x.inj);
    if (!mine.length) md.push('No injury entries for this roster.', '');
    for (const { r, inj } of mine) {
      md.push(`- **${r.name}** (${r.nbaTeam}): ${line(inj)}`, `  - ${brief(inj.longComment || inj.shortComment)}`);
    }
    if (mine.length) md.push('');
  }

  md.push('## Role watch: injured teammates of your players', '');
  md.push('Rotation-level teammates only (15+ mpg this season, a top-250 projection, or a comment that names your player). A teammate\'s absence or return shifts minutes to or from your players.', '');
  let any = false;
  for (const tn of league.managedTeams) {
    const t = league.teams.find(x => x.name === tn);
    const byTeam = new Map();
    for (const r of t.roster) {
      const team = canonTeam(r.nbaTeam);
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push(r.name);
    }
    for (const [team, ours] of byTeam) {
      const mates = injuries.filter(i => i.team === team && !ours.some(n => normName(n) === normName(i.name)));
      for (const m of mates) {
        const named = t.roster.filter(r => m.longComment.includes(r.name)).map(r => r.name);
        if (!named.length && !isRotation(m.name, stats)) continue;
        any = true;
        md.push(`- **${m.name}** (${team}, ${line(m)}) affects ${ours.join(', ')} on ${tn}${named.length ? `; comment names ${named.join(', ')}` : ''}`, `  - ${brief(m.longComment || m.shortComment)}`);
      }
    }
  }
  if (!any) md.push('No injured rotation teammates of your players.');
  md.push('');

  md.push('## Changes since the previous digest (rostered players)', '');
  if (changes === null) md.push('No earlier digest to compare with.');
  else if (!changes.length) md.push('No changes.');
  else {
    for (const c of changes) {
      const p = c.now || c.was;
      const label = c.kind === 'new' ? `new: ${line(c.now)}` : c.kind === 'cleared' ? `cleared (was ${line(c.was)})` : `${line(c.was)} → ${line(c.now)}`;
      md.push(`- **${p.name}**${tag(p.name)} — ${label}${c.now ? `: ${c.now.shortComment}` : ''}`);
    }
  }
  md.push('');

  md.push('## Articles mentioning rostered players', '');
  const hits = articles.filter(a => !/Game Highlights/i.test(a.headline)).map(a => ({ a, names: a.athletes.filter(n => owner.has(normName(n))) })).filter(x => x.names.length);
  if (!hits.length) md.push('None.');
  for (const { a, names } of hits) md.push(`- ${a.headline} — ${names.map(n => `${n}${tag(n)}`).join(', ')}${a.link ? ` ([link](${a.link}))` : ''}`);
  md.push('');
  return md.join('\n');
}

async function main() {
  const league = JSON.parse(fs.readFileSync(path.join(__dirname, 'league.json'), 'utf8'));
  const owner = new Map();
  for (const t of league.teams) for (const r of t.roster) owner.set(normName(r.name), t.name);

  const injuries = parseInjuries(await getJson(`${BASE}/injuries`));
  const articles = parseArticles(await getJson(`${BASE}/news?limit=100`));

  // NBA teams that have a player on a managed team, with those players
  const teamMap = new Map();
  for (const tn of league.managedTeams) {
    for (const r of league.teams.find(x => x.name === tn).roster) {
      const abbr = canonTeam(r.nbaTeam);
      if (!teamMap.has(abbr)) teamMap.set(abbr, []);
      teamMap.get(abbr).push(r.name);
    }
  }
  const covTeams = [...teamMap].map(([abbr, ours]) => ({ abbr, ours })).sort((a, b) => a.abbr.localeCompare(b.abbr));
  let coverage = {}, covErrors = [];
  try { ({ coverage, errors: covErrors } = await fetchCoverage(covTeams)); } catch (e) { covErrors = [e.message]; }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  fs.mkdirSync(NEWS_DIR, { recursive: true });
  const earlier = fs.readdirSync(NEWS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f < `${today}.json`).sort();
  const prev = earlier.length ? JSON.parse(fs.readFileSync(path.join(NEWS_DIR, earlier[earlier.length - 1]), 'utf8')) : null;
  const changes = prev ? diffInjuries(prev.injuries, injuries, k => owner.has(k)) : null;

  fs.writeFileSync(path.join(NEWS_DIR, `${today}.json`), JSON.stringify({ asOf: today, fetchedAt: new Date().toISOString(), source: BASE, injuries, articles, coverage }, null, 2) + '\n');
  const latest = JSON.parse(fs.readFileSync(path.join(ROOT, 'stats', 'latest.json'), 'utf8'));
  const stats = new Map(latest.players.map(p => [normName(p.name), p]));
  const md = buildMarkdown({ today, league, injuries, articles, changes, owner, stats }) + '\n' + coverageMarkdown(coverage, covTeams, covErrors);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const out = path.join(REPORT_DIR, `${today}-news.md`);
  fs.writeFileSync(out, md);
  console.log(md);
  console.log(`\nSaved season/news/${today}.json and ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`fetch_news: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { canonTeam, parseInjuries, parseArticles, diffInjuries, brief };
