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
  HOMER: 'homer',
  PUNT: 'punt',
  PANIC_SPENDER: 'panic_spender',
  PRICE_ENFORCER: 'price_enforcer'
};

const TEAMS = [
  { name: 'Alex', type: BOT_TYPES.OURS },
  { name: 'Punt1', type: BOT_TYPES.PUNT, puntCats: [], anchorBought: false, picksCount: 0 },
  { name: 'Enforcer1', type: BOT_TYPES.PRICE_ENFORCER },
  { name: 'Market1', type: BOT_TYPES.MARKET },
  { name: 'Market2', type: BOT_TYPES.MARKET },
  { name: 'Market3', type: BOT_TYPES.MARKET },
  { name: 'Market4_rndNom', type: BOT_TYPES.MARKET, randomNom: true },
  { name: 'Panic1', type: BOT_TYPES.PANIC_SPENDER },
  { name: 'SnS1', type: BOT_TYPES.STARS_SCRUBS },
  { name: 'Budget1', type: BOT_TYPES.BUDGET },
  { name: 'Budget2', type: BOT_TYPES.BUDGET },
  { name: 'HomerNYK', type: BOT_TYPES.HOMER, favoriteTeam: 'NYK' },
  { name: 'HomerBOS', type: BOT_TYPES.HOMER, favoriteTeam: 'BOS' },
  { name: 'HomerLAL', type: BOT_TYPES.HOMER, favoriteTeam: 'LAL' },
];

function getBotMaxBid(bot, player, C, state, isNominator = false, initialC = null) {
  const { budgetLeft, slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
  if (slotsLeft <= 0) return 0;

  let maxBid = 0;

  if (bot.type === BOT_TYPES.OURS) {
    const cp = engine.checkPrice(state, players, player.rk);
    if (!cp || cp.full) return 0;
    maxBid = cp.maxBid;
    if (maxBid <= 0 && !isNominator) return 0;
  } else {
    // Fair price includes inflation dynamically updated based on remaining money vs pool
    const fairPrice = C.fairPrice(player.rk);

    // Fuzzy factor between 0.9 and 1.1 (+/- 10%)
    const fuzzy = 0.9 + Math.random() * 0.2;
    const baseBid = fairPrice * fuzzy;

    if (bot.type === BOT_TYPES.MARKET) {
      maxBid = baseBid;
    } else if (bot.type === BOT_TYPES.STARS_SCRUBS) {
      if ((player.mktCost || 0) >= 30) maxBid = baseBid * 1.3;
      else maxBid = 1;
    } else if (bot.type === BOT_TYPES.BUDGET) {
      maxBid = Math.min(baseBid, budgetLeft * 0.20);
    } else if (bot.type === BOT_TYPES.HOMER) {
      if (player.team === bot.favoriteTeam) maxBid = baseBid * 1.3;
      else maxBid = baseBid;
    } else if (bot.type === BOT_TYPES.PUNT) {
      if (bot.anchorBought && bot.puntCats && bot.puntCats.length > 0) {
        const zc = (initialC && initialC.zAll) ? initialC.zAll.get(player.rk) : null;
        if (zc) {
          let totalZ = 0;
          let activeZ = 0;
          const activeCatsCount = engine.CATS.length - bot.puntCats.length;
          engine.CATS.forEach(c => {
            totalZ += zc[c];
            if (!bot.puntCats.includes(c)) activeZ += zc[c];
          });
          const meanTotal = totalZ / engine.CATS.length;
          const meanActive = activeZ / activeCatsCount;
          let puntRatio = 1.0;
          if (meanTotal > 0.05) {
            puntRatio = meanActive / meanTotal;
          } else {
            puntRatio = 1.0 + (meanActive - meanTotal) * 0.3;
          }
          puntRatio = Math.max(0.5, Math.min(1.4, puntRatio));
          maxBid = baseBid * puntRatio;
        } else {
          maxBid = baseBid;
        }
      } else {
        maxBid = baseBid;
      }
    } else if (bot.type === BOT_TYPES.PANIC_SPENDER) {
      const totalPicksMade = state.picks.length;
      const totalLeagueBudgetRemaining = 14 * 200 - state.picks.reduce((sum, p) => sum + p.price, 0);
      const totalLeagueSlotsRemaining = Math.max(1, (14 * 13) - totalPicksMade);
      const leaguePace = totalLeagueBudgetRemaining / totalLeagueSlotsRemaining;
      const myPace = budgetLeft / slotsLeft;

      if (totalPicksMade < 45 && myPace <= leaguePace * 1.15) {
        maxBid = baseBid * 0.78;
      } else {
        const urgency = Math.max(1.20, Math.min(1.40, 1.0 + 0.35 * (myPace / Math.max(1, leaguePace))));
        maxBid = baseBid * urgency;
      }
    } else if (bot.type === BOT_TYPES.PRICE_ENFORCER) {
      if (slotsLeft <= 4 || budgetLeft < slotsLeft * 3) {
        maxBid = baseBid;
      } else {
        if ((player.mktCost || 0) >= 10 || player.rk <= 60) {
          const enforcerFuzzy = 0.92 + Math.random() * 0.05;
          const enforcerBid = fairPrice * enforcerFuzzy;
          maxBid = Math.max(baseBid, enforcerBid);
        } else {
          maxBid = baseBid;
        }
      }
    }
  }

  const maxLegal = Math.max(1, budgetLeft - (slotsLeft - 1));
  const rounded = Math.min(maxLegal, Math.round(maxBid));
  if (isNominator) return Math.max(1, rounded);
  return rounded >= 2 ? rounded : 0;
}

function getBotNomination(bot, C, availablePool, state, initialC = null) {
  if (availablePool.length === 0) return null;
  if (bot.randomNom) {
    return availablePool[Math.floor(Math.random() * availablePool.length)];
  }

  const poolSortedByVal = [...availablePool].sort((a,b) => C.fairPrice(b.rk) - C.fairPrice(a.rk));
  const top10 = poolSortedByVal.slice(0, 10);

  if (bot.type === BOT_TYPES.OURS) {
    if (state) {
      const myInfo = C.teamBudgetAndSlotsLeft(bot.name);
      const opt = engine.runOptimizer(state, players);
      if (opt && !opt.full && !opt.infeasible) {
        if (myInfo.slotsLeft <= 5) {
          if (opt.isMonopoly && opt.dreamPlayers && opt.dreamPlayers.length > 0) {
            const dreamTarget = availablePool.find(p => p.rk === opt.dreamPlayers[0].rk);
            if (dreamTarget) return dreamTarget;
          }
          if (myInfo.budgetLeft <= myInfo.slotsLeft && opt.players && opt.players.length > 0) {
            const dollarTarget = opt.players.find(c => C.fairPrice(c.rk) <= 1) || opt.players[0];
            const targetObj = availablePool.find(p => p.rk === dollarTarget.rk);
            if (targetObj) return targetObj;
          }
        } else {
          const baits = opt.baitPlayers || opt.topBaitPlayers;
          if (baits && baits.length > 0 && Math.random() < 0.65) {
            const baitTarget = availablePool.find(p => p.rk === baits[0].rk);
            if (baitTarget) return baitTarget;
          }
        }
      }
    }
    const top15 = poolSortedByVal.slice(0, 15);
    return top15[Math.floor(Math.random() * top15.length)];
  } else if (bot.type === BOT_TYPES.STARS_SCRUBS || bot.type === BOT_TYPES.BUDGET) {
    return poolSortedByVal[0];
  } else if (bot.type === BOT_TYPES.HOMER) {
    const homers = availablePool.filter(p => p.team === bot.favoriteTeam);
    if (homers.length > 0) {
      return homers[Math.floor(Math.random() * homers.length)];
    }
    return top10[Math.floor(Math.random() * top10.length)];
  } else if (bot.type === BOT_TYPES.PRICE_ENFORCER) {
    return poolSortedByVal[0];
  } else if (bot.type === BOT_TYPES.PANIC_SPENDER) {
    const totalPicksMade = state ? state.picks.length : 0;
    if (totalPicksMade < 45) return poolSortedByVal[0];
    return top10[Math.floor(Math.random() * top10.length)];
  } else if (bot.type === BOT_TYPES.PUNT) {
    if (bot.anchorBought && bot.puntCats && bot.puntCats.length > 0 && initialC && initialC.zAll) {
      const top25 = poolSortedByVal.slice(0, 25);
      if (Math.random() < 0.5) {
        const baitCandidates = [...top25].sort((a, b) => {
          const zcA = initialC.zAll.get(a.rk) || {};
          const zcB = initialC.zAll.get(b.rk) || {};
          const puntScoreA = bot.puntCats.reduce((sum, c) => sum + (zcA[c] || 0), 0);
          const puntScoreB = bot.puntCats.reduce((sum, c) => sum + (zcB[c] || 0), 0);
          return puntScoreB - puntScoreA;
        });
        if (baitCandidates.length > 0) return baitCandidates[0];
      } else {
        const targetCandidates = [...top25].sort((a, b) => {
          const zcA = initialC.zAll.get(a.rk) || {};
          const zcB = initialC.zAll.get(b.rk) || {};
          const activeCats = engine.CATS.filter(c => !bot.puntCats.includes(c));
          const activeScoreA = activeCats.reduce((sum, c) => sum + (zcA[c] || 0), 0);
          const activeScoreB = activeCats.reduce((sum, c) => sum + (zcB[c] || 0), 0);
          return activeScoreB - activeScoreA;
        });
        if (targetCandidates.length > 0) return targetCandidates[0];
      }
    }
    return top10[Math.floor(Math.random() * top10.length)];
  } else {
    return top10[Math.floor(Math.random() * top10.length)];
  }
}

async function runSimulation(runIndex) {
  // Reset punt bots for this run
  TEAMS.forEach(t => {
    if (t.type === BOT_TYPES.PUNT) {
      t.puntCats = [];
      t.anchorBought = false;
      t.picksCount = 0;
    }
  });

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

  const initialC = engine.computeAll(state, players);

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

    const nominatedPlayer = getBotNomination(nominator, C, C.availableInPool, state, initialC);
    if (!nominatedPlayer) break;

    let bids = [];
    for (const bot of TEAMS) {
      const { slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
      if (slotsLeft > 0) {
        const isNom = bot.name === nominator.name;
        let maxBid = getBotMaxBid(bot, nominatedPlayer, C, state, isNom, initialC);
        if (maxBid > 0) {
          bids.push({ bot: bot.name, bid: maxBid });
        }
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

    const winningBotObj = TEAMS.find(t => t.name === winner.bot);
    if (winningBotObj && winningBotObj.type === BOT_TYPES.PUNT) {
      winningBotObj.picksCount = (winningBotObj.picksCount || 0) + 1;
      if (!winningBotObj.anchorBought && (winningPrice >= 20 || winningBotObj.picksCount >= 3)) {
        const zc = initialC.zAll.get(nominatedPlayer.rk);
        if (zc) {
          const sortedCats = [...engine.CATS].sort((a, b) => (zc[a] || 0) - (zc[b] || 0));
          winningBotObj.puntCats = [sortedCats[0]];
          if ((zc[sortedCats[1]] || 0) < -1.0) {
            winningBotObj.puntCats.push(sortedCats[1]);
          }
          winningBotObj.anchorBought = true;
        }
      }
    }

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
