const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseMockDraftText } = require('./analyze_mock.js');
const { parseCSVLine, parsePrice, normName } = require('./update_prices.js');

function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr, m) {
  if (!arr || arr.length <= 1) return 0;
  return Math.sqrt(arr.reduce((sq, n) => sq + Math.pow(n - m, 2), 0) / arr.length);
}

function calculateDraftPrices(options = {}) {
  const draftsDir = options.draftsDir || path.join(__dirname, '..', 'drafts');
  const targetPlayersPath = options.targetPlayersPath || path.join(__dirname, '..', 'players.js');
  const targetCsvPath = options.targetCsvPath || path.join(__dirname, 'prices.csv');
  const reportCsvPath = options.reportCsvPath || path.join(__dirname, 'draft_prices.csv');

  if (!fs.existsSync(draftsDir)) {
    throw new Error(`Drafts directory not found at ${draftsDir}`);
  }
  if (!fs.existsSync(targetPlayersPath)) {
    throw new Error(`Target players.js not found at ${targetPlayersPath}`);
  }

  delete require.cache[require.resolve(targetPlayersPath)];
  const existingPlayers = require(targetPlayersPath);

  // 1. Deduplicate draft files by content MD5 hash
  const files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.txt'));
  const seenHashes = new Set();
  const uniqueDrafts = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(draftsDir, file), 'utf8');
    const hash = crypto.createHash('md5').update(content.trim()).digest('hex');
    if (!seenHashes.has(hash)) {
      seenHashes.add(hash);
      uniqueDrafts.push({ file, content });
    }
  }

  // 2. Parse picks from each unique draft
  const playerPicks = new Map(); // rk -> array of prices
  for (const draft of uniqueDrafts) {
    const parsed = parseMockDraftText(draft.content, existingPlayers);
    if (!parsed || !parsed.picks) continue;
    for (const pick of parsed.picks) {
      if (!pick.player) continue;
      const rk = pick.player.rk;
      if (!playerPicks.has(rk)) {
        playerPicks.set(rk, []);
      }
      playerPicks.get(rk).push(pick.price);
    }
  }

  // 3. Compute stats for all players
  const statsMap = new Map();
  for (const p of existingPlayers) {
    const prices = playerPicks.get(p.rk) || [];
    const count = prices.length;
    const min = count > 0 ? Math.min(...prices) : 0;
    const max = count > 0 ? Math.max(...prices) : 0;
    const avg = mean(prices);
    const med = median(prices);
    const sd = stdDev(prices, avg);

    // If drafted, market cost is the rounded median (min $1). If never drafted, $1.
    const mktCost = count > 0 ? Math.max(1, Math.round(med)) : 1;

    statsMap.set(p.rk, {
      rk: p.rk,
      name: p.name,
      pos: (p.pos || []).join('/'),
      team: p.team || '',
      count,
      min,
      max,
      avg: parseFloat(avg.toFixed(2)),
      med: parseFloat(med.toFixed(2)),
      sd: parseFloat(sd.toFixed(2)),
      mktCost
    });
  }

  // 4. Update players.js with new mktCost
  const updatedPlayers = existingPlayers.map(p => {
    const st = statsMap.get(p.rk);
    const newCost = st ? st.mktCost : 1;
    return Object.assign({}, p, { mktCost: newCost });
  });

  const playersFileContent = `// Auto-generated from Draft Edge empirical draft sample (${updatedPlayers.length}-player pool)
const DRAFT_EDGE_PLAYERS = ${JSON.stringify(updatedPlayers, null, 2)};

if (typeof module !== 'undefined') { module.exports = DRAFT_EDGE_PLAYERS; }
`;
  const tmpPlayersPath = targetPlayersPath + '.tmp';
  fs.writeFileSync(tmpPlayersPath, playersFileContent, 'utf8');
  fs.renameSync(tmpPlayersPath, targetPlayersPath);

  // 5. Write detailed report to draft_prices.csv
  const sortedStats = [...statsMap.values()].sort((a, b) => b.mktCost - a.mktCost || b.avg - a.avg);
  let reportCsvContent = 'RK,PLAYER,POS,TEAM,DRAFT_COUNT,MIN,MAX,AVG,MEDIAN,SD,FINAL_MKT_COST\n';
  for (const s of sortedStats) {
    reportCsvContent += `${s.rk},"${s.name}","${s.pos}","${s.team}",${s.count},$${s.min.toFixed(2)},$${s.max.toFixed(2)},$${s.avg.toFixed(2)},$${s.med.toFixed(2)},$${s.sd.toFixed(2)},$${s.mktCost}\n`;
  }
  fs.writeFileSync(reportCsvPath, reportCsvContent, 'utf8');

  // 6. Update prices.csv if it exists
  if (fs.existsSync(targetCsvPath)) {
    const csvContent = fs.readFileSync(targetCsvPath, 'utf8');
    const lines = csvContent.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length > 0) {
      const header = parseCSVLine(lines[0]);
      let draftMedColIdx = header.findIndex(h => h.toUpperCase().includes('DRAFT MED'));
      let draftAvgColIdx = header.findIndex(h => h.toUpperCase().includes('DRAFT AVG'));
      let draftCountColIdx = header.findIndex(h => h.toUpperCase().includes('DRAFT COUNT'));

      let newHeader = [...header];
      if (draftMedColIdx === -1) {
        draftMedColIdx = newHeader.length;
        newHeader.push('DRAFT MED');
      }
      if (draftAvgColIdx === -1) {
        draftAvgColIdx = newHeader.length;
        newHeader.push('DRAFT AVG');
      }
      if (draftCountColIdx === -1) {
        draftCountColIdx = newHeader.length;
        newHeader.push('DRAFT COUNT');
      }

      const playerIdx = header.findIndex(h => h.toUpperCase() === 'PLAYER');
      const newLines = [newHeader.map(h => (h.includes(',') ? `"${h}"` : h)).join(',')];

      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        if (cols.length <= playerIdx) {
          newLines.push(lines[i]);
          continue;
        }
        const playerName = cols[playerIdx];
        const normalized = normName(playerName);
        const matchPlayerObj = existingPlayers.find(p => normName(p.name) === normalized);
        const st = matchPlayerObj ? statsMap.get(matchPlayerObj.rk) : null;

        while (cols.length < newHeader.length) {
          cols.push('');
        }
        cols[draftMedColIdx] = st ? `$${st.med.toFixed(2)}` : '$0.00';
        cols[draftAvgColIdx] = st ? `$${st.avg.toFixed(2)}` : '$0.00';
        cols[draftCountColIdx] = st ? `${st.count}` : '0';

        const formattedCols = cols.map(c => (c.includes(',') ? `"${c}"` : c));
        newLines.push(formattedCols.join(','));
      }
      fs.writeFileSync(targetCsvPath, newLines.join('\n') + '\n', 'utf8');
    }
  }

  console.log(`Analyzed ${uniqueDrafts.length} unique drafts across ${files.length} files.`);
  console.log(`Updated market costs in ${targetPlayersPath} and saved report to ${reportCsvPath}.`);

  return {
    uniqueDraftsCount: uniqueDrafts.length,
    totalFiles: files.length,
    updatedCount: updatedPlayers.length,
    statsMap
  };
}

if (require.main === module) {
  calculateDraftPrices();
}

module.exports = { calculateDraftPrices, median, mean, stdDev };
