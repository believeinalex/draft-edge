const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const os = require('os');
const players = require('../players.js');
const engine = require('../engine.js');

const numCpus = Math.max(1, os.cpus().length - 1);

function runCandidate(candidateName, config, runs = 15) {
  return new Promise((resolve) => {
    const numWorkers = Math.min(runs, numCpus);
    let runsCompleted = 0;
    let ourWins = 0;
    let ourTotalZ = 0;
    let ourTotalCats = {};
    engine.CATS.forEach(c => ourTotalCats[c] = 0);
    let archetypeWins = { ours: 0, market: 0, stars_scrubs: 0, budget: 0, homer: 0 };
    let workersActive = 0;
    let runsDispatched = 0;
    const t0 = Date.now();

    const workerFile = path.join(__dirname, 'simulate_parallel.js');

    function dispatch(worker) {
      if (runsDispatched < runs) {
        worker.postMessage({
          runIndex: runsDispatched,
          centerMode: config.centerMode || 'hybrid',
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
        archetypeWins[msg.winningArchetype]++;
        if (msg.winningArchetype === 'ours') ourWins++;
        engine.CATS.forEach(c => { ourTotalCats[c] += msg.ourCats[c]; });
        process.stdout.write(`\r  [${candidateName}] Progress: ${runsCompleted}/${runs} runs...`);
        dispatch(worker);
      });

      worker.on('exit', () => {
        workersActive--;
        if (workersActive === 0) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          const winRate = (ourWins / runs) * 100;
          const avgPowerPoints = ourTotalZ / runs;
          const avgCats = {};
          engine.CATS.forEach(c => { avgCats[c] = ourTotalCats[c] / runs; });

          // Penalty for any category dropping below -0.50 sigma
          let balancePenalty = 0;
          for (const c of engine.CATS) {
            const deficit = -0.50 - avgCats[c];
            if (deficit > 0) balancePenalty += 15 * Math.pow(deficit, 2);
          }

          const fitness = winRate + 0.5 * (avgPowerPoints - 80) - balancePenalty;

          resolve({
            name: candidateName,
            config,
            runs,
            elapsed,
            winRate,
            avgPowerPoints,
            avgCats,
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
  console.log("       AUTONOMOUS HILL-CLIMBING: TARGETING 90%+ WIN RATE WITH BALANCED ROSTER   ");
  console.log("================================================================================\n");

  const candidates = [
    {
      name: "Iter 0: Baseline Hybrid Prototype",
      config: {
        centerMode: 'hybrid',
        alpha: 0.20,
        wMin: 0.50,
        wMax: 1.80,
        targetPerPick: 0.10,
        ftGuardrail: 1.0,
        starterTolerance: 0.0,
        useMaxOppBid: false
      }
    },
    {
      name: "Iter 1: Hybrid + Opponent Max-Bid Capping",
      config: {
        centerMode: 'hybrid',
        alpha: 0.20,
        wMin: 0.50,
        wMax: 1.80,
        targetPerPick: 0.10,
        ftGuardrail: 1.0,
        starterTolerance: 0.0,
        useMaxOppBid: true
      }
    },
    {
      name: "Iter 2: + Volume FT% Guardrail (ftGuardrail: 1.35)",
      config: {
        centerMode: 'hybrid',
        alpha: 0.20,
        wMin: 0.50,
        wMax: 1.80,
        targetPerPick: 0.10,
        ftGuardrail: 1.35,
        starterTolerance: 0.0,
        useMaxOppBid: true
      }
    },
    {
      name: "Iter 3: + Starter Tolerance 0.12 + Smoothed Deficit",
      config: {
        centerMode: 'hybrid',
        alpha: 0.12,
        wMin: 0.70,
        wMax: 1.50,
        targetPerPick: 0.10,
        ftGuardrail: 1.35,
        starterTolerance: 0.12,
        useMaxOppBid: true
      }
    },
    {
      name: "Iter 4: Starter Tolerance 0.16 + Tuned Balance",
      config: {
        centerMode: 'hybrid',
        alpha: 0.14,
        wMin: 0.65,
        wMax: 1.60,
        targetPerPick: 0.10,
        ftGuardrail: 1.25,
        starterTolerance: 0.16,
        useMaxOppBid: true
      }
    }
  ];

  let bestCandidate = null;
  const results = [];

  for (const c of candidates) {
    console.log(`\nEvaluating [${c.name}]...`);
    const res = await runCandidate(c.name, c.config, 15);
    results.push(res);

    console.log(`\n  Done in ${res.elapsed}s!`);
    console.log(`  Win Rate: ${res.winRate.toFixed(1)}% | Power Points: ${res.avgPowerPoints.toFixed(1)} | Fitness: ${res.fitness.toFixed(2)}`);
    console.log(`  Balance Penalty: ${res.balancePenalty.toFixed(2)}`);
    console.log(`  Category Z-Scores:`);
    console.log(`    FG%: ${res.avgCats.fgPct.toFixed(3)} | FT%: ${res.avgCats.ftPct.toFixed(3)} | 3PM: ${res.avgCats.tpm.toFixed(3)} | PTS: ${res.avgCats.pts.toFixed(3)}`);
    console.log(`    REB: ${res.avgCats.treb.toFixed(3)} | AST: ${res.avgCats.ast.toFixed(3)} | STL: ${res.avgCats.stl.toFixed(3)} | BLK: ${res.avgCats.blk.toFixed(3)}`);

    if (!bestCandidate || res.fitness > bestCandidate.fitness) {
      bestCandidate = res;
      console.log(`  >>> NEW CHAMPION CONFIGURATION! <<<`);
    }
  }

  console.log("\n================================================================================");
  console.log("                           HILL-CLIMBING SUMMARY                                ");
  console.log("================================================================================");
  console.table(results.map(r => ({
    Candidate: r.name,
    'Win %': `${r.winRate.toFixed(1)}%`,
    'Power Pts': r.avgPowerPoints.toFixed(1),
    'Fitness': r.fitness.toFixed(1),
    'FG%': r.avgCats.fgPct.toFixed(2),
    'FT%': r.avgCats.ftPct.toFixed(2),
    'REB': r.avgCats.treb.toFixed(2),
    'BLK': r.avgCats.blk.toFixed(2),
  })));

  console.log(`\nChampion Config: ${bestCandidate.name} (Fitness: ${bestCandidate.fitness.toFixed(2)})`);
  console.log("Config Details:", JSON.stringify(bestCandidate.config, null, 2));

  // Save report
  fs.writeFileSync(path.join(__dirname, 'hill_climb_results.json'), JSON.stringify(results, null, 2));
}

if (require.main === module) {
  runAutonomousSearch();
}

module.exports = { runCandidate, runAutonomousSearch };
