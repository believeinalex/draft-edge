const fs = require('fs');
const path = require('path');

/**
 * Fetches season-to-date stats from Hashtag Basketball's rankings page
 * (https://hashtagbasketball.com/fantasy-basketball-rankings) and saves them as
 * stats/raw/YYYY-MM-DD.txt in the same tab-separated format as a manual paste, so
 * stats/parse_stats.js handles both.
 *
 * The page is an ASP.NET form: the first GET returns the default view (top 200,
 * turnovers counted, H2H values). The script posts the form back with our league's
 * settings: all players, TO unchecked (8-cat league), Standard (roto) values,
 * season-to-date per-game averages.
 *
 * Usage: node stats/fetch_htb.js [--date=YYYY-MM-DD] [--force]
 * In the cloud container, run with NODE_USE_ENV_PROXY=1 (npm run fetch-stats does).
 */

const PAGE_URL = 'https://hashtagbasketball.com/fantasy-basketball-rankings';
const RAW_DIR = path.join(__dirname, 'raw');
const P = 'ctl00$ContentPlaceHolder1$';
const HEADER = ['R#', 'PLAYER', 'POS', 'TEAM', 'GP', 'MPG', 'FG%', 'FT%', '3PM', 'PTS', 'TREB', 'AST', 'STL', 'BLK', 'TOTAL'];

// Our settings, applied on top of whatever the page defaults to
const OVERRIDES = {
  [`${P}DDSHOW`]: '900',     // All players
  [`${P}DDDURATION`]: '1',   // Current regular season, to date
  [`${P}DDRANK`]: 'AVG',     // Per-game averages
  [`${P}DDGAMES`]: '1',      // Min GP
  [`${P}DDTYPE`]: 'STA'      // Standard (roto) values: FG%/FT% weighted by volume. The page defaults to H2H.
};
const UNCHECK = [`${P}CBTO`]; // Turnovers are not a category in our league

const decode = s => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};

// Collects what a browser would submit for the page's <form>
function formFields(html) {
  const fields = new URLSearchParams();
  for (const tag of html.match(/<input\b[^>]*>/g) || []) {
    const name = attr(tag, 'name');
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (!name) continue;
    if (type === 'checkbox' || type === 'radio') {
      if (/\bchecked\b/.test(tag)) fields.append(name, attr(tag, 'value') || 'on');
    } else if (type !== 'submit' && type !== 'button' && type !== 'image') {
      fields.append(name, attr(tag, 'value') || '');
    }
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(m[1], 'name');
    const opts = [...m[2].matchAll(/<option\b([^>]*)>/g)].map(o => o[1]);
    const sel = opts.find(o => /\bselected\b/.test(o)) || opts[0];
    if (name && sel) fields.append(name, attr(sel, 'value') || '');
  }
  return fields;
}

// Rankings table -> tab-separated lines matching a copy-paste from the page
function tableToText(html) {
  const table = html.match(/<table[^>]*id="ContentPlaceHolder1_GridView1"[^>]*>([\s\S]*?)<\/table>/);
  if (!table) throw new Error('Rankings table not found: the page layout may have changed');
  const lines = [];
  let header = null;
  for (const row of table[1].match(/<tr\b[\s\S]*?<\/tr>/g) || []) {
    const cells = [...row.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]>/g)];
    if (cells[0] && cells[0][1] === 'h') {
      header = cells.map(c => text(c[2]));
      continue;
    }
    if (!header) continue;
    const out = {};
    cells.forEach((c, i) => {
      const col = header[i];
      let v;
      if (col === 'PLAYER') {
        const full = c[2].match(/<a[^>]*HyperLink1[^>]*>([\s\S]*?)<\/a>/);
        v = text(full ? full[1] : c[2]);
      } else if (col === 'R#') {
        // Rank plus Hashtag's movement arrow since its last update: "5 ↑2" -> "5  +2"
        const rank = text(c[2].replace(/<span[\s\S]*<\/span>/, ''));
        const move = c[2].match(/arrow-circle-(up|down)[\s\S]*?<\/i>\s*(\d+)/);
        v = move ? `${rank}  ${move[1] === 'up' ? '+' : '-'}${move[2]}` : rank;
      } else if (col === 'FG%' || col === 'FT%') {
        v = text(c[2]).replace(/\s+/g, ''); // "0.552 (16.0/29.0)" -> "0.552(16.0/29.0)"
      } else {
        v = text(c[2]);
      }
      out[col] = v;
    });
    if (!out.PLAYER) continue;
    lines.push(HEADER.map(h => (h === 'POS' && !out[h] ? ' ' : out[h] ?? '')).join('\t'));
  }
  if (header && header.includes('TO')) throw new Error('TO column still present: the turnover toggle did not apply');
  return [HEADER.join('\t'), ...lines].join('\n') + '\n';
}

async function fetchStats() {
  const headers = { 'User-Agent': 'Mozilla/5.0 (draft-edge personal league tool)' };
  const first = await fetch(PAGE_URL, { headers });
  if (!first.ok) throw new Error(`GET ${PAGE_URL} -> ${first.status}`);
  const html = await first.text();
  const cookie = (first.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');

  const fields = formFields(html);
  for (const [k, v] of Object.entries(OVERRIDES)) fields.set(k, v);
  for (const k of UNCHECK) fields.delete(k);
  fields.set('__EVENTTARGET', UNCHECK[0]);
  fields.set('__EVENTARGUMENT', '');

  const res = await fetch(PAGE_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded', Referer: PAGE_URL, ...(cookie ? { Cookie: cookie } : {}) },
    body: fields.toString()
  });
  if (!res.ok) throw new Error(`POST ${PAGE_URL} -> ${res.status}`);
  return tableToText(await res.text());
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const date = args.date || new Date().toISOString().slice(0, 10);
  const out = path.join(RAW_DIR, `${date}.txt`);
  if (fs.existsSync(out) && !args.force) {
    console.log(`${path.relative(process.cwd(), out)} already exists; keeping it (pass --force to replace).`);
    return;
  }
  const raw = await fetchStats();
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.writeFileSync(out, raw);
  console.log(`Saved ${raw.trim().split('\n').length - 1} players -> ${path.relative(process.cwd(), out)}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`fetch_htb: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { formFields, tableToText, fetchStats };
