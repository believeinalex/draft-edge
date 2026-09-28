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

function normName(s) {
  if (!s) return '';
  let n = s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
  n = n.toLowerCase().replace(/[.'']/g, '').replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return n;
}

function parsePrice(str) {
  if (!str) return 0;
  const cleaned = str.replace(/\$/g, '').replace(/,/g, '').trim();
  const val = parseFloat(cleaned);
  return isNaN(val) || val < 0 ? 0 : val;
}

function updatePrices(csvPath, targetPlayersPath) {
  csvPath = csvPath || path.join(__dirname, 'prices.csv');
  targetPlayersPath = targetPlayersPath || path.join(__dirname, '..', 'players.js');

  if (!fs.existsSync(csvPath)) {
    throw new Error(`Price CSV file not found at ${csvPath}`);
  }
  if (!fs.existsSync(targetPlayersPath)) {
    throw new Error(`Target players.js file not found at ${targetPlayersPath}`);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const lines = csvContent.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) throw new Error('Price CSV is empty');

  const header = parseCSVLine(lines[0]);
  const playerIdx = header.findIndex(h => h.toUpperCase() === 'PLAYER');
  const valuedAtIdx = header.findIndex(h => h.toUpperCase() === 'VALUED AT');
  const yAvgIdx = header.findIndex(h => h.toUpperCase().includes('Y!') || h.toUpperCase().includes('Y AVG'));
  const espnAvgIdx = header.findIndex(h => h.toUpperCase().includes('ESPN'));

  if (playerIdx === -1) throw new Error('PLAYER column not found in price CSV header');
  if (valuedAtIdx === -1 && yAvgIdx === -1 && espnAvgIdx === -1) {
    throw new Error('No price columns (VALUED AT, Y! AVG, ESPN AVG) found in price CSV header');
  }

  const priceMap = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length <= playerIdx) continue;

    const rawName = cols[playerIdx];
    if (!rawName) continue;

    const pValuedAt = valuedAtIdx !== -1 ? parsePrice(cols[valuedAtIdx]) : 0;
    const pYAvg = yAvgIdx !== -1 ? parsePrice(cols[yAvgIdx]) : 0;
    const pEspnAvg = espnAvgIdx !== -1 ? parsePrice(cols[espnAvgIdx]) : 0;

    const maxVal = Math.max(pValuedAt, pYAvg, pEspnAvg);
    const estimatedPrice = maxVal > 0 ? Math.max(1, Math.round(maxVal)) : 1;

    priceMap.set(normName(rawName), {
      rawName,
      valuedAt: pValuedAt,
      yAvg: pYAvg,
      espnAvg: pEspnAvg,
      maxVal,
      estimatedPrice
    });
  }

  const existingPlayers = require(targetPlayersPath);
  let updatedCount = 0;
  let unmatchedCount = 0;

  const updatedPlayers = existingPlayers.map(p => {
    const norm = normName(p.name);
    const priceData = priceMap.get(norm);
    if (priceData) {
      updatedCount++;
      return Object.assign({}, p, { mktCost: priceData.estimatedPrice });
    } else {
      unmatchedCount++;
      return p;
    }
  });

  const fileContent = `// Auto-generated from Draft Edge updated PLAYERS dataset (${updatedPlayers.length}-player pool)
const DRAFT_EDGE_PLAYERS = ${JSON.stringify(updatedPlayers, null, 2)};

if (typeof module !== 'undefined') { module.exports = DRAFT_EDGE_PLAYERS; }
`;

  fs.writeFileSync(targetPlayersPath, fileContent, 'utf8');
  console.log(`Updated market costs in ${targetPlayersPath}: ${updatedCount} matched & updated, ${unmatchedCount} unmatched.`);
  return { updatedPlayers, updatedCount, unmatchedCount };
}

if (require.main === module) {
  updatePrices();
}

module.exports = { updatePrices, parseCSVLine, parsePrice, normName };
