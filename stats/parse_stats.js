const fs = require('fs');
const path = require('path');

/**
 * Parses Yahoo player-list stat exports (copied from the Players page) into JSON.
 *
 * Raw snapshots live in stats/raw/YYYY-MM-DD.txt. Each one is parsed to
 * stats/snapshots/YYYY-MM-DD.json, and the newest is copied to stats/latest.json.
 *
 * Row format (tab-separated; header rows repeat every 12 lines and are skipped):
 *   5  2	Paolo Banchero	PF	ORL	1	41.2	0.833(10.0/12.0)	0.750(12.0/16.0)	3.0	35.0	7.0	10.0	1.0	0.0	13.37
 * The R# column is the Yahoo rank, optionally followed by a second number whose
 * meaning is unclear (kept as `rankNote`). Stat columns are per-game averages.
 *
 * Usage: node stats/parse_stats.js
 */

const RAW_DIR = path.join(__dirname, 'raw');
const SNAP_DIR = path.join(__dirname, 'snapshots');
const LATEST_FILE = path.join(__dirname, 'latest.json');

// "0.552(16.0/29.0)" -> { pct: 0.552, made: 16, att: 29 }
function parseShooting(s) {
  const m = s.trim().match(/^([\d.]+)\(([\d.]+)\/([\d.]+)\)$/);
  if (!m) throw new Error(`Bad shooting value: ${s}`);
  return { pct: parseFloat(m[1]), made: parseFloat(m[2]), att: parseFloat(m[3]) };
}

function parseStatsText(text) {
  const players = [];
  const seen = new Set();
  const duplicates = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('R#')) continue;
    const cols = line.split('\t');
    if (cols.length < 15) throw new Error(`Expected 15 columns, got ${cols.length}: ${line}`);
    const [rankCol, name, pos, nbaTeam, gp, mpg, fg, ft, tpm, pts, treb, ast, stl, blk, total] = cols;
    const [rank, rankNote] = rankCol.trim().split(/\s+/).map(n => parseInt(n, 10));
    const key = name.trim();
    if (seen.has(key)) {
      duplicates.push(key);
      continue;
    }
    seen.add(key);
    const fgS = parseShooting(fg);
    const ftS = parseShooting(ft);
    players.push({
      rank,
      rankNote: Number.isNaN(rankNote) || rankNote === undefined ? null : rankNote,
      name: key,
      pos: pos.trim() ? pos.trim().split(',') : [],
      nbaTeam: nbaTeam.trim(),
      gp: parseInt(gp, 10),
      mpg: parseFloat(mpg),
      fgPct: fgS.pct, fgm: fgS.made, fga: fgS.att,
      ftPct: ftS.pct, ftm: ftS.made, fta: ftS.att,
      tpm: parseFloat(tpm),
      pts: parseFloat(pts),
      treb: parseFloat(treb),
      ast: parseFloat(ast),
      stl: parseFloat(stl),
      blk: parseFloat(blk),
      yahooTotal: parseFloat(total)
    });
  }
  return { players, duplicates: [...new Set(duplicates)] };
}

function main() {
  const files = fs.readdirSync(RAW_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
  if (!files.length) throw new Error(`No raw snapshots in ${RAW_DIR}`);
  fs.mkdirSync(SNAP_DIR, { recursive: true });

  let latest = null;
  for (const f of files) {
    const asOf = f.replace('.txt', '');
    const { players, duplicates } = parseStatsText(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'));
    const snap = { asOf, source: `stats/raw/${f}`, perGame: true, players };
    fs.writeFileSync(path.join(SNAP_DIR, `${asOf}.json`), JSON.stringify(snap, null, 2) + '\n');
    const maxGp = Math.max(...players.map(p => p.gp));
    console.log(`${f}: ${players.length} players (max GP ${maxGp})` +
      (duplicates.length ? `, skipped duplicate rows for ${duplicates.join(', ')}` : ''));
    latest = snap;
  }
  fs.writeFileSync(LATEST_FILE, JSON.stringify(latest, null, 2) + '\n');
  console.log(`Latest snapshot (${latest.asOf}) -> stats/latest.json`);
}

if (require.main === module) main();

module.exports = { parseStatsText, parseShooting };
