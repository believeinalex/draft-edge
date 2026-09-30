const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const os = require('os');
const players = require('../players.js');
const engine = require('../engine.js');

if (isMainThread) {
  const args = process.argv.slice(2);
  let runs = 10;
  for (const arg of args) {
    if (arg.startsWith('--runs=')) {
      runs = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--runs') {
      const idx = process.argv.indexOf('--runs');
      if (idx + 1 < process.argv.length) runs = parseInt(process.argv[idx + 1], 10);
    }
  }

  const numCpus = Math.max(1, os.cpus().length - 1);
  const numWorkers = Math.min(runs, numCpus);
  
  console.log(`Starting Monte Carlo Simulation with ${runs} runs across ${numWorkers} workers...`);
  
  let runsCompleted = 0;
  let ourWins = 0;
  let ourTotalZ = 0;
  let ourTotalUnspent = 0;
  
  let ourTotalCats = {};
  engine.CATS.forEach(c => ourTotalCats[c] = 0);
  
  let archetypeWins = { ours: 0, market: 0, stars_scrubs: 0, budget: 0, homer: 0 };
  let playerDraftCounts = {};
  let playerTotalROIs = {}; // { rk: total profit }
  
  let totalPos = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
  let totalPacing = { 50: 0, 100: 0, 150: 0 };
  
  let firstRunLog = [];
  const t0 = Date.now();
  let workersActive = 0;
  let runsDispatched = 0;

  function dispatch(worker) {
    if (runsDispatched < runs) {
      worker.postMessage({ runIndex: runsDispatched });
      runsDispatched++;
    } else {
      worker.postMessage('exit');
    }
  }

  for (let i = 0; i < numWorkers; i++) {
    workersActive++;
    const worker = new Worker(__filename);
    
    worker.on('message', (msg) => {
      runsCompleted++;
      
      ourTotalZ += msg.ourZ;
      ourTotalUnspent += msg.ourUnspent;
      archetypeWins[msg.winningArchetype]++;
      if (msg.winningArchetype === 'ours') ourWins++;
      
      engine.CATS.forEach(c => { ourTotalCats[c] += msg.ourCats[c]; });
      
      for (const rk in msg.playerDraftCounts) {
        playerDraftCounts[rk] = (playerDraftCounts[rk] || 0) + msg.playerDraftCounts[rk];
        playerTotalROIs[rk] = (playerTotalROIs[rk] || 0) + msg.playerROIs[rk];
      }
      
      for (const pos in msg.posCounts) totalPos[pos] += msg.posCounts[pos];
      for (const pick in msg.pacing) totalPacing[pick] += msg.pacing[pick];
      
      if (msg.runIndex === 0) firstRunLog = msg.picksLog;
      
      process.stdout.write(`\rProgress: ${runsCompleted}/${runs} runs completed...`);
      dispatch(worker);
    });
    
    worker.on('exit', () => {
      workersActive--;
      if (workersActive === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n\nSimulation completed in ${elapsed}s.\n`);

        const playerNames = {};
        for(const p of players) playerNames[p.rk] = p.name;
        
        let report = `Monte Carlo Simulation Report (${runs} runs)\n`;
        report += `=========================================\n`;
        report += `Overall Win Rates (by archetype):\n`;
        report += `  - Our Bot (The Edge): ${((archetypeWins['ours'] / runs) * 100).toFixed(1)}%\n`;
        report += `  - Market Value Bots: ${((archetypeWins['market'] / runs) * 100).toFixed(1)}%\n`;
        report += `  - Stars & Scrubs Bots: ${((archetypeWins['stars_scrubs'] / runs) * 100).toFixed(1)}%\n`;
        report += `  - Strict Budget Bots: ${((archetypeWins['budget'] / runs) * 100).toFixed(1)}%\n`;
        report += `  - Homer Bots: ${((archetypeWins['homer'] / runs) * 100).toFixed(1)}%\n\n`;

        report += `Our Average Final Power Points: ${(ourTotalZ / runs).toFixed(1)}\n`;
        report += `Our Average Unspent Budget: $${(ourTotalUnspent / runs).toFixed(1)}\n\n`;
        
        report += `--- Budget Pacing ---\n`;
        report += `  Budget remaining at Pick 50: $${(totalPacing[50] / runs).toFixed(1)}\n`;
        report += `  Budget remaining at Pick 100: $${(totalPacing[100] / runs).toFixed(1)}\n`;
        report += `  Budget remaining at Pick 150: $${(totalPacing[150] / runs).toFixed(1)}\n\n`;

        report += `--- Positional Breakdown ---\n`;
        report += `  PG: ${(totalPos.PG / runs).toFixed(1)}   SG: ${(totalPos.SG / runs).toFixed(1)}   SF: ${(totalPos.SF / runs).toFixed(1)}   PF: ${(totalPos.PF / runs).toFixed(1)}   C: ${(totalPos.C / runs).toFixed(1)}\n\n`;

        report += `--- Average Z-Scores by Category (Baseline Initial) ---\n`;
        engine.CATS.forEach(c => { report += `  ${c.padEnd(8)} : ${(ourTotalCats[c] / runs).toFixed(3)}\n`; });

        report += `\n--- Top 20 Most Drafted Players (with Avg Profit) ---\n`;
        const sortedPlayers = Object.keys(playerDraftCounts).map(rk => {
          const count = playerDraftCounts[rk];
          const avgProfit = playerTotalROIs[rk] / count;
          return { rk, name: playerNames[rk], count, avgProfit };
        }).sort((a, b) => b.count - a.count);

        sortedPlayers.slice(0, 20).forEach((p, idx) => {
          const sign = p.avgProfit > 0 ? '+' : '';
          report += `${String(idx + 1).padStart(2)}. ${p.name.padEnd(25)} : ${(p.count / runs * 100).toFixed(1)}% | Avg ROI: ${sign}$${p.avgProfit.toFixed(1)}\n`;
        });
        
        console.log(report);
        fs.writeFileSync(path.join(__dirname, `report_${runs}.txt`), report);
        console.log(`\nReport saved to utils/report_${runs}.txt`);
      }
    });
    
    dispatch(worker);
  }

} else {
  // Worker Thread
  const BOT_TYPES = { OURS: 'ours', MARKET: 'market', STARS_SCRUBS: 'stars_scrubs', BUDGET: 'budget', HOMER: 'homer' };

  function getBotMaxBid(bot, player, C, state) {
    const { budgetLeft, slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
    if (slotsLeft <= 0) return 0;
    let maxBid = 0;
    if (bot.type === BOT_TYPES.OURS) {
      const cp = engine.checkPrice(state, players, player.rk);
      if (!cp || cp.full) return 0;
      maxBid = cp.maxBid;
    } else {
      const fairPrice = C.fairPrice(player.rk);
      const fuzzy = 0.9 + Math.random() * 0.2;
      const baseBid = fairPrice * fuzzy;
      if (bot.type === BOT_TYPES.MARKET) maxBid = baseBid;
      else if (bot.type === BOT_TYPES.STARS_SCRUBS) {
        if ((player.mktCost || 0) >= 30) maxBid = baseBid * 1.3;
        else maxBid = 1;
      } else if (bot.type === BOT_TYPES.BUDGET) {
        maxBid = Math.min(baseBid, budgetLeft * 0.20);
      } else if (bot.type === BOT_TYPES.HOMER) {
        if (player.team === bot.favoriteTeam) maxBid = baseBid * 1.3;
        else maxBid = baseBid;
      }
    }
    return Math.max(1, Math.min(budgetLeft, Math.round(maxBid)));
  }

  function getBotNomination(bot, C, availablePool) {
    if (availablePool.length === 0) return null;
    const poolSortedByVal = [...availablePool].sort((a,b) => C.fairPrice(b.rk) - C.fairPrice(a.rk));
    const top10 = poolSortedByVal.slice(0, 10);
    if (bot.type === BOT_TYPES.OURS) {
      const top15 = poolSortedByVal.slice(0, 15);
      return top15[Math.floor(Math.random() * top15.length)];
    } else if (bot.type === BOT_TYPES.STARS_SCRUBS || bot.type === BOT_TYPES.BUDGET) {
      return poolSortedByVal[0];
    } else if (bot.type === BOT_TYPES.HOMER) {
      const homers = availablePool.filter(p => p.team === bot.favoriteTeam);
      if (homers.length > 0) return homers[Math.floor(Math.random() * homers.length)];
      return top10[Math.floor(Math.random() * top10.length)];
    } else {
      return top10[Math.floor(Math.random() * top10.length)];
    }
  }

  parentPort.on('message', (msg) => {
    if (msg === 'exit') process.exit(0);
    const runIndex = msg.runIndex;
    
    const state = {
      numTeams: 14, rosterSlots: 13, budget: 200, myTeamName: 'Alex',
      weights: Object.fromEntries(engine.CATS.map(c => [c, 1])),
      picks: [], starterSlots: 9, benchWeight: 0.3
    };

    // Calculate baseline Z-scores and prices against the empty draft pool
    const initialC = engine.computeAll(state, players);
    
    // Randomize opponents for this run
    const botTypes = [BOT_TYPES.MARKET, BOT_TYPES.STARS_SCRUBS, BOT_TYPES.BUDGET, BOT_TYPES.HOMER];
    const TEAMS = [ { name: 'Alex', type: BOT_TYPES.OURS } ];
    for(let i = 1; i <= 13; i++) {
      const bType = botTypes[Math.floor(Math.random() * botTypes.length)];
      let t = { name: `Bot${i}_${bType}`, type: bType };
      if (bType === BOT_TYPES.HOMER) {
         const teams = ['NYK', 'BOS', 'LAL', 'GSW', 'PHI'];
         t.favoriteTeam = teams[Math.floor(Math.random() * teams.length)];
      }
      TEAMS.push(t);
    }

    let nominatorIdx = 0;
    let picksLog = [];
    const totalPicks = 14 * 13;
    
    let pacing = { 50: 0, 100: 0, 150: 0 };

    while (state.picks.length < totalPicks) {
      if (state.picks.length === 50) pacing[50] = engine.computeAll(state, players).teamBudgetAndSlotsLeft('Alex').budgetLeft;
      if (state.picks.length === 100) pacing[100] = engine.computeAll(state, players).teamBudgetAndSlotsLeft('Alex').budgetLeft;
      if (state.picks.length === 150) pacing[150] = engine.computeAll(state, players).teamBudgetAndSlotsLeft('Alex').budgetLeft;

      const C = engine.computeAll(state, players);
      const nominator = TEAMS[nominatorIdx];
      const nominatorInfo = C.teamBudgetAndSlotsLeft(nominator.name);
      let nextIdx = (nominatorIdx + 1) % TEAMS.length;

      if (nominatorInfo.slotsLeft <= 0) { nominatorIdx = nextIdx; continue; }

      const nominatedPlayer = getBotNomination(nominator, C, C.availableInPool);
      if (!nominatedPlayer) break;

      let bids = [];
      for (const bot of TEAMS) {
        const { slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
        if (slotsLeft > 0) {
          bids.push({ bot: bot.name, bid: getBotMaxBid(bot, nominatedPlayer, C, state) });
        }
      }
      bids.sort((a, b) => b.bid - a.bid);

      let winner = bids[0];
      let winningPrice = 1;
      if (bids.length > 1) {
        if (bids[0].bid === bids[1].bid) {
          const tiedBots = bids.filter(b => b.bid === bids[0].bid);
          winner = tiedBots[Math.floor(Math.random() * tiedBots.length)];
          winningPrice = winner.bid;
        } else {
          winner = bids[0];
          winningPrice = Math.min(winner.bid, bids[1].bid + 1);
        }
      } else if (bids.length === 1) {
        winner = bids[0]; winningPrice = 1;
      } else {
        nominatorIdx = nextIdx; continue;
      }

      state.picks.push({ rk: nominatedPlayer.rk, teamName: winner.bot, price: winningPrice, ts: Date.now() });
      if (runIndex === 0) picksLog.push(`${String(state.picks.length).padStart(3)}. ${nominatedPlayer.name.padEnd(25)} -> ${winner.bot.padEnd(15)} for $${winningPrice}`);
      nominatorIdx = nextIdx;
    }

    const finalC = engine.computeAll(state, players);
    
    const winnerRanks = finalC.powerRankings[0];
    let winningArchetype = 'unknown';
    if (winnerRanks.teamName === 'Alex') winningArchetype = 'ours';
    else winningArchetype = TEAMS.find(t => t.name === winnerRanks.teamName).type;

    const ourRanks = finalC.powerRankings.find(r => r.teamName === 'Alex');
    
    let runCats = {};
    engine.CATS.forEach(c => runCats[c] = 0);
    let playerDraftCounts = {};
    let playerROIs = {};
    let posCounts = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
    
    const ourPicks = state.picks.filter(p => p.teamName === 'Alex');
    for (const p of ourPicks) {
      // Use baseline Z-scores from the empty pool!
      const zc = initialC.zAll.get(p.rk);
      if (zc) engine.CATS.forEach(c => { runCats[c] += zc[c]; });
      
      playerDraftCounts[p.rk] = 1;
      
      // Calculate ROI: initial Fair Price vs what we actually paid
      const fairP = initialC.fairPrice(p.rk);
      playerROIs[p.rk] = fairP - p.price;
      
      const playerObj = players.find(x => x.rk === p.rk);
      if (playerObj && playerObj.pos) {
        // A player might have multiple positions, count all of them that match CORE_POS
        engine.CORE_POS.forEach(pos => {
          if (playerObj.pos.includes(pos)) posCounts[pos]++;
        });
      }
    }

    parentPort.postMessage({
      runIndex,
      winningArchetype,
      ourZ: ourRanks.total,
      ourUnspent: ourRanks.budgetLeft,
      ourCats: runCats,
      playerDraftCounts,
      playerROIs,
      posCounts,
      pacing,
      picksLog: runIndex === 0 ? picksLog : []
    });
  });
}
