const fs = require('fs');
const path = require('path');

/**
 * Fetches Yahoo's public NBA injury report
 * (https://basketball.fantasysports.yahoo.com/nba/injuries, no login needed) and saves
 * season/injuries/YYYY-MM-DD.json (US Eastern date). Re-running on the same day
 * replaces that day's file, since injury statuses change through the day.
 *
 * Status codes as Yahoo shows them: O out, D doubtful, Q questionable, P probable
 * (also GTD, DTD, INJ, SUSP, NA when present).
 *
 * Usage: node season/fetch_injuries.js   (npm run injuries)
 * In the cloud container, run with NODE_USE_ENV_PROXY=1 (the npm script does).
 */

const PAGE_URL = 'https://basketball.fantasysports.yahoo.com/nba/injuries';
const OUT_DIR = path.join(__dirname, 'injuries');

const decode = s => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseInjuries(html) {
  const players = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/g) || []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (cells.length < 3) continue;
    const nameTag = cells[0].match(/<a[^>]*class="[^"]*\bname\b[^"]*"[^>]*title="([^"]*)"/);
    if (!nameTag) continue;
    const teamPos = text(cells[0]).match(/\b([A-Z]{2,4}) - ([A-Z,]+)/);
    players.push({
      name: decode(nameTag[1]),
      nbaTeam: teamPos ? teamPos[1] : null,
      pos: teamPos ? teamPos[2].split(',') : [],
      note: text(cells[cells.length - 2]),
      status: text(cells[cells.length - 1])
    });
  }
  if (!players.length) throw new Error('No injury rows found: the page layout may have changed');
  return players;
}

async function main() {
  const res = await fetch(PAGE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (draft-edge personal league tool)' } });
  if (!res.ok) throw new Error(`GET ${PAGE_URL} -> ${res.status}`);
  const players = parseInjuries(await res.text());
  const asOf = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${asOf}.json`);
  fs.writeFileSync(out, JSON.stringify({ asOf, fetchedAt: new Date().toISOString(), source: PAGE_URL, players }, null, 2) + '\n');
  const counts = players.reduce((m, p) => ({ ...m, [p.status]: (m[p.status] || 0) + 1 }), {});
  console.log(`Saved ${players.length} injured players -> ${path.relative(process.cwd(), out)} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`fetch_injuries: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseInjuries };
