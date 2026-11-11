const { normName } = require('../engine.js');

/**
 * RotoWire's live NBA injury feed (https://www.rotowire.com/basketball/news.php?view=injuries).
 * It lists the 25 most recent injury updates, including in-game exits (e.g. "Doesn't return
 * Wednesday") that ESPN's injury notes pick up hours later. No login or API key needed.
 */

const URL = 'https://www.rotowire.com/basketball/news.php?view=injuries';

const decode = s => s
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

function parseRotowire(html) {
  const items = html.split('<div class="news-update is-injured">').slice(1).map(p => {
    const g = re => { const m = p.match(re); return m ? decode(m[1]) : ''; };
    return {
      team: (p.match(/alt="([A-Z]{2,4})"/) || [])[1] || null,
      name: g(/news-update__player-link[^>]*>([\s\S]*?)<\/a>/),
      headline: g(/news-update__headline[^>]*>([\s\S]*?)<\/a>/),
      pos: g(/news-update__pos[^>]*>([\s\S]*?)<\/div>/),
      injury: g(/news-update__inj[^>]*>([\s\S]*?)<\/div>/),
      date: g(/news-update__timestamp[^>]*>([\s\S]*?)<\/div>/),
      news: g(/news-update__news[^>]*>([\s\S]*?)<\/div>/),
      analysis: g(/news-update__analysis[^>]*>([\s\S]*?)<\/div>/)
    };
  }).filter(i => i.name);
  if (!items.length) throw new Error('No RotoWire injury items found: the page layout may have changed');
  return items;
}

async function fetchRotowire() {
  const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0 (draft-edge personal league tool)' } });
  if (!res.ok) throw new Error(`GET ${URL} -> ${res.status}`);
  return parseRotowire(await res.text());
}

// One line per player (latest update first in the feed), grouped: managed teams, other rostered, free agents
function rotowireMarkdown(items, league, owner) {
  const seen = new Set();
  const latest = items.filter(i => { const k = normName(i.name); if (seen.has(k)) return false; seen.add(k); return true; });
  const tag = name => {
    const o = owner.get(normName(name));
    return o === league.myTeam ? ' **(you)**' : (league.managedTeams || []).includes(o) ? ` **${league.managedLabel || '(Finn)'}**` : o ? ` (${o})` : '';
  };
  const groups = { managed: [], rostered: [], free: [] };
  for (const i of latest) {
    const o = owner.get(normName(i.name));
    (o && (o === league.myTeam || (league.managedTeams || []).includes(o)) ? groups.managed : o ? groups.rostered : groups.free).push(i);
  }
  const row = i => `- **${i.name}**${tag(i.name)} (${i.team || '?'}${i.injury ? `, ${i.injury}` : ''}) — ${i.headline}, ${i.date}`;
  const md = ['## RotoWire injury feed (latest updates)', '',
    `Source: RotoWire's injury news page, ${items.length} latest updates (${latest.length} players). It catches in-game exits before ESPN's notes update.`, ''];
  md.push('**Your two teams**', '', ...(groups.managed.length ? groups.managed.map(row) : ['- None in the latest updates.']), '');
  md.push('**Other rostered players**', '', ...(groups.rostered.length ? groups.rostered.map(row) : ['- None.']), '');
  md.push('**Free agents** (possible pickups or handcuffs)', '', ...(groups.free.length ? groups.free.map(row) : ['- None.']), '');
  return md.join('\n');
}

module.exports = { parseRotowire, fetchRotowire, rotowireMarkdown };
