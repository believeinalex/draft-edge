const fs = require('fs');
const path = require('path');
const players = require('../players.js');
const engine = require('../engine.js');

// Parse CLI arguments
const args = process.argv.slice(2);
let runs = 1;
for (const arg of args) {
  if (arg.startsWith('--runs=')) {
    runs = parseInt(arg.split('=')[1], 10);
  } else if (arg === '--runs') {
    const idx = process.argv.indexOf('--runs');
    if (idx + 1 < process.argv.length) runs = parseInt(process.argv[idx + 1], 10);
  }
}

console.log(`Starting Monte Carlo Simulation with ${runs} runs...`);
console.log(`Note: A single run can take ~2 minutes due to the exact knapsack solver used by our bot.\n`);

const BOT_TYPES = {
  OURS: 'ours',
  MARKET: 'market',
  STARS_SCRUBS: 'stars_scrubs',
  BUDGET: 'budget',
  HOMER: 'homer'
};

const TEAMS = [
  { name: 'Alex', type: BOT_TYPES.OURS },
  { name: 'Market1', type: BOT_TYPES.MARKET },
  { name: 'Market2', type: BOT_TYPES.MARKET },
  { name: 'Market3', type: BOT_TYPES.MARKET },
  { name: 'Market4', type: BOT_TYPES.MARKET },
  { name: 'Market5', type: BOT_TYPES.MARKET },
  { name: 'SnS1', type: BOT_TYPES.STARS_SCRUBS },
  { name: 'SnS2', type: BOT_TYPES.STARS_SCRUBS },
  { name: 'Budget1', type: BOT_TYPES.BUDGET },
  { name: 'Budget2', type: BOT_TYPES.BUDGET },
  { name: 'Budget3', type: BOT_TYPES.BUDGET },
  { name: 'HomerNYK', type: BOT_TYPES.HOMER, favoriteTeam: 'NYK' },
  { name: 'HomerBOS', type: BOT_TYPES.HOMER, favoriteTeam: 'BOS' },
  { name: 'HomerLAL', type: BOT_TYPES.HOMER, favoriteTeam: 'LAL' },
];

function getBotMaxBid(bot, player, C, state) {
  const { budgetLeft, slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
  if (slotsLeft <= 0) return 0;

  let maxBid = 0;

  if (bot.type === BOT_TYPES.OURS) {
    const cp = engine.checkPrice(state, players, player.rk);
    if (!cp || cp.full) return 0;
    maxBid = cp.maxBid;
  } else {
    // Fair price includes inflation dynamically updated based on remaining money vs pool
    const fairPrice = C.fairPrice(player.rk);

    // Fuzzy factor between 0.9 and 1.1 (+/- 10%)
    const fuzzy = 0.9 + Math.random() * 0.2;
    const baseBid = fairPrice * fuzzy;

    if (bot.type === BOT_TYPES.MARKET) {
      maxBid = baseBid;
    } else if (bot.type === BOT_TYPES.STARS_SCRUBS) {
      // Overbid early rounds (e.g. fair market cost >= 30), otherwise bargain hunt
      if ((player.mktCost || 0) >= 30) maxBid = baseBid * 1.3;
      else maxBid = 1;
    } else if (bot.type === BOT_TYPES.BUDGET) {
      // Cap at 20% of CURRENT remaining budget
      const cap = budgetLeft * 0.20;
      maxBid = Math.min(baseBid, cap);
    } else if (bot.type === BOT_TYPES.HOMER) {
      if (player.team === bot.favoriteTeam) maxBid = baseBid * 1.3;
      else maxBid = baseBid;
    }
  }

  const maxLegal = Math.max(1, budgetLeft - (slotsLeft - 1));
  return Math.max(1, Math.min(maxLegal, Math.round(maxBid)));
}

function getBotNomination(bot, C, availablePool) {
  if (availablePool.length === 0) return null;

  const poolSortedByVal = [...availablePool].sort((a,b) => C.fairPrice(b.rk) - C.fairPrice(a.rk));
  const top10 = poolSortedByVal.slice(0, 10);

  if (bot.type === BOT_TYPES.OURS) {
    // Random from top 15
    const top15 = poolSortedByVal.slice(0, 15);
    return top15[Math.floor(Math.random() * top15.length)];
  } else if (bot.type === BOT_TYPES.STARS_SCRUBS) {
    return poolSortedByVal[0];
  } else if (bot.type === BOT_TYPES.BUDGET) {
    return poolSortedByVal[0];
  } else if (bot.type === BOT_TYPES.HOMER) {
    const homers = availablePool.filter(p => p.team === bot.favoriteTeam);
    if (homers.length > 0) {
      return homers[Math.floor(Math.random() * homers.length)];
    }
    return top10[Math.floor(Math.random() * top10.length)];
  } else {
    // Market bots pick random from top 10
    return top10[Math.floor(Math.random() * top10.length)];
  }
}

async function runSimulation(runIndex) {
  const state = {
    numTeams: 14,
    rosterSlots: 13,
    budget: 200,
    myTeamName: 'Alex',
    weights: Object.fromEntries(engine.CATS.map(c => [c, 1])),
    picks: [],
    starterSlots: 9,
    benchWeight: 0.3
  };

  let nominatorIdx = 0;
  let picksLog = [];

  const totalPicks = 14 * 13;
  let picksMade = 0;

  process.stdout.write(`Run ${runIndex + 1}/${runs} [`);

  while (state.picks.length < totalPicks) {
    const C = engine.computeAll(state, players);
    const nominator = TEAMS[nominatorIdx];

    const nominatorInfo = C.teamBudgetAndSlotsLeft(nominator.name);
    let nextIdx = (nominatorIdx + 1) % TEAMS.length;

    if (nominatorInfo.slotsLeft <= 0) {
      nominatorIdx = nextIdx;
      continue;
    }

    const nominatedPlayer = getBotNomination(nominator, C, C.availableInPool);
    if (!nominatedPlayer) break;

    let bids = [];
    for (const bot of TEAMS) {
      const { slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
      if (slotsLeft > 0) {
        let maxBid = getBotMaxBid(bot, nominatedPlayer, C, state);
        bids.push({ bot: bot.name, bid: maxBid });
      }
    }

    bids.sort((a, b) => b.bid - a.bid);

    let winner = bids[0];
    let winningPrice = 1;

    if (bids.length > 1) {
      if (bids[0].bid === bids[1].bid) {
        // Tie
        const tiedBots = bids.filter(b => b.bid === bids[0].bid);
        winner = tiedBots[Math.floor(Math.random() * tiedBots.length)];
        winningPrice = winner.bid;
      } else {
        winner = bids[0];
        winningPrice = Math.min(winner.bid, bids[1].bid + 1);
      }
    } else if (bids.length === 1) {
      winner = bids[0];
      winningPrice = 1;
    } else {
      // No one can afford/has space
      nominatorIdx = nextIdx;
      continue;
    }

    const winnerInfo = C.teamBudgetAndSlotsLeft(winner.bot);
    const winnerMaxLegal = Math.max(1, winnerInfo.budgetLeft - (winnerInfo.slotsLeft - 1));
    winningPrice = Math.max(1, Math.min(winningPrice, winnerMaxLegal));

    state.picks.push({
      rk: nominatedPlayer.rk,
      teamName: winner.bot,
      price: winningPrice,
      ts: Date.now()
    });
    picksMade++;

    if (picksMade % 18 === 0) process.stdout.write('.'); // Simple progress indicator

    picksLog.push(`${String(state.picks.length).padStart(3)}. ${nominatedPlayer.name.padEnd(25)} -> ${winner.bot.padEnd(12)} for $${winningPrice}`);
    nominatorIdx = nextIdx;
  }

  process.stdout.write('] Done\n');

  const finalC = engine.computeAll(state, players);
  return { finalC, state, picksLog };
}

(async () => {
  let ourTotalZ = 0;
  let ourTotalCats = {};
  engine.CATS.forEach(c => ourTotalCats[c] = 0);
  let ourWins = 0;
  let ourTotalUnspent = 0;

  let playerDraftCounts = {}; // { rk: count }
  let playerNames = {}; // { rk: name }

  let firstRunLog = [];

  const t0 = Date.now();

  for (let i = 0; i < runs; i++) {
    const { finalC, state, picksLog } = await runSimulation(i);
    
    if (i === 0) {
      firstRunLog = picksLog;
    }

    // Process result
    const ourRanks = finalC.powerRankings.find(r => r.teamName === 'Alex');
    const rankPos = finalC.powerRankings.findIndex(r => r.teamName === 'Alex') + 1;
    
    ourTotalZ += ourRanks.total; // The powerRankings total points
    if (rankPos === 1) ourWins++;
    ourTotalUnspent += ourRanks.budgetLeft;

    const ourPicks = state.picks.filter(p => p.teamName === 'Alex');
    let runCats = {};
    engine.CATS.forEach(c => runCats[c] = 0);

    for (const p of ourPicks) {
      const zc = finalC.zAll.get(p.rk);
      if (zc) {
        engine.CATS.forEach(c => { runCats[c] += zc[c]; });
      }

      playerDraftCounts[p.rk] = (playerDraftCounts[p.rk] || 0) + 1;
      const player = players.find(x => x.rk === p.rk);
      if (player) playerNames[p.rk] = player.name;
    }

    engine.CATS.forEach(c => { ourTotalCats[c] += runCats[c]; });
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nSimulation completed in ${elapsed}s.\n`);

  console.log("=========================================");
  console.log("          SIMULATION RESULTS             ");
  console.log("=========================================");
  console.log(`Runs: ${runs}`);
  console.log(`Win Rate: ${((ourWins / runs) * 100).toFixed(1)}% (${ourWins}/${runs})`);
  console.log(`Avg Final Power Points: ${(ourTotalZ / runs).toFixed(1)}`);
  console.log(`Avg Unspent Budget: $${(ourTotalUnspent / runs).toFixed(1)}\n`);

  console.log("--- Average Z-Scores by Category ---");
  engine.CATS.forEach(c => {
    console.log(`  ${c.padEnd(8)} : ${(ourTotalCats[c] / runs).toFixed(3)}`);
  });

  console.log("\n--- Top 20 Most Drafted Players by Us ---");
  const sortedPlayers = Object.keys(playerDraftCounts).map(rk => ({
    rk: parseInt(rk, 10),
    name: playerNames[rk],
    count: playerDraftCounts[rk]
  })).sort((a, b) => b.count - a.count);

  sortedPlayers.slice(0, 20).forEach((p, idx) => {
    console.log(`${String(idx + 1).padStart(2)}. ${p.name.padEnd(25)} : ${(p.count / runs * 100).toFixed(1)}%`);
  });

  console.log("\n=========================================");
  console.log("       SAMPLE RUN (Run #1) LOG         ");
  console.log("=========================================\n");
  console.log(firstRunLog.join('\n'));
})();
