const fs = require('fs');
const path = require('path');

/**
 * Parses Yahoo weekly lineup pastes (League > Rosters page) into JSON.
 *
 * Raw pastes live in season/lineups/raw/YYYY-MM-DD.txt and are parsed to
 * season/lineups/YYYY-MM-DD.json. Each team block looks like:
 *
 *   Grilled Teampura          <- team name (missing for the first block if cut off in the copy)
 *   Pos
 *   Player
 *   PG<TAB>
 *   Tyrese MaxeyPlayer Note   <- name + optional status tag (Q, O, NA, ...) + Yahoo note label
 *   PHI - PG
 *   7:00 pm vs CLE            <- optional: game today
 *
 * The league locks lineups weekly, so this is the lineup in effect for the current
 * week. Mid-week adds, drops and trades only show up in next week's lineup.
 *
 * Usage: node season/parse_lineups.js
 */

const RAW_DIR = path.join(__dirname, 'lineups', 'raw');
const OUT_DIR = path.join(__dirname, 'lineups');

const SLOT_RE = /^(PG|SG|G|SF|PF|F|C|Util|BN|IL\+?|NA)$/;
const NAME_RE = /^(.+?)(Q|O|D|P|NA|GTD|DTD|INJ|SUSP)?(New Player Note|Player Note|No new player Notes)$/;
const TEAM_POS_RE = /^([A-Z]{2,3}) - ([A-Z,]+)$/;
const GAME_RE = /^\d{1,2}:\d{2} (am|pm) (vs|@) [A-Z]{2,3}$/;

function parseLineupText(text) {
  const blocks = [];
  let block = null;
  let slot = null;
  let player = null;
  const newBlock = team => {
    block = { team, players: [] };
    blocks.push(block);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'Player') continue;
    if (line === 'Pos') {
      // A "Pos" header with no team name before it (the first block when the copy was cut off)
      if (!block || block.players.length) newBlock(null);
      continue;
    }
    let m;
    if (SLOT_RE.test(line)) {
      slot = line;
    } else if ((m = line.match(NAME_RE)) && slot) {
      player = { slot, name: m[1].trim(), status: m[2] || null, nbaTeam: null, pos: [], gameToday: null };
      block.players.push(player);
      slot = null;
    } else if ((m = line.match(TEAM_POS_RE)) && player) {
      player.nbaTeam = m[1];
      player.pos = m[2].split(',');
    } else if (GAME_RE.test(line) && player) {
      player.gameToday = line;
    } else {
      newBlock(line);
      player = null;
    }
  }
  return blocks.filter(b => b.players.length || b.team);
}

function main() {
  const files = fs.readdirSync(RAW_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f)).sort();
  if (!files.length) throw new Error(`No raw lineups in ${RAW_DIR}`);
  const overridesFile = path.join(OUT_DIR, 'overrides.json');
  const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
  for (const f of files) {
    const asOf = f.replace('.txt', '');
    const teams = parseLineupText(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'));
    // Verified fill-ins for pastes that were cut off (season/lineups/overrides.json)
    const extra = (overrides[asOf] || {});
    for (const [team, o] of Object.entries(extra)) {
      const block = teams.find(b => b.team === team);
      if (!block) throw new Error(`overrides.json: no lineup block for "${team}" in ${f}`);
      for (const p of o.players) block.players.push({ status: null, gameToday: null, ...p, fromOverride: true });
    }
    const snap = { asOf, source: `season/lineups/raw/${f}`, teams };
    fs.writeFileSync(path.join(OUT_DIR, `${asOf}.json`), JSON.stringify(snap, null, 2) + '\n');
    console.log(`${f}: ${teams.length} team blocks, ${teams.reduce((s, t) => s + t.players.length, 0)} players` +
      (teams.some(t => !t.team) ? ' (one block has no team name; inferred in build_season.js)' : ''));
  }
}

if (require.main === module) main();

module.exports = { parseLineupText };
