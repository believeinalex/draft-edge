const fs = require('fs');
const path = require('path');
const { normName } = require('../engine.js');

/**
 * Player dossiers: one Markdown file per player in season/dossiers/players/, holding
 * dated, sourced notes taken from podcasts, articles and beat reports. Raw source text
 * (e.g. a podcast transcript) is saved verbatim in season/dossiers/sources/.
 *
 * File format (see season/dossiers/README.md):
 *   # Player Name
 *   ## Current take          <- running synthesis, rewritten as notes change the picture
 *   ## Notes                 <- newest first
 *   ### YYYY-MM-DD · Source name: episode/article
 *   Source: sources/YYYY-MM-DD_show-slug.txt   (optional)
 *   Tags: role, minutes                        (optional)
 *   - **Reported:** ... / **Analysis:** ... / **Stat:** ... / **Speculation:** ...
 *
 * Usage:
 *   node season/dossiers.js                 Create missing stubs for both managed rosters, rebuild INDEX.md
 *   node season/dossiers.js "Player Name"   Also create a stub for that player
 *   (npm run dossiers [-- "Player Name"])
 */

const DIR = path.join(__dirname, 'dossiers');
const PLAYER_DIR = path.join(DIR, 'players');
const SOURCE_DIR = path.join(DIR, 'sources');
const LEAGUE = path.join(__dirname, 'league.json');

const slugFor = name => normName(name).replace(/\s+/g, '-');

const ENTRY_RE = /^###\s+(\d{4}-\d{2}-\d{2})\s+·\s+(.+?)\s*$/;

// Parses a dossier into { name, take, entries: [{ date, source, sourceFile, tags, bullets }] }
function parseDossier(text) {
  const lines = text.split('\n');
  const name = (lines.find(l => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
  const entries = [];
  const take = [];
  const problems = [];
  let section = null;
  let cur = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)/);
    if (h2 && !line.startsWith('###')) { section = h2[1].trim().toLowerCase(); cur = null; continue; }
    if (section === 'current take') { if (line.trim()) take.push(line); continue; }
    if (section !== 'notes') continue;
    if (line.startsWith('###')) {
      const m = line.match(ENTRY_RE);
      if (!m) { problems.push(`bad note heading (want "### YYYY-MM-DD · Source"): ${line}`); cur = null; continue; }
      cur = { date: m[1], source: m[2], sourceFile: null, tags: [], bullets: [] };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    const src = line.match(/^Source:\s*(.+)/i);
    if (src) { cur.sourceFile = src[1].trim(); continue; }
    const tags = line.match(/^Tags:\s*(.+)/i);
    if (tags) { cur.tags = tags[1].split(',').map(t => t.trim().toLowerCase()).filter(Boolean); continue; }
    if (/^\s*[-*]\s+/.test(line)) cur.bullets.push(line.replace(/^\s*[-*]\s+/, '').trim());
    else if (/^\s+\S/.test(line) && cur.bullets.length) cur.bullets[cur.bullets.length - 1] += ' ' + line.trim();
  }
  return { name, take: take.join('\n').trim(), entries, problems };
}

function stub(name, info = {}) {
  const meta = [info.nbaTeam && `**NBA:** ${info.nbaTeam}`, info.pos && `**Pos:** ${info.pos}`, info.fantasyTeam && `**Fantasy team:** ${info.fantasyTeam}`]
    .filter(Boolean).join(' · ');
  return [
    `# ${name}`, '',
    ...(meta ? [meta + ` _(as of ${info.asOf || 'creation'}; INDEX.md has the current owner)_`, ''] : []),
    '## Current take', '',
    '_No notes yet._', '',
    '## Notes', '',
    '<!-- Newest first. Heading: ### YYYY-MM-DD · Source name: episode or article. Optional "Source:" and "Tags:" lines, then bullets labelled Reported / Analysis / Stat / Speculation. -->', ''
  ].join('\n');
}

function loadDossiers(dir = PLAYER_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
    const d = parseDossier(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { file: f, ...d };
  });
}

// Notes dated on or after `since` for the given player names: [{ name, file, entry }], newest first
function recentNotes(names, since, dir = PLAYER_DIR) {
  const want = new Set(names.map(normName));
  const out = [];
  for (const d of loadDossiers(dir)) {
    if (!want.has(normName(d.name))) continue;
    for (const e of d.entries) if (e.date >= since) out.push({ name: d.name, file: d.file, entry: e });
  }
  return out.sort((a, b) => b.entry.date.localeCompare(a.entry.date) || a.name.localeCompare(b.name));
}

function main() {
  const league = JSON.parse(fs.readFileSync(LEAGUE, 'utf8'));
  const owner = new Map();
  for (const t of league.teams) for (const r of t.roster) owner.set(normName(r.name), { team: t.name, r });
  fs.mkdirSync(PLAYER_DIR, { recursive: true });
  fs.mkdirSync(SOURCE_DIR, { recursive: true });

  const wanted = [];
  for (const tn of league.managedTeams || [league.myTeam]) {
    const t = league.teams.find(x => x.name === tn);
    if (t) wanted.push(...t.roster.map(r => r.name));
  }
  wanted.push(...process.argv.slice(2).filter(a => !a.startsWith('--')));
  const created = [];
  for (const name of wanted) {
    const file = path.join(PLAYER_DIR, `${slugFor(name)}.md`);
    if (fs.existsSync(file)) continue;
    const o = owner.get(normName(name));
    fs.writeFileSync(file, stub(name, o ? { nbaTeam: o.r.nbaTeam, pos: (o.r.pos || []).join(','), fantasyTeam: o.team, asOf: league.asOf } : {}));
    created.push(name);
  }

  const dossiers = loadDossiers();
  const problems = [];
  const sourceUse = new Map();
  const tag = n => n === league.myTeam ? `**${n}** (you)` : (league.managedTeams || []).includes(n) ? `**${n}** (Finn)` : n;
  const rows = dossiers.map(d => {
    for (const p of d.problems) problems.push(`${d.file}: ${p}`);
    if (slugFor(d.name) + '.md' !== d.file) problems.push(`${d.file}: title "${d.name}" doesn't match the file name (expected ${slugFor(d.name)}.md)`);
    const dates = d.entries.map(e => e.date);
    if (dates.some((x, i) => i && x > dates[i - 1])) problems.push(`${d.file}: notes are not newest-first`);
    for (const e of d.entries) {
      if (!e.sourceFile) continue;
      const key = e.sourceFile.replace(/^(\.\.\/)?sources\//, '');
      if (!fs.existsSync(path.join(SOURCE_DIR, key))) problems.push(`${d.file}: source file not found: ${e.sourceFile}`);
      if (!sourceUse.has(key)) sourceUse.set(key, new Set());
      sourceUse.get(key).add(d.name);
    }
    const o = owner.get(normName(d.name));
    const latest = d.entries.reduce((a, e) => (!a || e.date > a.date ? e : a), null);
    return { d, o, latest };
  }).sort((a, b) => (b.latest?.date || '').localeCompare(a.latest?.date || '') || a.d.name.localeCompare(b.d.name));

  const md = ['# Player dossiers', '',
    `Generated by \`npm run dossiers\` (${league.asOf ? `league data as of ${league.asOf}` : ''}). Don't edit by hand. Format and workflow: [README.md](README.md).`, '',
    '| Player | NBA | Fantasy team | Notes | Latest |', '|---|---|---|---|---|'];
  for (const { d, o, latest } of rows) {
    md.push(`| [${d.name}](players/${d.file}) | ${o?.r.nbaTeam || ''} | ${o ? tag(o.team) : 'FA'} | ${d.entries.length} | ${latest ? `${latest.date} · ${latest.source}` : ''} |`);
  }
  const sources = fs.readdirSync(SOURCE_DIR).filter(f => !f.startsWith('.')).sort().reverse();
  if (sources.length) {
    md.push('', '## Sources', '', '| File | Players noted |', '|---|---|');
    for (const f of sources) md.push(`| [${f}](sources/${f}) | ${[...(sourceUse.get(f) || [])].sort().join(', ') || '_none yet_'} |`);
  }
  if (problems.length) md.push('', '## Problems', '', ...problems.map(p => `- ${p}`));
  fs.writeFileSync(path.join(DIR, 'INDEX.md'), md.join('\n') + '\n');

  if (created.length) console.log(`Created ${created.length} stub(s): ${created.join(', ')}`);
  console.log(`${dossiers.length} dossiers, ${dossiers.reduce((s, d) => s + d.entries.length, 0)} notes, ${sources.length} source files. Wrote season/dossiers/INDEX.md`);
  for (const p of problems) console.log(`WARNING ${p}`);
}

if (require.main === module) main();

module.exports = { slugFor, parseDossier, recentNotes, loadDossiers, stub };
