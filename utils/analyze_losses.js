const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const os = require('os');
const players = require('../players.js');
const engine = require('../engine.js');

const championConfig = {
  centerMode: 'hybrid',
  alpha: 0.12,
  wMin: 0.70,
  wMax: 1.50,
  targetPerPick: 0.10,
  ftGuardrail: 1.35,
  useMaxOppBid: true
};

if (isMainThread) {
  const runs = 25;
  const numCpus = Math.max(1, os.cpus().length - 1);
  const numWorkers = Math.min(runs, numCpus);

  console.log(`Running Loss Analysis across ${runs} drafts using 15 workers...\n`);

  let runsCompleted = 0;
  let losses = [];
  let wins = 0;
  let runsDispatched = 0;
  let workersActive = 0;

  function dispatch(worker) {
    if (runsDispatched < runs) {
      worker.postMessage({ runIndex: runsDispatched, config: championConfig });
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
      if (msg.winner.name === 'Alex') {
        wins++;
      } else {
        losses.push(msg);
      }
      process.stdout.write(`\rProgress: ${runsCompleted}/${runs} completed (${losses.length} losses found)...`);
      dispatch(worker);
    });

    worker.on('exit', () => {
      workersActive--;
      if (workersActive === 0) {
        console.log(`\n\nCompleted! Found ${losses.length} losses out of ${runs} drafts (${((wins / runs) * 100).toFixed(1)}% win rate).\n`);
        fs.writeFileSync(path.join(__dirname, 'loss_analysis_data.json'), JSON.stringify(losses, null, 2));

        console.log("================================================================================");
        console.log("                            DETAILED LOSS BREAKDOWN                             ");
        console.log("================================================================================\n");

        losses.forEach((loss, idx) => {
          console.log(`--------------------------------------------------------------------------------`);
          console.log(`LOSS #${idx + 1} (Draft Run #${loss.runIndex + 1})`);
          console.log(`--------------------------------------------------------------------------------`);
          console.log(`Winner: ${loss.winner.name} (${loss.winner.type}) with ${loss.winner.total} pts`);
          console.log(`Our Finish: #${loss.ourRank} with ${loss.ourTotal} pts (Deficit: -${loss.winner.total - loss.ourTotal} pts)`);
          console.log(`Our Budget Left: $${loss.ourBudgetLeft} | Winner Budget Left: $${loss.winner.budgetLeft}\n`);

          console.log(`Category Ranks (1 = Best in League, 14 = Worst):`);
          console.log(`Category | Our Rank (Tier) | Winner Rank (Tier) | Our Z   | Winner Z`);
          console.log(`-----------------------------------------------------------------`);
          engine.CATS.forEach(c => {
            const ourCR = loss.ourCatRanks[c];
            const winCR = loss.winnerCatRanks[c];
            const ourZ = loss.ourZ[c] ? loss.ourZ[c].toFixed(2) : 'N/A';
            const winZ = loss.winnerZ[c] ? loss.winnerZ[c].toFixed(2) : 'N/A';
            console.log(`${c.padEnd(8)} | #${String(ourCR.rank).padStart(2)} (${ourCR.tier.padEnd(4)})     | #${String(winCR.rank).padStart(2)} (${winCR.tier.padEnd(4)})       | ${ourZ.padStart(6)} | ${winZ.padStart(7)}`);
          });

          console.log(`\nWinning Team Roster (${loss.winner.picks.length} players, spent $${loss.winner.spent}):`);
          loss.winner.picks.forEach(p => {
            console.log(`  - ${p.name.padEnd(25)} (${p.pos.padEnd(10)}) Paid: $${String(p.price).padStart(2)} (Mkt: $${p.mktCost || 1})`);
          });

          console.log(`\nOur Team Roster (${loss.ourPicks.length} players, spent $${loss.ourSpent}):`);
          loss.ourPicks.forEach(p => {
            console.log(`  - ${p.name.padEnd(25)} (${p.pos.padEnd(10)}) Paid: $${String(p.price).padStart(2)} (Mkt: $${p.mktCost || 1})`);
          });
          console.log(`\n`);
        });
      }
    });

    dispatch(worker);
  }
} else {
  // Worker Thread
  const BOT_TYPES = { OURS: 'ours', MARKET: 'market', STARS_SCRUBS: 'stars_scrubs', BUDGET: 'budget', HOMER: 'homer' };

  parentPort.on('message', (msg) => {
    if (msg === 'exit') process.exit(0);
    const { runIndex, config } = msg;

    const state = {
      numTeams: 14,
      rosterSlots: 13,
      budget: 200,
      myTeamName: 'Alex',
      weights: Object.fromEntries(engine.CATS.map(c => [c, 1])),
      picks: [],
      starterSlots: 9,
      benchWeight: 0.3,
      centerMode: config.centerMode || 'hybrid',
      hillClimbConfig: config
    };

    const botTypes = [BOT_TYPES.MARKET, BOT_TYPES.STARS_SCRUBS, BOT_TYPES.BUDGET, BOT_TYPES.HOMER];
    const TEAMS = [{ name: 'Alex', type: BOT_TYPES.OURS }];
    const guaranteedRandomNomIdx = 1 + Math.floor(Math.random() * 13);
    for (let i = 1; i <= 13; i++) {
      const bType = botTypes[Math.floor(Math.random() * botTypes.length)];
      const randomNom = (i === guaranteedRandomNomIdx) || (Math.random() < 0.15);
      let t = { name: `Bot${i}_${bType}${randomNom ? '_rndNom' : ''}`, type: bType, randomNom };
      if (bType === BOT_TYPES.HOMER) {
        const teams = ['NYK', 'BOS', 'LAL', 'GSW', 'PHI'];
        t.favoriteTeam = teams[Math.floor(Math.random() * teams.length)];
      }
      TEAMS.push(t);
    }

    function getBotMaxBid(bot, player, C, isNominator = false) {
      const { budgetLeft, slotsLeft } = C.teamBudgetAndSlotsLeft(bot.name);
      if (slotsLeft <= 0) return 0;
      let maxBid = 0;
      if (bot.type === BOT_TYPES.OURS) {
        const cp = engine.checkPrice(state, players, player.rk);
        if (!cp || cp.full) return 0;
        maxBid = cp.maxBid;
        if (maxBid <= 0 && !isNominator) return 0;
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
      const maxLegal = Math.max(1, budgetLeft - (slotsLeft - 1));
      return Math.max(1, Math.min(maxLegal, Math.round(maxBid)));
    }

    function getBotNomination(bot, C, availablePool) {
      if (availablePool.length === 0) return null;
      if (bot.randomNom) {
        return availablePool[Math.floor(Math.random() * availablePool.length)];
      }
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

    let nominatorIdx = 0;
    const totalPicks = 14 * 13;

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
          let maxBid = getBotMaxBid(bot, nominatedPlayer, C);
          bids.push({ bot: bot.name, bid: maxBid });
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
        winner = bids[0];
        winningPrice = 1;
      } else {
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
      nominatorIdx = nextIdx;
    }

    const finalC = engine.computeAll(state, players);
    const standings = finalC.powerRankings;
    const winnerTeam = standings[0];
    const ourTeam = standings.find(t => t.teamName === 'Alex');
    const ourRank = standings.findIndex(t => t.teamName === 'Alex') + 1;

    // Build payload
    const enrichPicks = (teamName) => {
      return state.picks.filter(p => p.teamName === teamName).map(pk => {
        const pl = players.find(x => x.rk === pk.rk);
        return {
          rk: pk.rk,
          name: pl ? pl.name : 'Unknown',
          pos: pl && pl.pos ? pl.pos.join('/') : '',
          price: pk.price,
          mktCost: pl ? pl.mktCost : 1
        };
      });
    };

    const teamZ = (teamName) => {
      const picks = state.picks.filter(p => p.teamName === teamName);
      const res = {};
      engine.CATS.forEach(c => res[c] = 0);
      picks.forEach(pk => {
        const zc = finalC.zAll.get(pk.rk);
        if (zc) engine.CATS.forEach(c => res[c] += zc[c]);
      });
      return res;
    };

    const winningBotObj = TEAMS.find(t => t.name === winnerTeam.teamName);

    parentPort.postMessage({
      runIndex,
      winner: {
        name: winnerTeam.teamName,
        type: winningBotObj ? winningBotObj.type : 'unknown',
        total: winnerTeam.total,
        budgetLeft: winnerTeam.budgetLeft,
        spent: 200 - winnerTeam.budgetLeft,
        picks: enrichPicks(winnerTeam.teamName)
      },
      ourRank,
      ourTotal: ourTeam.total,
      ourBudgetLeft: ourTeam.budgetLeft,
      ourSpent: 200 - ourTeam.budgetLeft,
      ourCatRanks: ourTeam.catRanks,
      winnerCatRanks: winnerTeam.catRanks,
      ourZ: teamZ('Alex'),
      winnerZ: teamZ(winnerTeam.teamName),
      ourPicks: enrichPicks('Alex')
    });
  });
}
