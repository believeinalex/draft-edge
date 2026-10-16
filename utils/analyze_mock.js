const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { computeAll, buildNameIndex, matchPlayer, normName, CATS } = require('../engine.js');

/**
 * Normalizes 'Last, First' or 'Last Suffix, First' player names to 'First Last'
 * e.g., 'Jackson Jr., Jaren' -> 'Jaren Jackson Jr.'
 *       'Dončić, Luka' -> 'Luka Dončić'
 */
function normalizeNameOrder(rawName) {
  if (!rawName) return '';
  const trimmed = rawName.trim();
  if (trimmed.includes(',')) {
    const parts = trimmed.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      return `${parts.slice(1).join(' ')} ${parts[0]}`;
    }
  }
  return trimmed;
}

/**
 * Parses raw text export from Yahoo / ESPN auction mock drafts.
 */
function parseMockDraftText(text, PLAYERS_LIST) {
  const playersPool = PLAYERS_LIST || PLAYERS;
  const nameIndex = buildNameIndex(playersPool);

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const picks = [];
  const unmatched = [];
  let userTeamName = null;
  const yourTeamRks = new Set();

  // Optional "Your Team" section: 1. Collins, John (DET - PF,C) $6
  const yourTeamRegex = /^\d+\.\s+(.+?)\s+\([^)]+\)\s+\$(\d+)$/;
  // Pattern 1: (1) Ryan - Haliburton, Tyrese (IND - PG,SG) - $52
  const pickRegex = /^\((\d+)\)\s+([^-]+)\s+-\s+(.+?)\s+\([^)]+\)\s+-\s+\$(\d+)/;

  for (const line of lines) {
    const ytMatch = line.match(yourTeamRegex);
    if (ytMatch && picks.length === 0) {
      const cleanYtName = normalizeNameOrder(ytMatch[1].trim());
      const ytPlayer = matchPlayer(cleanYtName, playersPool, nameIndex);
      if (ytPlayer) yourTeamRks.add(ytPlayer.rk);
      continue;
    }

    const match = line.match(pickRegex);
    if (match) {
      const pickNum = parseInt(match[1], 10);
      const teamName = match[2].trim();
      const rawPlayerName = match[3].trim();
      const price = parseInt(match[4], 10);

      const cleanName = normalizeNameOrder(rawPlayerName);
      const playerObj = matchPlayer(cleanName, playersPool, nameIndex);

      if (teamName.toLowerCase() === 'alex' || teamName.toLowerCase() === 'your team' || line.includes('* your team')) {
        userTeamName = teamName;
      }

      if (playerObj) {
        picks.push({
          pickNum,
          teamName,
          rawName: rawPlayerName,
          cleanName,
          rk: playerObj.rk,
          player: playerObj,
          price
        });
      } else {
        unmatched.push({ pickNum, teamName, rawName: rawPlayerName, price });
      }
    }
  }

  // Disambiguate duplicate team names (e.g., two managers named "Alex" in the same room)
  const byTeam = new Map();
  for (const p of picks) {
    if (!byTeam.has(p.teamName)) byTeam.set(p.teamName, []);
    byTeam.get(p.teamName).push(p);
  }
  for (const [tName, tPicks] of byTeam.entries()) {
    if (tPicks.length > 13 && tPicks.length % 13 === 0) {
      const numChunks = tPicks.length / 13;
      let userChunkIdx = 0;
      if (yourTeamRks.size > 0) {
        let bestOverlap = -1;
        for (let c = 0; c < numChunks; c++) {
          const chunk = tPicks.slice(c * 13, (c + 1) * 13);
          const overlap = chunk.filter(p => yourTeamRks.has(p.rk)).length;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            userChunkIdx = c;
          }
        }
      }
      let rivalCounter = 2;
      for (let c = 0; c < numChunks; c++) {
        if (c === userChunkIdx) continue;
        const suffixName = `${tName} (${rivalCounter++})`;
        for (let i = c * 13; i < (c + 1) * 13; i++) {
          tPicks[i].teamName = suffixName;
        }
      }
    }
  }

  return { picks, unmatched, userTeamName: userTeamName || 'Alex' };
}

/**
 * Performs full mock draft analysis.
 */
function analyzeMockDraft(mockData, options = {}) {
  const { picks, unmatched, userTeamName } = mockData;
  const targetUserTeam = options.userTeamName || userTeamName || 'Alex';
  const numTeams = options.numTeams || new Set(picks.map(p => p.teamName)).size || 15;
  const inferredSlots = (picks.length > 0 && numTeams > 0) ? Math.round(picks.length / numTeams) : 12;
  const rosterSlots = options.rosterSlots || inferredSlots;
  const budget = options.budget || 200;

  const state = {
    numTeams,
    rosterSlots,
    budget,
    myTeamName: targetUserTeam,
    weights: Object.fromEntries(CATS.map(c => [c, 1])),
    picks: picks.map(p => ({ rk: p.rk, teamName: p.teamName, price: p.price })),
    starterSlots: options.starterSlots || 9,
    benchWeight: options.benchWeight || 0.3
  };

  const playersPool = options.playersPool || PLAYERS;
  const C = computeAll(state, playersPool);

  // Group picks by team
  const teamsMap = new Map();
  for (const pick of picks) {
    if (!teamsMap.has(pick.teamName)) {
      teamsMap.set(pick.teamName, []);
    }
    teamsMap.get(pick.teamName).push(pick);
  }

  // Calculate per-team total value, spend, and surplus
  const teamSummaries = [];
  for (const [tName, tPicks] of teamsMap.entries()) {
    const totalSpent = tPicks.reduce((sum, p) => sum + p.price, 0);
    const totalMktCost = tPicks.reduce((sum, p) => sum + (p.player.mktCost || 1), 0);
    const surplusValue = totalMktCost - totalSpent;
    const count = tPicks.length;

    teamSummaries.push({
      teamName: tName,
      picksCount: count,
      totalSpent,
      budgetLeft: budget - totalSpent,
      totalMktCost,
      surplusValue,
      isUserTeam: tName.toLowerCase() === targetUserTeam.toLowerCase()
    });
  }

  // Calculate league surplus steals and overpays
  const allSurplusPicks = picks.map(p => {
    const mkt = p.player.mktCost || 1;
    const surplus = mkt - p.price;
    return {
      pickNum: p.pickNum,
      teamName: p.teamName,
      playerName: p.player.name,
      paidPrice: p.price,
      mktCost: mkt,
      surplus
    };
  });

  const steals = allSurplusPicks.slice().sort((a, b) => b.surplus - a.surplus);
  const overpays = allSurplusPicks.slice().sort((a, b) => a.surplus - b.surplus);

  // Calculate major market price moves (Stock Watch)
  const priceMoves = picks.map(p => {
    const mkt = p.player.mktCost || 1;
    const delta = p.price - mkt;
    const pctDelta = mkt > 0 ? Math.round((delta / mkt) * 100) : 0;
    return {
      pickNum: p.pickNum,
      teamName: p.teamName,
      playerName: p.player.name,
      paidPrice: p.price,
      mktCost: mkt,
      delta,
      pctDelta
    };
  });
  const surges = priceMoves.slice().sort((a, b) => b.delta - a.delta || b.pctDelta - a.pctDelta);
  const dips = priceMoves.slice().sort((a, b) => a.delta - b.delta || a.pctDelta - b.pctDelta);

  // User team breakdown
  const userPicks = picks.filter(p => p.teamName.toLowerCase() === targetUserTeam.toLowerCase());

  return {
    state,
    compute: C,
    powerRankings: C.powerRankings,
    teamSummaries,
    steals: steals.slice(0, 10),
    overpays: overpays.slice(0, 10),
    surges: surges.slice(0, 10),
    dips: dips.slice(0, 10),
    userPicks,
    targetUserTeam,
    unmatched
  };
}

/**
 * Format and print mock draft report to console.
 */
function printReport(analysis) {
  const { powerRankings, teamSummaries, steals, overpays, userPicks, targetUserTeam, unmatched } = analysis;

  console.log('\n================================================================================');
  console.log(`                       MOCK DRAFT ANALYSIS REPORT (${targetUserTeam})`);
  console.log('================================================================================\n');

  console.log('--- LEAGUE POWER RANKINGS ---');
  console.log('Rank  Team                     Tot Points   Spent ($)   Surplus ($)');
  console.log('--------------------------------------------------------------------------------');
  powerRankings.forEach((pr, i) => {
    const tName = pr.teamName || 'Unknown';
    const summary = teamSummaries.find(s => s.teamName.toLowerCase() === tName.toLowerCase()) || {};
    const marker = tName.toLowerCase() === targetUserTeam.toLowerCase() ? ' <== YOUR TEAM' : '';
    const nameStr = tName.padEnd(24);
    const ptsStr = String(pr.total).padStart(10);
    const spentStr = String(summary.totalSpent || 0).padStart(10);
    const surplusStr = String((summary.surplusValue || 0) >= 0 ? `+$${summary.surplusValue || 0}` : `-$${Math.abs(summary.surplusValue || 0)}`).padStart(12);
    console.log(`${String(i + 1).padStart(2)}.   ${nameStr} ${ptsStr}   ${spentStr}   ${surplusStr}${marker}`);
  });

  const userRankIdx = powerRankings.findIndex(pr => pr.teamName.toLowerCase() === targetUserTeam.toLowerCase());
  const userPR = userRankIdx !== -1 ? powerRankings[userRankIdx] : null;

  if (userPR) {
    console.log('\n================================================================================');
    console.log(`                       YOUR TEAM SUMMARY: ${targetUserTeam}`);
    console.log('================================================================================');
    console.log(`Overall League Finish: #${userRankIdx + 1} of ${powerRankings.length} teams (${userPR.total} Total Rank Points)`);
    
    const userSummary = teamSummaries.find(s => s.teamName.toLowerCase() === targetUserTeam.toLowerCase());
    if (userSummary) {
      console.log(`Total Roster: ${userSummary.picksCount} players | Total Spent: $${userSummary.totalSpent} / $200 | Net Surplus Value: ${userSummary.surplusValue >= 0 ? '+' : ''}$${userSummary.surplusValue}`);
    }

    console.log('\nCategory Ranks (1 = 1st in League, 14 = Last):');
    CATS.forEach(c => {
      const catObj = userPR.catRanks[c] || {};
      const catRank = catObj.rank || 14;
      const categoryLabel = c.toUpperCase().padEnd(6);
      const rankBar = '#'.repeat(15 - catRank);
      console.log(`  ${categoryLabel}: #${String(catRank).padStart(2)}  [${rankBar.padEnd(14)}] (${catObj.tier || 'mid'})`);
    });

    console.log('\nYour Roster Picks & Value Breakdown:');
    console.log('Pick  Player Name                 Paid ($)  Mkt Cost ($)  Surplus ($)');
    console.log('--------------------------------------------------------------------------------');
    userPicks.forEach(p => {
      const mkt = p.player.mktCost || 1;
      const surplus = mkt - p.price;
      const surpStr = surplus >= 0 ? `+$${surplus}` : `-$${Math.abs(surplus)}`;
      console.log(`${String(p.pickNum).padStart(4)}  ${p.player.name.padEnd(26)} $${String(p.price).padStart(3)}       $${String(mkt).padStart(3)}        ${surpStr.padStart(6)}`);
    });
  }

  console.log('\n================================================================================');
  console.log('                       TOP LEAGUE VALUE STEALS');
  console.log('================================================================================');
  steals.slice(0, 5).forEach((s, i) => {
    console.log(`${i + 1}. ${s.playerName} (${s.teamName}): Paid $${s.paidPrice} vs $${s.mktCost} Mkt Value (+$${s.surplus} Surplus)`);
  });

  console.log('\n================================================================================');
  console.log('                       TOP LEAGUE OVERPAYS');
  console.log('================================================================================');
  overpays.slice(0, 5).forEach((o, i) => {
    console.log(`${i + 1}. ${o.playerName} (${o.teamName}): Paid $${o.paidPrice} vs $${o.mktCost} Mkt Value (-$${Math.abs(o.surplus)} Surplus)`);
  });

  console.log('\n================================================================================');
  console.log('                 MAJOR MARKET PRICE MOVES (Stock Watch)');
  console.log('================================================================================');
  console.log('--- Top Price Surges (Stock Rising / Bullish Price Spikes) ---');
  (analysis.surges || []).filter(p => p.delta > 0).slice(0, 5).forEach((p, i) => {
    const pctStr = p.pctDelta >= 0 ? `+${p.pctDelta}%` : `${p.pctDelta}%`;
    console.log(`${i + 1}. ${p.playerName} (${p.teamName}): Paid $${p.paidPrice} vs $${p.mktCost} Mkt Median (+$${p.delta}, ${pctStr})`);
  });
  console.log('\n--- Top Price Drops (Stock Falling / Value Dips) ---');
  (analysis.dips || []).filter(p => p.delta < 0).slice(0, 5).forEach((p, i) => {
    const pctStr = p.pctDelta >= 0 ? `+${p.pctDelta}%` : `${p.pctDelta}%`;
    console.log(`${i + 1}. ${p.playerName} (${p.teamName}): Paid $${p.paidPrice} vs $${p.mktCost} Mkt Median (-$${Math.abs(p.delta)}, ${pctStr})`);
  });

  if (unmatched.length > 0) {
    console.log(`\nNotice: ${unmatched.length} picks could not be matched to the player database.`);
  }

  console.log('\n================================================================================\n');
}

function runAnalysisFromFile(filePath, userTeamName = 'Alex', options = {}) {
  const mockPath = filePath || path.join(__dirname, 'mock.txt');
  if (!fs.existsSync(mockPath)) {
    throw new Error(`Mock draft file not found at ${mockPath}`);
  }
  const text = fs.readFileSync(mockPath, 'utf8');

  // Archive to drafts dir if it's not already there
  const draftsDir = (options && options.draftsDir) || path.join(__dirname, '..', 'drafts');
  const isAlreadyInDrafts = path.resolve(mockPath).startsWith(path.resolve(draftsDir));
  
  if (!isAlreadyInDrafts) {
    if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir);
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').split('T');
    const timestamp = `${dateStr[0]}_${dateStr[1].substring(0, 6)}`;
    const destName = `mock_${timestamp}.txt`;
    fs.writeFileSync(path.join(draftsDir, destName), text);
    console.log(`[Auto-Archive] Saved a copy to drafts/${destName}`);
  }

  // Recalculate and update draft average & median prices across all mock drafts
  const shouldUpdatePrices = (options && options.updatePrices !== undefined) ? options.updatePrices : true;
  if (shouldUpdatePrices) {
    try {
      const { calculateDraftPrices } = require('./calculate_draft_prices.js');
      const priceRes = calculateDraftPrices({ draftsDir });
      console.log(`[Auto-Pricing] Recalculated empirical average & median prices across ${priceRes.uniqueDraftsCount} drafts in players.js and prices.csv.`);
    } catch (err) {
      console.warn('[Auto-Pricing] Warning: failed to recalculate draft prices:', err.message);
    }
  }

  // Reload fresh players if updated
  const playersPath = path.join(__dirname, '..', 'players.js');
  let playersPool = PLAYERS;
  try {
    delete require.cache[require.resolve(playersPath)];
    playersPool = require(playersPath);
  } catch (e) {
    playersPool = PLAYERS;
  }

  const parsed = parseMockDraftText(text, playersPool);
  const analysis = analyzeMockDraft(parsed, { userTeamName, playersPool, ...(options || {}) });
  printReport(analysis);
  
  return analysis;
}

module.exports = {
  parseMockDraftText,
  analyzeMockDraft,
  normalizeNameOrder,
  runAnalysisFromFile
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const fileArg = args.find(a => !a.startsWith('--'));
  const userArg = args.find(a => a.startsWith('--user='));
  const noPricesArg = args.includes('--no-update-prices');
  const userTeamName = userArg ? userArg.split('=')[1] : 'Alex';
  runAnalysisFromFile(fileArg, userTeamName, { updatePrices: !noPricesArg });
  
  // Try to run historical analysis automatically
  try {
    const { execSync } = require('child_process');
    const out = execSync(`node ${path.join(__dirname, 'analyze_history.js')} --user="${userTeamName}"`, { encoding: 'utf8' });
    console.log(out);
  } catch (err) {
    // Silently ignore if analyze_history is not available or fails
  }
}
