const fs = require('fs');
const path = require('path');
const { parseMockDraftText, analyzeMockDraft } = require('./analyze_mock.js');

function analyzeHistory() {
  const draftsDir = path.join(__dirname, '..', 'drafts');
  if (!fs.existsSync(draftsDir)) {
    console.log('No drafts directory found.');
    return;
  }

  const files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.txt'));
  if (files.length === 0) {
    console.log('No draft files found in drafts directory.');
    return;
  }

  let totalDrafts = 0;
  let totalSurplus = 0;
  let totalRankPoints = 0;
  let firstPlaceFinishes = 0;
  let totalPosRanks = {
    fgPct: 0, ftPct: 0, tpm: 0, pts: 0, treb: 0, ast: 0, stl: 0, blk: 0
  };
  
  // Track most profitable players across all drafts
  const playerProfits = {};

  const args = process.argv.slice(2);
  const userArg = args.find(a => a.startsWith('--user='));
  const userTeamName = userArg ? userArg.split('=')[1] : 'Alex';

  for (const file of files) {
    const text = fs.readFileSync(path.join(draftsDir, file), 'utf8');
    const parsed = parseMockDraftText(text);
    // Suppress console output from analyzeMockDraft if any
    const analysis = analyzeMockDraft(parsed, { userTeamName });
    
    const targetTeam = analysis.teamSummaries.find(t => t.teamName === analysis.targetUserTeam);
    if (!targetTeam) {
      console.log(`Skipping ${file}: User team '${userTeamName}' not found.`);
      continue;
    }

    totalDrafts++;
    totalSurplus += targetTeam.surplusValue;
    
    // Find the power ranking points
    const powerTeam = analysis.powerRankings.find(t => t.teamName === analysis.targetUserTeam);
    if (powerTeam) {
      totalRankPoints += powerTeam.total;
      const rank = analysis.powerRankings.findIndex(t => t.teamName === analysis.targetUserTeam) + 1;
      if (rank === 1) firstPlaceFinishes++;
    }

    const catRanks = powerTeam ? powerTeam.catRanks : {};
    for (const [cat, obj] of Object.entries(catRanks)) {
      totalPosRanks[cat] += obj.rank;
    }

    const userPicks = analysis.userPicks || [];
    for (const pick of userPicks) {
      if (!pick.player) continue;
      const name = pick.player.name;
      const mktCost = pick.player.mktCost || 0;
      const surplus = mktCost - pick.price;
      if (!playerProfits[name]) playerProfits[name] = { drafts: 0, totalSurplus: 0 };
      playerProfits[name].drafts++;
      playerProfits[name].totalSurplus += surplus;
    }
  }

  if (totalDrafts === 0) return;

  console.log('================================================================================');
  console.log(`                       HISTORICAL DRAFT ANALYSIS (${totalDrafts} Drafts)`);
  console.log('================================================================================');
  console.log(`Average League Finish: #${(firstPlaceFinishes/totalDrafts === 1 ? 1 : 'N/A')} (Win Rate: ${((firstPlaceFinishes/totalDrafts)*100).toFixed(1)}%)`);
  console.log(`Average Total Rank Points: ${(totalRankPoints / totalDrafts).toFixed(1)}`);
  console.log(`Average Net Surplus Value: +$${(totalSurplus / totalDrafts).toFixed(1)}`);
  console.log('\n--- Average Category Ranks (1 = Best, 14 = Worst) ---');
  for (const [cat, tot] of Object.entries(totalPosRanks)) {
    const avg = tot / totalDrafts;
    console.log(`  ${cat.padEnd(5)}: #${avg.toFixed(1).padEnd(4)}`);
  }

  console.log('\n--- Most Profitable Players Across All Drafts ---');
  const sortedPlayers = Object.entries(playerProfits)
    .sort((a, b) => b[1].totalSurplus - a[1].totalSurplus)
    .slice(0, 10);
  
  for (const [name, stats] of sortedPlayers) {
    const avgSurplus = stats.totalSurplus / stats.drafts;
    console.log(`  ${name.padEnd(25)} | Drafted ${stats.drafts}x | Avg Surplus: +$${avgSurplus.toFixed(1)}`);
  }
  console.log('================================================================================\n');
}

if (require.main === module) {
  analyzeHistory();
}
