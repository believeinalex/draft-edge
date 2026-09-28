const fs = require('fs');
const path = require('path');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parsePctWithAtt(str) {
  if (!str) return { pct: 0, m: 0, a: 0 };
  const match = str.match(/^([\d\.]+)\(([\d\.]+)\/([\d\.]+)\)$/);
  if (!match) return { pct: parseFloat(str) || 0, m: 0, a: 0 };
  return {
    pct: parseFloat(match[1]),
    m: parseFloat(match[2]),
    a: parseFloat(match[3])
  };
}

function normName(s) {
  if (!s) return '';
  let n = s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  n = n.toLowerCase().replace(/[.'']/g, '').replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return n;
}

function updateProjections(csvPath, targetPlayersPath) {
  csvPath = csvPath || path.join(__dirname, 'projections.csv');
  targetPlayersPath = targetPlayersPath || path.join(__dirname, '..', 'players.js');

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV file is empty');

  // Load existing players if available to preserve mktCost and notes
  let existingMap = new Map();
  if (fs.existsSync(targetPlayersPath)) {
    try {
      const existingPlayers = require(targetPlayersPath);
      if (Array.isArray(existingPlayers)) {
        for (const p of existingPlayers) {
          existingMap.set(normName(p.name), p);
        }
      }
    } catch (e) {
      // Ignore if cannot require
    }
  }

  const header = parseCSVLine(lines[0]);
  const newPlayers = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 10) continue;

    const name = cols[0];
    const rawAdp = cols[1];
    const rawPos = cols[2];
    const team = cols[3];
    const gp = parseInt(cols[4], 10) || 0;
    const mpg = parseFloat(cols[5]) || 0;
    const fg = parsePctWithAtt(cols[6]);
    const ft = parsePctWithAtt(cols[7]);
    const tpm = parseFloat(cols[8]) || 0;
    const pts = parseFloat(cols[9]) || 0;
    const treb = parseFloat(cols[10]) || 0;
    const ast = parseFloat(cols[11]) || 0;
    const stl = parseFloat(cols[12]) || 0;
    const blk = parseFloat(cols[13]) || 0;

    const pos = rawPos ? rawPos.split(',').map(s => s.trim()).filter(Boolean) : [];
    const adp = rawAdp && !isNaN(parseFloat(rawAdp)) ? parseFloat(rawAdp) : null;
    const rk = newPlayers.length + 1;

    const existing = existingMap.get(normName(name));
    const mktCost = existing && existing.mktCost !== undefined ? existing.mktCost : Math.max(1, Math.round(75 * Math.exp(-0.02 * (rk - 1))));

    const playerObj = {
      rk,
      name,
      pos,
      team,
      gp,
      mpg,
      fgPct: fg.pct,
      fgm: fg.m,
      fga: fg.a,
      ftPct: ft.pct,
      ftm: ft.m,
      fta: ft.a,
      tpm,
      pts,
      treb,
      ast,
      stl,
      blk,
      adp,
      mktCost
    };

    if (existing && existing.note) {
      playerObj.note = existing.note;
    }

    newPlayers.push(playerObj);
  }

  const fileContent = `// Auto-generated from Draft Edge updated PLAYERS dataset (${newPlayers.length}-player pool)
const DRAFT_EDGE_PLAYERS = ${JSON.stringify(newPlayers)};

if(typeof module !== 'undefined'){ module.exports = DRAFT_EDGE_PLAYERS; }
`;

  fs.writeFileSync(targetPlayersPath, fileContent, 'utf8');
  console.log(`Successfully updated ${newPlayers.length} players in ${targetPlayersPath}`);
  return newPlayers;
}

if (require.main === module) {
  updateProjections();
}

module.exports = { updateProjections, parseCSVLine, parsePctWithAtt };
