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

const NAME_ALIASES = {
  'nic claxton': 'nicolas claxton',
  'alex sarr': 'alexandre sarr',
  'cam thomas': 'cameron thomas',
  'herb jones': 'herbert jones',
  'og anunoby': 'og anunoby',
  'porzingus': 'kristaps porzingis',
  'kristaps porzingus': 'kristaps porzingis',
  'embiid': 'joel embiid',
  'jimmy butler': 'jimmy butler iii',
};

function normName(s) {
  if (!s) return '';
  let n = s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g, '') : s;
  n = n.toLowerCase().replace(/[.'']/g, '');
  n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '');
  n = n.replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  return NAME_ALIASES[n] || n;
}

function loadDoNotDraftList(dndPath) {
  const candidates = [
    dndPath,
    path.join(__dirname, 'do_not_draft.json'),
    path.join(__dirname, '..', 'do_not_draft.json')
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = Array.isArray(raw) ? raw : (Array.isArray(raw.players) ? raw.players : []);
        const map = new Map();
        for (const item of list) {
          if (typeof item === 'string') {
            map.set(normName(item), { name: item });
          } else if (item && typeof item === 'object' && (item.name || item.player)) {
            const name = item.name || item.player;
            map.set(normName(name), Object.assign({}, item, { name }));
          }
        }
        return { map, filePath: p };
      } catch (e) {
        console.warn(`Warning: Could not parse Do Not Draft list at ${p}:`, e.message);
      }
    }
  }
  return { map: new Map(), filePath: null };
}

function updateProjections(csvPath, targetPlayersPath, dndPath) {
  csvPath = csvPath || path.join(__dirname, 'projections.csv');
  targetPlayersPath = targetPlayersPath || path.join(__dirname, '..', 'players.js');

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV file is empty');

  // Load existing players if available to preserve mktCost, notes, and previous DND flags
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

  const { map: dndMap, filePath: loadedDndPath } = loadDoNotDraftList(dndPath);
  let dndAppliedCount = 0;

  const header = parseCSVLine(lines[0]);
  const newPlayers = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 10) continue;

    const nameIdx = header.indexOf('PLAYER'); const name = cols[nameIdx];
    const rawAdp = cols[header.indexOf('ADP')];
    const rawPos = cols[header.indexOf('POS')];
    const team = cols[header.indexOf('TEAM')];
    const gp = parseInt(cols[header.indexOf('GP')], 10) || 0;
    const mpg = parseFloat(cols[header.indexOf('MPG')]) || 0;
    const fg = parsePctWithAtt(cols[header.indexOf('FG%')]);
    const ft = parsePctWithAtt(cols[header.indexOf('FT%')]);
    const tpm = parseFloat(cols[header.indexOf('3:00 PM') !== -1 ? header.indexOf('3:00 PM') : header.indexOf('3PM')]) || 0;
    const pts = parseFloat(cols[header.indexOf('PTS')]) || 0;
    const treb = parseFloat(cols[header.indexOf('TREB')]) || 0;
    const ast = parseFloat(cols[header.indexOf('AST')]) || 0;
    const stl = parseFloat(cols[header.indexOf('STL')]) || 0;
    const blk = parseFloat(cols[header.indexOf('BLK')]) || 0;
    const rawTotalZ = header.indexOf('TOTAL') !== -1 ? (parseFloat(cols[header.indexOf('TOTAL')]) || 0) : 0;

    const pos = rawPos ? rawPos.split(',').map(s => s.trim()).filter(Boolean) : [];
    const adp = rawAdp && !isNaN(parseFloat(rawAdp)) ? parseFloat(rawAdp) : null;
    const rk = newPlayers.length + 1;

    const norm = normName(name);
    const existing = existingMap.get(norm);
    const mktCost = existing && existing.mktCost !== undefined ? existing.mktCost : Math.max(1, Math.round(75 * Math.exp(-0.02 * (rk - 1))));

    const dndEntry = dndMap.get(norm);
    const isDnd = !!(dndEntry || (existing && existing.doNotDraft && dndMap.size === 0));

    let totalZ = rawTotalZ;
    let originalTotalZ = undefined;
    if (isDnd) {
      totalZ = 0;
      originalTotalZ = rawTotalZ;
      dndAppliedCount++;
    }

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
      totalZ,
      mktCost
    };

    if (isDnd) {
      playerObj.doNotDraft = true;
      if (originalTotalZ !== undefined) {
        playerObj.originalTotalZ = originalTotalZ;
      }
      if (dndEntry && dndEntry.reason) {
        playerObj.dndReason = dndEntry.reason;
      } else if (existing && existing.dndReason) {
        playerObj.dndReason = existing.dndReason;
      }
    }

    if (existing && existing.note) {
      playerObj.note = existing.note;
    }

    newPlayers.push(playerObj);
  }

  const fileContent = `// Auto-generated from Draft Edge updated PLAYERS dataset (${newPlayers.length}-player pool)
const DRAFT_EDGE_PLAYERS = ${JSON.stringify(newPlayers, null, 2)};

if(typeof module !== 'undefined'){ module.exports = DRAFT_EDGE_PLAYERS; }
`;

  fs.writeFileSync(targetPlayersPath, fileContent, 'utf8');
  console.log(`Successfully updated ${newPlayers.length} players in ${targetPlayersPath}`);
  if (dndAppliedCount > 0) {
    console.log(`Applied Do Not Draft list (${loadedDndPath || 'configured'}): dropped totalZ to 0 and flagged doNotDraft for ${dndAppliedCount} player(s).`);
  }
  return newPlayers;
}

if (require.main === module) {
  updateProjections();
}

module.exports = { updateProjections, parseCSVLine, parsePctWithAtt, loadDoNotDraftList, normName };
