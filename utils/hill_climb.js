const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');
const players = require('../players.js');
const engine = require('../engine.js');

const numCpus = Math.max(1, os.cpus().length - 1);

function runCandidate(candidateName, config, runs = 15, geometry = { numTeams: 15, rosterSlots: 12, starterSlots: 9 }) {
  return new Promise((resolve) => {
    const numWorkers = Math.min(runs, numCpus);
    let runsCompleted = 0;
    let ourWins = 0;
    let ourTotalZ = 0;
    let ourTotalUnspent = 0;
    let ourTotalCats = {};
    let ourTotalCatRanks = {};
    engine.CATS.forEach(c => {
      ourTotalCats[c] = 0;
      ourTotalCatRanks[c] = 0;
    });
    let archetypeWins = { ours: 0, market: 0, stars_scrubs: 0, budget: 0, homer: 0, punt: 0, panic_spender: 0, price_enforcer: 0 };
    let workersActive = 0;
    let runsDispatched = 0;
    const t0 = Date.now();

    const workerFile = path.join(__dirname, 'simulate_parallel.js');

    function dispatch(worker) {
      if (runsDispatched < runs) {
        worker.postMessage({
          runIndex: runsDispatched,
          centerMode: config.centerMode || 'hybrid',
          numTeams: geometry.numTeams,
          rosterSlots: geometry.rosterSlots,
          starterSlots: geometry.starterSlots,
          hillClimbConfig: config
        });
        runsDispatched++;
      } else {
        worker.postMessage('exit');
      }
    }

    for (let i = 0; i < numWorkers; i++) {
      workersActive++;
      const worker = new Worker(workerFile);

      worker.on('message', (msg) => {
        runsCompleted++;
        ourTotalZ += msg.ourZ;
        ourTotalUnspent += (msg.ourUnspent || 0);
        archetypeWins[msg.winningArchetype]++;
        if (msg.winningArchetype === 'ours') ourWins++;
        engine.CATS.forEach(c => {
          ourTotalCats[c] += msg.ourCats[c];
          if (msg.ourCatRanks && msg.ourCatRanks[c]) {
            ourTotalCatRanks[c] += msg.ourCatRanks[c].rank;
          }
        });
        process.stdout.write(`\r  [${candidateName}] Progress: ${runsCompleted}/${runs} runs...`);
        dispatch(worker);
      });

      worker.on('exit', () => {
        workersActive--;
        if (workersActive === 0) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          const winRate = (ourWins / runs) * 100;
          const avgPowerPoints = ourTotalZ / runs;
          const avgUnspent = ourTotalUnspent / runs;
          const avgCats = {};
          const avgCatRanks = {};
          engine.CATS.forEach(c => {
            avgCats[c] = ourTotalCats[c] / runs;
            avgCatRanks[c] = ourTotalCatRanks[c] / runs;
          });

          // Penalty for any category dropping below #6.5 average league rank
          let balancePenalty = 0;
          for (const c of engine.CATS) {
            const rankDeficit = avgCatRanks[c] - 6.5;
            if (rankDeficit > 0) balancePenalty += 4.0 * Math.pow(rankDeficit, 2);
          }

          const fitness = winRate + 0.5 * (avgPowerPoints - 85) - balancePenalty;

          resolve({
            name: candidateName,
            config,
            geometry,
            runs,
            elapsed,
            winRate,
            avgPowerPoints,
            avgUnspent,
            avgCats,
            avgCatRanks,
            balancePenalty,
            fitness
          });
        }
      });

      dispatch(worker);
    }
  });
}

async function runAutonomousSearch() {
  console.log("================================================================================");
  console.log("   OVERNIGHT HILL-CLIMBING: CLOSING THE 3PM/FG% GAP IN 15-TEAM / 12-SLOT ROOMS  ");
  console.log("================================================================================\n");

  const candidates = [
    {
      name: "Cand A: Pure BaseTpm 1.05 (No Sat Decay)",
      config: {
        centerMode: 'hybrid',
        alpha: 0.10, wMin: 0.75, wMax: 1.45, targetPerPick: 0.08,
        baseFgPct: 1.08, baseTreb: 1.10, baseBlk: 1.15, baseTpm: 1.05,
        satThreshold: 99.0, satDecay: 0.0, lateDeficitBoost: 1.0,
        useMaxOppBid: true
      }
    },
    {
      name: "Cand B: Pure BaseTpm 1.06 + LateDeficitBoost 1.25 (No Sat Decay)",
      config: {
        centerMode: 'hybrid',
        alpha: 0.10, wMin: 0.75, wMax: 1.48, targetPerPick: 0.08,
        baseFgPct: 1.08, baseTreb: 1.10, baseBlk: 1.15, baseTpm: 1.06,
        satThreshold: 99.0, satDecay: 0.0, lateDeficitBoost: 1.25,
        useMaxOppBid: true
      }
    },
    {
      name: "Cand C: Gentle Alpha 0.09 + BaseTpm 1.04 + Higher Floor wMin 0.78",
      config: {
        centerMode: 'hybrid',
        alpha: 0.09, wMin: 0.78, wMax: 1.42, targetPerPick: 0.08,
        baseFgPct: 1.08, baseTreb: 1.10, baseBlk: 1.15, baseTpm: 1.04,
        satThreshold: 99.0, satDecay: 0.0, lateDeficitBoost: 1.20,
        useMaxOppBid: true
      }
    }
  ];

  let bestCandidate = null;
  const results = [];

  for (const c of candidates) {
    console.log(`\nEvaluating [${c.name}] (30 runs, 15 Teams / 12 Slots)...`);
    const res = await runCandidate(c.name, c.config, 30, { numTeams: 15, rosterSlots: 12, starterSlots: 9 });
    results.push(res);

    console.log(`\n  Done in ${res.elapsed}s!`);
    console.log(`  Win Rate: ${res.winRate.toFixed(1)}% | Power Points: ${res.avgPowerPoints.toFixed(1)} | Fitness: ${res.fitness.toFixed(2)} | Penalty: ${res.balancePenalty.toFixed(2)}`);
    console.log(`  Category Ranks (out of 15):`);
    console.log(`    FG%: #${res.avgCatRanks.fgPct.toFixed(2)} | FT%: #${res.avgCatRanks.ftPct.toFixed(2)} | 3PM: #${res.avgCatRanks.tpm.toFixed(2)} | PTS: #${res.avgCatRanks.pts.toFixed(2)}`);
    console.log(`    REB: #${res.avgCatRanks.treb.toFixed(2)} | AST: #${res.avgCatRanks.ast.toFixed(2)} | STL: #${res.avgCatRanks.stl.toFixed(2)} | BLK: #${res.avgCatRanks.blk.toFixed(2)}`);

    if (!bestCandidate || res.fitness > bestCandidate.fitness) {
      bestCandidate = res;
      console.log(`  >>> NEW CHAMPION CONFIGURATION! <<<`);
    }
  }

  console.log("\n================================================================================");
  console.log("                    OVERNIGHT HILL-CLIMBING SUMMARY (15T / 12S)                 ");
  console.log("================================================================================");
  console.table(results.map(r => ({
    Candidate: r.name,
    'Win %': `${r.winRate.toFixed(1)}%`,
    'Power Pts': r.avgPowerPoints.toFixed(1),
    'Fitness': r.fitness.toFixed(1),
    'FG% Rk': `#${r.avgCatRanks.fgPct.toFixed(1)}`,
    'FT% Rk': `#${r.avgCatRanks.ftPct.toFixed(1)}`,
    '3PM Rk': `#${r.avgCatRanks.tpm.toFixed(1)}`,
    'REB Rk': `#${r.avgCatRanks.treb.toFixed(1)}`,
    'BLK Rk': `#${r.avgCatRanks.blk.toFixed(1)}`,
  })));

  console.log(`\nChampion Config: ${bestCandidate.name} (Fitness: ${bestCandidate.fitness.toFixed(2)})`);
  console.log("Config Details:", JSON.stringify(bestCandidate.config, null, 2));

  fs.writeFileSync(path.join(__dirname, 'hill_climb_results.json'), JSON.stringify(results, null, 2));
}

if (require.main === module) {
  runAutonomousSearch();
}

module.exports = { runCandidate, runAutonomousSearch };
