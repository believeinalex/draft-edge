/**
 * Team coverage: recent headlines from outlets that carry beat-writer and team-site reporting,
 * for every NBA team that has a player on a managed team. No login or API key needed.
 * - Google News RSS, one query per team (headline, outlet, time; no article text).
 * - Yahoo Sports NBA RSS and CBS Sports NBA RSS (team-site and analysis posts), filtered by
 *   team name or managed player name.
 * Items from the last 36 hours are kept, betting promos and odds pieces are dropped, and
 * stories that name a managed player are marked.
 */

const PLAYERS = require('../players.js');

const TEAM_NAMES = {
  ATL: 'Atlanta Hawks', BOS: 'Boston Celtics', BKN: 'Brooklyn Nets', CHA: 'Charlotte Hornets', CHI: 'Chicago Bulls',
  CLE: 'Cleveland Cavaliers', DAL: 'Dallas Mavericks', DEN: 'Denver Nuggets', DET: 'Detroit Pistons', GSW: 'Golden State Warriors',
  HOU: 'Houston Rockets', IND: 'Indiana Pacers', LAC: 'Los Angeles Clippers', LAL: 'Los Angeles Lakers', MEM: 'Memphis Grizzlies',
  MIA: 'Miami Heat', MIL: 'Milwaukee Bucks', MIN: 'Minnesota Timberwolves', NOP: 'New Orleans Pelicans', NYK: 'New York Knicks',
  OKC: 'Oklahoma City Thunder', ORL: 'Orlando Magic', PHI: 'Philadelphia 76ers', PHX: 'Phoenix Suns', POR: 'Portland Trail Blazers',
  SAC: 'Sacramento Kings', SAS: 'San Antonio Spurs', TOR: 'Toronto Raptors', UTA: 'Utah Jazz', WAS: 'Washington Wizards'
};

const MAX_AGE_MS = 36 * 3600 * 1000;
const NOISE = /\b(odds|promo|promos|bonus|sportsbook|betting|picks?|parlay|prediction|best bets?|props?)\b|where to watch|stream info|game summary|\bMLB\b|\bTigers\b/i;
const NOISE_SOURCES = /^(Fubo)$/i;

// A headline names a player if it has his full name, or his surname when no other player in the pool shares that token
const surnameUnique = name => { const last = name.split(' ').slice(-1)[0]; return last.length >= 5 && PLAYERS.filter(p => p.name.split(' ').includes(last)).length === 1; };
const mentionsOf = (title, ours) => ours.filter(n => title.includes(n) || (surnameUnique(n) && title.includes(n.split(' ').slice(-1)[0])));

const decode = s => s
  .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const clean = s => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function parseRss(xml, defaultSource) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const get = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? clean(x[1]) : ''; };
    let title = get('title');
    let source = get('source') || get('dc:creator') || defaultSource;
    // Google News appends " - Outlet" to every headline
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return { title, source, link: get('link'), published: get('pubDate') ? new Date(get('pubDate')).toISOString() : null };
  }).filter(i => i.title);
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (draft-edge personal league tool)' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

const googleUrl = team => `https://news.google.com/rss/search?q=${encodeURIComponent(`"${team}" (injury OR lineup OR starting OR rest OR return OR rotation) when:2d`)}&hl=en-US&gl=US&ceid=US:en`;

/**
 * @param {{abbr: string, ours: string[]}[]} teams NBA teams to cover and the managed-team players on each
 * @param {number} now ms timestamp (injectable for tests)
 * @returns {{coverage: Object, errors: string[]}} coverage[abbr] = [{title, source, link, published, mentions:[names]}]
 */
async function fetchCoverage(teams, now = Date.now()) {
  const errors = [];
  const shared = [];
  for (const [label, url] of [['Yahoo Sports', 'https://sports.yahoo.com/nba/rss/'], ['CBS Sports', 'https://www.cbssports.com/rss/headlines/nba/']]) {
    try { shared.push(...parseRss(await getText(url), label)); } catch (e) { errors.push(`${label}: ${e.message}`); }
  }
  const coverage = {};
  for (const { abbr, ours } of teams) {
    const name = TEAM_NAMES[abbr] || abbr;
    const nick = name.split(' ').slice(-1)[0];
    let items = [];
    try { items = parseRss(await getText(googleUrl(name)), 'Google News'); } catch (e) { errors.push(`${name}: ${e.message}`); }
    items.push(...shared.filter(i => new RegExp(`\\b${nick}\\b`).test(i.title) || mentionsOf(i.title, ours).length));
    const seen = new Set();
    coverage[abbr] = items
      .filter(i => !i.published || now - new Date(i.published).getTime() <= MAX_AGE_MS)
      .filter(i => !NOISE.test(i.title) && !NOISE_SOURCES.test(i.source) && !(i.title.replace(/[\x00-\x7F]/g, '').length > i.title.length / 2))
      .filter(i => { const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(i => ({ ...i, mentions: mentionsOf(i.title, ours) }))
      .sort((a, b) => (b.mentions.length - a.mentions.length) || (new Date(b.published || 0) - new Date(a.published || 0)));
  }
  return { coverage, errors };
}

function coverageMarkdown(coverage, teams, errors, perTeam = 6) {
  const md = ['## Team coverage (headlines from beat and team sites, last 36 hours)', '',
    'Headlines and outlets only; open a story for details. ★ marks a headline that names one of your players.', ''];
  for (const { abbr, ours } of teams) {
    const items = (coverage[abbr] || []).slice(0, perTeam);
    md.push(`**${TEAM_NAMES[abbr] || abbr}** — ${ours.join(', ')}`);
    if (!items.length) md.push('- No recent headlines found.');
    for (const i of items) md.push(`- ${i.mentions.length ? '★ ' : ''}${i.title} — ${i.source}${i.published ? `, ${i.published.slice(5, 16).replace('T', ' ')}Z` : ''}`);
    md.push('');
  }
  if (errors.length) md.push(`Some sources failed: ${errors.join('; ')}`, '');
  return md.join('\n');
}

module.exports = { mentionsOf, TEAM_NAMES, parseRss, fetchCoverage, coverageMarkdown };
