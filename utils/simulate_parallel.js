const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const os = require('os');
const players = require('../players.js');
const engine = require('../engine.js');

if (isMainThread) {
  const args = process.argv.slice(2);
  let runs = 10;
  let mode = 'baseline';
  let numTeams = 15;
  let rosterSlots = 12;
  let starterSlots = 9;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--runs=')) runs = parseInt(arg.split('=')[1], 10);
    else if (arg === '--runs' && i + 1 < args.length) runs = parseInt(args[++i], 10);
    else if (arg.startsWith('--mode=')) mode = arg.split('=')[1];
    else if (arg === '--mode' && i + 1 < args.length) mode = args[++i];
    else if (arg.startsWith('--teams=')) numTeams = parseInt(arg.split('=')[1], 10);
    else if (arg === '--teams' && i + 1 < args.length) numTeams = parseInt(args[++i], 10);
    else if (arg.startsWith('--slots=')) rosterSlots = parseInt(arg.split('=')[1], 10);
    else if (arg === '--slots' && i + 1 < args.length) rosterSlots = parseInt(args[++i], 10);
    else if (arg.startsWith('--starters=')) starterSlots = parseInt(arg.split('=')[1], 10);
    else if (arg === '--starters' && i + 1 < args.length) starterSlots = parseInt(args[++i], 10);
  }

  const numCpus = Math.max(1, os.cpus().length - 1);
  const numWorkers = Math.min(runs, numCpus);
  
  console.log(`Starting Monte Carlo Simulation (${mode} mode, ${numTeams} teams, ${rosterSlots} slots [${starterSlots} starters]) with ${runs} runs across ${numWorkers} workers...`);
  
  let runsCompleted = 0;
  let ourWins = 0;
  let ourTotalZ = 0;
  let ourTotalUnspent = 0;
  
  let ourTotalCats = {};
  engine.CATS.forEach(c => ourTotalCats[c] = 0);
  
  let archetypeWins = {
    ours: 0,
    market: 0,
    stars_scrubs: 0,
    budget: 0,
    homer: 0,
    punt: 0,
    panic_spender: 0,
    price_enforcer: 0
  };
  let playerDraftCounts = {};
  let playerTotalROIs = {}; // { rk: total profit }
  
  let totalPos = { PG: 0, SG: 0, SF: 0, PF: 0, C: 0 };
  let totalPacing = { 50: 0, 100: 0, 150: 0 };
  
  let ourTotalCatRanks = {};
  engine.CATS.forEach(c => ourTotalCatRanks[c] = 0);
  let losses = [];
  let finishCounts = {};
  
  let firstRunLog = [];
  const t0 = Date.now();
  let workersActive = 0;
  let runsDispatched = 0;

  function dispatch(worker) {
    if (runsDispatched < runs) {
      worker.postMessage({ runIndex: runsDispatched, centerMode: mode, numTeams, rosterSlots, starterSlots });
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
      finishCounts[msg.ourFinishRank] = (finishCounts[msg.ourFinishRank] || 0) + 1;
      if (msg.lossDetail) losses.push(msg.lossDetail);
      
      engine.CATS.forEach(c => {
        ourTotalCats[c] += msg.ourCats[c];
        if (msg.ourCatRanks && msg.ourCatRanks[c]) {
          ourTotalCatRanks[c] += msg.ourCatRanks[c].rank;
        }
      });
      
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

        const playerMap = {};
        for(const p of players) playerMap[p.rk] = p;
        
        let report = `Monte Carlo Simulation Report (${runs} runs, Mode: ${mode}, ${numTeams} Teams, ${rosterSlots} Slots [${starterSlots} Starters])\n`;
        report += `=========================================\n`;
        report += `Overall Win Rates (by archetype):\n`;
        report += `  - Our Bot (The Edge): ${((archetypeWins['ours'] / runs) * 100).toFixed(1)}% (${ourWins}/${runs} wins)\n`;
        report += `  - Market Value Bots: ${(((archetypeWins['market'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['market'] || 0} wins)\n`;
        report += `  - Punt Strategy Bots: ${(((archetypeWins['punt'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['punt'] || 0} wins)\n`;
        report += `  - Price Enforcer Bots: ${(((archetypeWins['price_enforcer'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['price_enforcer'] || 0} wins)\n`;
        report += `  - Panic Spender Bots: ${(((archetypeWins['panic_spender'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['panic_spender'] || 0} wins)\n`;
        report += `  - Stars & Scrubs Bots: ${(((archetypeWins['stars_scrubs'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['stars_scrubs'] || 0} wins)\n`;
        report += `  - Strict Budget Bots: ${(((archetypeWins['budget'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['budget'] || 0} wins)\n`;
        report += `  - Homer Bots: ${(((archetypeWins['homer'] || 0) / runs) * 100).toFixed(1)}% (${archetypeWins['homer'] || 0} wins)\n\n`;

        report += `Finish Distribution:\n`;
        Object.keys(finishCounts).sort((a,b) => Number(a) - Number(b)).forEach(rk => {
          report += `  #${rk} Place: ${finishCounts[rk]} times (${(finishCounts[rk] / runs * 100).toFixed(1)}%)\n`;
        });
        report += `\nOur Average Final Power Points: ${(ourTotalZ / runs).toFixed(1)}\n`;
        report += `Our Average Unspent Budget: $${(ourTotalUnspent / runs).toFixed(1)}\n\n`;
        
        report += `--- Budget Pacing ---\n`;
        report += `  Budget remaining at Pick 50: $${(totalPacing[50] / runs).toFixed(1)}\n`;
        report += `  Budget remaining at Pick 100: $${(totalPacing[100] / runs).toFixed(1)}\n`;
        report += `  Budget remaining at Pick 150: $${(totalPacing[150] / runs).toFixed(1)}\n\n`;

        report += `--- Positional Breakdown ---\n`;
        report += `  PG: ${(totalPos.PG / runs).toFixed(1)}   SG: ${(totalPos.SG / runs).toFixed(1)}   SF: ${(totalPos.SF / runs).toFixed(1)}   PF: ${(totalPos.PF / runs).toFixed(1)}   C: ${(totalPos.C / runs).toFixed(1)}\n\n`;

        report += `--- Category Statistics (Avg Z-Score & Avg League Rank out of ${numTeams}) ---\n`;
        engine.CATS.forEach(c => {
          const avgZ = (ourTotalCats[c] / runs).toFixed(3);
          const avgRk = (ourTotalCatRanks[c] / runs).toFixed(2);
          report += `  ${c.padEnd(8)} : Z = ${avgZ.padStart(6)} | Avg League Rank: #${avgRk}\n`;
        });

        report += `\n--- Top 30 Most Drafted Players (with Pos, MktCost, & Avg Profit) ---\n`;
        const sortedPlayers = Object.keys(playerDraftCounts).map(rk => {
          const count = playerDraftCounts[rk];
          const avgProfit = playerTotalROIs[rk] / count;
          const pObj = playerMap[rk] || { name: 'Unknown', pos: [], mktCost: 1 };
          return { rk, name: pObj.name, pos: (pObj.pos || []).join(','), mktCost: pObj.mktCost || 1, count, avgProfit };
        }).sort((a, b) => b.count - a.count);

        sortedPlayers.slice(0, 30).forEach((p, idx) => {
          const sign = p.avgProfit > 0 ? '+' : '';
          report += `${String(idx + 1).padStart(2)}. ${p.name.padEnd(25)} (${p.pos.padEnd(8)} Mkt:$${String(p.mktCost).padStart(2)}) : ${(p.count / runs * 100).toFixed(1).padStart(5)}% (${String(p.count).padStart(3)}x) | Avg ROI: ${sign}$${p.avgProfit.toFixed(1)}\n`;
        });

        report += `\n=========================================\n`;
        report += `--- LOSS RECORDS (${losses.length} Total Losses out of ${runs} Runs) ---\n`;
        report += `=========================================\n`;
        losses.sort((a, b) => a.runIndex - b.runIndex).forEach((loss, idx) => {
          report += `\n[Loss #${idx + 1} - Run #${loss.runIndex + 1}]\n`;
          report += `  Winner: ${loss.winnerName} (${loss.winnerArchetype}${loss.winnerPuntDetail || ''}) with ${loss.winnerPoints} pts (Spent: $${loss.winnerSpent})\n`;
          report += `  Our Finish: #${loss.ourFinishRank} with ${loss.ourPoints} pts (Deficit: -${loss.winnerPoints - loss.ourPoints} pts, Spent: $${loss.ourSpent})\n`;
          report += `  Category Comparison (Our Rank vs Winner Rank):\n    `;
          report += engine.CATS.map(c => `${c}: #${loss.ourCatRanks[c].rank} vs #${loss.winnerCatRanks[c].rank}`).join(' | ') + `\n`;
          report += `  Winner Top Picks: ${loss.winnerPicks.slice(0, 6).map(p => `${p.name} ($${p.price}/Mkt$${p.mkt})`).join(', ')}\n`;
          report += `  Our Top Picks   : ${loss.ourPicks.slice(0, 6).map(p => `${p.name} ($${p.price}/Mkt$${p.mkt})`).join(', ')}\n`;
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

  function getBotMaxBid(bot, player, C, state, isNominator = false, initialC = null) {
    const { budgetLeft, slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
    if (slotsLeft <= 0) return 0;
    let maxBid = 0;
    if (bot.type === BOT_TYPES.OURS) {
      const cp = engine.checkPrice(state, players, player.rk);
      if (!cp || cp.full) return 0;
      maxBid = cp.maxBid;
      if (maxBid <= 0 && !isNominator) {
        return 0;
      }
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
      } else if (bot.type === BOT_TYPES.PUNT) {
        if (bot.anchorBought && bot.puntCats && bot.puntCats.length > 0) {
          const zc = (initialC && initialC.zAll) ? initialC.zAll.get(player.rk) : null;
          if (zc) {
            let totalZ = 0;
            let activeZ = 0;
            const activeCatsCount = engine.CATS.length - bot.puntCats.length;
            engine.CATS.forEach(c => {
              totalZ += zc[c];
              if (!bot.puntCats.includes(c)) {
                activeZ += zc[c];
              }
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
        const totalLeagueBudgetRemaining = state.numTeams * 200 - state.picks.reduce((sum, p) => sum + p.price, 0);
        const totalLeagueSlotsRemaining = Math.max(1, (state.numTeams * state.rosterSlots) - totalPicksMade);
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
    // Nominator opens at $1; non-nominators must be willing & able to bid at least $2 to outbid the opening $1 bid
    if (isNominator) return Math.max(1, rounded);
    return rounded >= 2 ? rounded : 0;
  }

  function getBotNomination(bot, C, availablePool, state, initialC = null) {
    if (availablePool.length === 0) return null;
    if (bot.randomNom) {
      // Nominate uniformly at random from the remaining top X (numTeams * rosterSlots) eligible pool
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
            // Early / Mid-draft: Strategic Bait Nomination
            // Nominate expensive players outside our build to bleed opponent capital (especially Price Enforcers)
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
      if (homers.length > 0) return homers[Math.floor(Math.random() * homers.length)];
      return top10[Math.floor(Math.random() * top10.length)];
    } else if (bot.type === BOT_TYPES.PRICE_ENFORCER) {
      return poolSortedByVal[0];
    } else if (bot.type === BOT_TYPES.PANIC_SPENDER) {
      const totalPicksMade = state ? state.picks.length : 0;
      if (totalPicksMade < 45) {
        return poolSortedByVal[0];
      }
      return top10[Math.floor(Math.random() * top10.length)];
    } else if (bot.type === BOT_TYPES.PUNT) {
      if (bot.anchorBought && bot.puntCats && bot.puntCats.length > 0 && initialC && initialC.zAll) {
        const top25 = poolSortedByVal.slice(0, 25);
        if (Math.random() < 0.5) {
          // Bait nomination: pick player in top 25 with highest contribution in bot.puntCats
          const baitCandidates = [...top25].sort((a, b) => {
            const zcA = initialC.zAll.get(a.rk) || {};
            const zcB = initialC.zAll.get(b.rk) || {};
            const puntScoreA = bot.puntCats.reduce((sum, c) => sum + (zcA[c] || 0), 0);
            const puntScoreB = bot.puntCats.reduce((sum, c) => sum + (zcB[c] || 0), 0);
            return puntScoreB - puntScoreA;
          });
          if (baitCandidates.length > 0) return baitCandidates[0];
        } else {
          // Target nomination: pick player in top 25 with highest active category score
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

  parentPort.on('message', (msg) => {
    if (msg === 'exit') process.exit(0);
    const runIndex = msg.runIndex;
    const numTeams = msg.numTeams || 15;
    const rosterSlots = msg.rosterSlots || 12;
    const starterSlots = msg.starterSlots !== undefined ? msg.starterSlots : Math.min(9, rosterSlots);
    
    const state = {
      numTeams, rosterSlots, budget: 200, myTeamName: 'Alex',
      weights: Object.fromEntries(engine.CATS.map(c => [c, 1])),
      picks: [], starterSlots, benchWeight: 0.3,
      centerMode: msg.centerMode || 'baseline',
      hillClimbConfig: msg.hillClimbConfig || {}
    };

    // Calculate baseline Z-scores and prices against the empty draft pool
    const initialC = engine.computeAll(state, players);
    
    // Randomize opponents for this run
    // Guaranteed slots: Slot 0 = Alex (OURS), Slot 1 = PUNT, Slot 2 = PRICE_ENFORCER
    const botTypes = [
      BOT_TYPES.MARKET,
      BOT_TYPES.STARS_SCRUBS,
      BOT_TYPES.BUDGET,
      BOT_TYPES.HOMER,
      BOT_TYPES.PUNT,
      BOT_TYPES.PANIC_SPENDER,
      BOT_TYPES.PRICE_ENFORCER
    ];
    const TEAMS = [ { name: 'Alex', type: BOT_TYPES.OURS } ];
    if (numTeams > 1) {
      TEAMS.push({ name: 'Bot1_punt', type: BOT_TYPES.PUNT, puntCats: [], anchorBought: false, picksCount: 0 });
    }
    if (numTeams > 2) {
      TEAMS.push({ name: 'Bot2_price_enforcer', type: BOT_TYPES.PRICE_ENFORCER });
    }
    const guaranteedRandomNomIdx = TEAMS.length < numTeams ? TEAMS.length + Math.floor(Math.random() * (numTeams - TEAMS.length)) : -1;
    for(let i = TEAMS.length; i < numTeams; i++) {
      const bType = botTypes[Math.floor(Math.random() * botTypes.length)];
      const randomNom = (i === guaranteedRandomNomIdx) || (Math.random() < 0.15);
      let t = { name: `Bot${i}_${bType}${randomNom ? '_rndNom' : ''}`, type: bType, randomNom };
      if (bType === BOT_TYPES.HOMER) {
        const teams = ['NYK', 'BOS', 'LAL', 'GSW', 'PHI'];
        t.favoriteTeam = teams[Math.floor(Math.random() * teams.length)];
      } else if (bType === BOT_TYPES.PUNT) {
        t.puntCats = [];
        t.anchorBought = false;
        t.picksCount = 0;
      }
      TEAMS.push(t);
    }

    let nominatorIdx = 0;
    let picksLog = [];
    const totalPicks = numTeams * rosterSlots;
    
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

      const nominatedPlayer = getBotNomination(nominator, C, C.availableInPool, state, initialC);
      if (!nominatedPlayer) break;

      let bids = [];
      for (const bot of TEAMS) {
        const { slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
        if (slotsLeft > 0) {
          const isNom = bot.name === nominator.name;
          const bVal = getBotMaxBid(bot, nominatedPlayer, C, state, isNom, initialC);
          if (bVal > 0) {
            bids.push({ bot: bot.name, bid: bVal });
          }
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

      const winnerInfo = C.teamBudgetAndSlotsLeft(winner.bot);
      const winnerMaxLegal = Math.max(1, winnerInfo.budgetLeft - (winnerInfo.slotsLeft - 1));
      winningPrice = Math.max(1, Math.min(winningPrice, winnerMaxLegal));

      state.picks.push({ rk: nominatedPlayer.rk, teamName: winner.bot, price: winningPrice, ts: Date.now() });

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

      if (runIndex === 0) picksLog.push(`${String(state.picks.length).padStart(3)}. ${nominatedPlayer.name.padEnd(25)} -> ${winner.bot.padEnd(15)} for $${winningPrice}`);
      nominatorIdx = nextIdx;
    }

    const finalC = engine.computeAll(state, players);
    
    const winnerRanks = finalC.powerRankings[0];
    let winningArchetype = 'unknown';
    let winnerPuntDetail = '';
    if (winnerRanks.teamName === 'Alex') {
      winningArchetype = 'ours';
    } else {
      const wBot = TEAMS.find(t => t.name === winnerRanks.teamName);
      winningArchetype = wBot ? wBot.type : 'unknown';
      if (wBot && wBot.type === BOT_TYPES.PUNT && wBot.puntCats && wBot.puntCats.length > 0) {
        winnerPuntDetail = ` [Punt: ${wBot.puntCats.join(', ')}]`;
      }
    }

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

    const ourFinishRank = finalC.powerRankings.findIndex(r => r.teamName === 'Alex') + 1;
    let lossDetail = null;
    if (ourFinishRank > 1) {
      const wPicks = state.picks.filter(p => p.teamName === winnerRanks.teamName).map(p => {
        const pl = players.find(x => x.rk === p.rk) || { name: 'Unknown', mktCost: 1 };
        return { name: pl.name, price: p.price, mkt: pl.mktCost || 1 };
      }).sort((a,b) => b.price - a.price);
      const oPicks = ourPicks.map(p => {
        const pl = players.find(x => x.rk === p.rk) || { name: 'Unknown', mktCost: 1 };
        return { name: pl.name, price: p.price, mkt: pl.mktCost || 1 };
      }).sort((a,b) => b.price - a.price);
      lossDetail = {
        runIndex,
        ourFinishRank,
        ourPoints: ourRanks.total,
        ourSpent: 200 - ourRanks.budgetLeft,
        ourCatRanks: ourRanks.catRanks,
        ourPicks: oPicks,
        winnerName: winnerRanks.teamName,
        winnerArchetype: winningArchetype,
        winnerPuntDetail: winnerPuntDetail,
        winnerPoints: winnerRanks.total,
        winnerSpent: 200 - winnerRanks.budgetLeft,
        winnerCatRanks: winnerRanks.catRanks,
        winnerPicks: wPicks
      };
    }

    parentPort.postMessage({
      runIndex,
      winningArchetype,
      ourFinishRank,
      ourZ: ourRanks.total,
      ourUnspent: ourRanks.budgetLeft,
      ourCats: runCats,
      ourCatRanks: ourRanks.catRanks,
      lossDetail,
      playerDraftCounts,
      playerROIs,
      posCounts,
      pacing,
      picksLog: runIndex === 0 ? picksLog : []
    });
  });
}
