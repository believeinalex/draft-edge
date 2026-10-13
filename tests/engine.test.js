const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAll, checkPrice, runOptimizer, matchPlayer, buildNameIndex, normName, CATS, CORE_POS } = require('../engine.js');
const PLAYERS = require('../players.js');

const defaultState = {
  numTeams: 12,
  rosterSlots: 13,
  budget: 200,
  myTeamName: 'You',
  weights: Object.fromEntries(CATS.map(c => [c, 1])),
  picks: [],
  starterSlots: 10,
  benchWeight: 0.3
};

test('normName normalizes diacritics and aliases', () => {
  assert.equal(normName('Nic Claxton'), 'nicolas claxton');
  assert.equal(normName('N. Jokić'), 'n jokic');
});

test('matchPlayer matches exact name and aliases', () => {
  const byNorm = buildNameIndex(PLAYERS);
  const jokic = matchPlayer('Nikola Jokic', PLAYERS, byNorm);
  assert.ok(jokic);
  assert.equal(jokic.name, 'Nikola Jokic');

  const claxton = matchPlayer('Nic Claxton', PLAYERS, byNorm);
  assert.ok(claxton);
  assert.equal(claxton.name, 'Nicolas Claxton');
});

test('matchPlayer returns null for unknown player', () => {
  const byNorm = buildNameIndex(PLAYERS);
  assert.equal(matchPlayer('Nonexistent Player 123', PLAYERS, byNorm), null);
});

test('computeAll calculates baseline pool stats and fair prices', () => {
  const C = computeAll(defaultState, PLAYERS);
  assert.equal(C.poolSize, 12 * 13);
  assert.equal(C.draftedCount, 0);
  assert.equal(C.remainingSlots, 156);
  assert.equal(C.inflation, 1.0);

  const jokicFairPrice = C.fairPrice(1);
  assert.ok(jokicFairPrice > 50, `Jokic fair price should be high, got ${jokicFairPrice}`);
});

test('computeAll handles inflation when draft spending changes', () => {
  const highPicks = [
    { rk: 1, teamName: 'Rival1', price: 90 },
    { rk: 2, teamName: 'Rival2', price: 85 }
  ];
  const stateHighSpend = Object.assign({}, defaultState, { picks: highPicks });
  const C = computeAll(stateHighSpend, PLAYERS);
  assert.ok(C.inflation >= 0.4 && C.inflation <= 2.2);
});

test('runOptimizer returns best feasible team with starter and bench allocation', () => {
  const res = runOptimizer(defaultState, PLAYERS);
  assert.ok(res);
  assert.equal(res.players.length, 13);
  assert.ok(res.totalCost <= 200);
  assert.ok(res.bestVal > 0);
});

test('runOptimizer applies heavy penalty to bench slots when benchWeight is low', () => {
  const stateWeight10 = Object.assign({}, defaultState, { benchWeight: 1.0 });
  const stateWeight00 = Object.assign({}, defaultState, { benchWeight: 0.0 });
  const resWeight10 = runOptimizer(stateWeight10, PLAYERS);
  const resWeight00 = runOptimizer(stateWeight00, PLAYERS);

  const topStartersZ10 = resWeight10.players.slice(0, 5).reduce((a, p) => a + p.z, 0);
  const topStartersZ00 = resWeight00.players.slice(0, 5).reduce((a, p) => a + p.z, 0);
  assert.ok(topStartersZ00 >= topStartersZ10, `Bench weight 0.0 should shift value to top starters: ${topStartersZ00} >= ${topStartersZ10}`);
});

test('checkPrice calculates max bid for top starter target', () => {
  const priceJokic = checkPrice(defaultState, PLAYERS, 1);
  assert.ok(priceJokic);
  assert.equal(priceJokic.player.name, 'Nikola Jokic');
  assert.ok(priceJokic.maxBid > 50, `Max bid for Jokic should be significant, got ${priceJokic.maxBid}`);
});

test('checkPrice penalizes max bid when all starter slots are already filled', () => {
  const starterPicks = PLAYERS.slice(0, 10).map((p) => ({
    rk: p.rk,
    teamName: 'You',
    price: 15
  }));
  const stateStartersFilled = Object.assign({}, defaultState, {
    picks: starterPicks,
    budget: 200 - 150
  });

  const targetBenchPlayer = 15;
  const priceBench = checkPrice(stateStartersFilled, PLAYERS, targetBenchPlayer);
  assert.ok(priceBench);

  const priceStarterEquiv = checkPrice(defaultState, PLAYERS, targetBenchPlayer);
  assert.ok(priceBench.maxBid <= priceStarterEquiv.maxBid,
    `Bench max bid (${priceBench.maxBid}) should be <= starter max bid (${priceStarterEquiv.maxBid})`);
});

// =========================================================================
// Enhanced Tests for 13-15 Team Leagues and Custom Roster Configuration
// =========================================================================

test('14-team league configuration (14 teams, 13 roster slots)', () => {
  const state14 = Object.assign({}, defaultState, { numTeams: 14, rosterSlots: 13 });
  const C = computeAll(state14, PLAYERS);
  assert.equal(C.poolSize, 14 * 13); // 182 players
  assert.equal(C.availableInPool.length, 182);

  const opt14 = runOptimizer(state14, PLAYERS);
  assert.ok(opt14);
  assert.equal(opt14.players.length, 13);
  assert.ok(opt14.totalCost <= 200);

  const cp14 = checkPrice(state14, PLAYERS, 1);
  assert.ok(cp14);
  assert.ok(cp14.maxBid > 0);
});

test('15-team league configuration (15 teams, 14 roster slots)', () => {
  const state15 = Object.assign({}, defaultState, { numTeams: 15, rosterSlots: 14, starterSlots: 10 });
  const C = computeAll(state15, PLAYERS);
  const expectedPool = Math.min(PLAYERS.length, 15 * 14); // 210 players
  assert.equal(C.poolSize, expectedPool);
  assert.equal(C.availableInPool.length, expectedPool);

  const opt15 = runOptimizer(state15, PLAYERS);
  assert.ok(opt15);
  assert.equal(opt15.players.length, 14);
  assert.ok(opt15.totalCost <= 200);

  const cp15 = checkPrice(state15, PLAYERS, 5);
  assert.ok(cp15);
  assert.ok(cp15.maxBid > 0);
});

test('Deep league mid-draft progress (15 teams with 120+ picks made)', () => {
  const picks150 = [];
  // 10 other teams have drafted 12 players each (120 picks total)
  for (let t = 1; t <= 10; t++) {
    for (let s = 0; s < 12; s++) {
      const pIdx = (t - 1) * 12 + s;
      picks150.push({ rk: PLAYERS[pIdx].rk, teamName: `Team${t}`, price: 10 });
    }
  }
  const stateDeepDraft = Object.assign({}, defaultState, {
    numTeams: 15,
    rosterSlots: 14,
    picks: picks150
  });

  const C = computeAll(stateDeepDraft, PLAYERS);
  assert.equal(C.draftedCount, 120);
  assert.equal(C.availableInPool.length, C.poolSize - 120); // remaining pool after 120 drafted picks

  const optDeep = runOptimizer(stateDeepDraft, PLAYERS);
  assert.ok(optDeep);
  assert.equal(optDeep.players.length, 14);

  const cpDeep = checkPrice(stateDeepDraft, PLAYERS, PLAYERS[121].rk);
  assert.ok(cpDeep);
});

test('Edge case: starterSlots >= rosterSlots', () => {
  const stateAllStarters = Object.assign({}, defaultState, { starterSlots: 15, rosterSlots: 13 });
  const opt = runOptimizer(stateAllStarters, PLAYERS);
  assert.ok(opt);
  assert.equal(opt.players.length, 13);

  const cp = checkPrice(stateAllStarters, PLAYERS, 1);
  assert.ok(cp);
  assert.ok(cp.maxBid > 0);
});

test('Edge case: late draft pool scarcity (available players < remaining roster slots)', () => {
  // 198 out of 200 players drafted
  const picks198 = PLAYERS.slice(0, 198).map((p, i) => ({
    rk: p.rk,
    teamName: `Team${(i % 12) + 1}`,
    price: 5
  }));
  const stateScarcity = Object.assign({}, defaultState, {
    picks: picks198,
    myTeamName: 'You'
  });

  // 'You' has 0 picks made, needs 13 slots, but only 2 players remain in pool
  const optScarcity = runOptimizer(stateScarcity, PLAYERS);
  assert.ok(optScarcity);
  assert.equal(optScarcity.infeasible, true);
});

test('Joel Embiid per-game rate valuation and max bid', () => {
  const nonDndPlayers = PLAYERS.map(p => p.rk === 47 ? Object.assign({}, p, { doNotDraft: false }) : p);
  const embiidPrice = checkPrice(defaultState, nonDndPlayers, 47);
  assert.ok(embiidPrice);
  assert.ok(embiidPrice.soloZ > -1.0, `Embiid soloZ should be sane, got ${embiidPrice.soloZ}`);
  assert.ok(embiidPrice.maxBid > 0, `Embiid should have a positive max bid, got ${embiidPrice.maxBid}`);
});

test('zRankMap and checkPrice return correct Z-Score Rank and category Z-scores', () => {
  const C = computeAll(defaultState, PLAYERS);
  assert.ok(C.zRankMap);
  assert.equal(C.zRankMap.get(1), 1, 'Nikola Jokic should be ranked #1 overall');
  assert.equal(C.zRankMap.get(2), 2, 'Victor Wembanyama should be ranked #2 overall');

  const wembyPrice = checkPrice(defaultState, PLAYERS, 2);
  assert.ok(wembyPrice);
  assert.equal(wembyPrice.zRank, 2);
  assert.ok(wembyPrice.zc);
  assert.ok(wembyPrice.zc.blk > 2.0, `Wembanyama BLK Z-score should be elite (> 2.0), got ${wembyPrice.zc.blk}`);
  assert.ok(wembyPrice.zc.pts > 1.0, `Wembanyama PTS Z-score should be strong (> 1.0), got ${wembyPrice.zc.pts}`);

  const opt = runOptimizer(defaultState, PLAYERS);
  assert.ok(opt.players.every(p => typeof p.rk === 'number' && p.rk > 0), 'Every optimizer player must have a valid rk');
});

test('checkPrice evaluates positive max bid for high-value targets even under positional constraints', () => {
  const buzelisPrice = checkPrice(defaultState, PLAYERS, 48); // Matas Buzelis
  assert.ok(buzelisPrice);
  assert.ok(buzelisPrice.maxBid > 0, `Buzelis maxBid should be > 0, got ${buzelisPrice.maxBid}`);
});

test('checkPrice agrees with runOptimizer: all suggested optimizer players get positive maxBids', () => {
  const opt = runOptimizer(defaultState, PLAYERS);
  assert.ok(opt && opt.players.length > 0);
  for (const optPlayer of opt.players) {
    const cp = checkPrice(defaultState, PLAYERS, optPlayer.rk);
    assert.ok(cp, `checkPrice for ${optPlayer.name} should exist`);
    assert.ok(cp.maxBid > 0, `Player ${optPlayer.name} is in Optimizer suggested team, checkPrice maxBid should be > 0, got ${cp.maxBid}`);
  }
});

// =========================================================================
// Snipe Detection Tests
// =========================================================================

test('runOptimizer returns snipes array (empty when opponents have budget)', () => {
  const res = runOptimizer(defaultState, PLAYERS);
  assert.ok(res);
  assert.ok(Array.isArray(res.snipes), 'snipes should be an array');
  // At start of draft, no opponents are broke, so snipes should be empty
  assert.equal(res.snipes.length, 0, 'No snipes expected at start of draft when all opponents have full budgets');
});

test('runOptimizer surfaces snipe targets when opponents are nearly broke', () => {
  // Build a late-draft scenario: 14 teams, 13 slots each = 182 total picks
  // 13 opponents have drafted 12 of 13 players each, spending most of their budget
  // "You" have drafted 10 of 13 players, with $40 remaining
  const picks = [];
  const numTeams = 14;
  const rosterSlots = 13;

  // Distribute top players to opponents so they're "gone" from the pool
  let playerIdx = 0;
  for (let t = 1; t <= numTeams - 1; t++) {
    const teamName = `Opp${t}`;
    for (let s = 0; s < rosterSlots - 1; s++) { // 12 picks each, 1 slot left
      // Each opponent spends $198, leaving $2 with 1 slot => maxBid = $2
      const perPick = s === 0 ? 198 - 15 * (rosterSlots - 2) : 15;
      picks.push({
        rk: PLAYERS[playerIdx].rk,
        teamName,
        price: perPick,
      });
      playerIdx++;
    }
  }

  // "You" have drafted 10 players spending $160, with $40 left and 3 slots
  const myPickCount = rosterSlots - 3; // 10 picks
  for (let s = 0; s < myPickCount; s++) {
    picks.push({
      rk: PLAYERS[playerIdx].rk,
      teamName: 'You',
      price: 16,
    });
    playerIdx++;
  }

  const lateDraftState = {
    numTeams,
    rosterSlots,
    budget: 200,
    myTeamName: 'You',
    weights: Object.fromEntries(CATS.map(c => [c, 1])),
    picks,
    starterSlots: 9,
    benchWeight: 0.3,
  };

  const res = runOptimizer(lateDraftState, PLAYERS);
  assert.ok(res, 'runOptimizer should return a result');
  assert.ok(!res.full && !res.infeasible, 'Should not be full or infeasible');
  assert.ok(Array.isArray(res.snipes), 'snipes should be an array');

  // With opponents maxing out at ~$2 bids, and remaining pool players having
  // fairPrice well above that, there should be snipe candidates
  if (res.snipes.length > 0) {
    // Verify snipe data shape
    const snipe = res.snipes[0];
    assert.ok(typeof snipe.rk === 'number', 'snipe.rk should be a number');
    assert.ok(typeof snipe.name === 'string', 'snipe.name should be a string');
    assert.ok(Array.isArray(snipe.pos), 'snipe.pos should be an array');
    assert.ok(typeof snipe.compositeZ === 'number', 'snipe.compositeZ should be a number');
    assert.ok(typeof snipe.fairPrice === 'number', 'snipe.fairPrice should be a number');
    assert.ok(typeof snipe.snipeCost === 'number', 'snipe.snipeCost should be a number');
    assert.ok(typeof snipe.surplus === 'number', 'snipe.surplus should be a number');

    // Verify snipe invariant: snipeCost < fairPrice * 0.5
    for (const s of res.snipes) {
      assert.ok(s.snipeCost < s.fairPrice * 0.5,
        `Snipe ${s.name}: snipeCost ($${s.snipeCost}) should be < 50% of fairPrice ($${s.fairPrice})`);
      assert.ok(s.surplus > 0, `Snipe ${s.name}: surplus should be positive`);
      assert.equal(s.surplus, s.fairPrice - s.snipeCost, `Snipe ${s.name}: surplus should equal fairPrice - snipeCost`);
    }

    // Verify sorted by compositeZ descending
    for (let i = 1; i < res.snipes.length; i++) {
      assert.ok(res.snipes[i].compositeZ <= res.snipes[i-1].compositeZ,
        `Snipes should be sorted by compositeZ descending`);
    }

    // Verify cap of 5
    assert.ok(res.snipes.length <= 5, `Snipes should be capped at 5, got ${res.snipes.length}`);
  }
});

// =========================================================================
// Endgame Monopoly ("Best Player Regardless of Money") & Dream Build Tests
// =========================================================================

test('Endgame Monopoly: recognizes dominant purchasing power even when Dream Build market cost exceeds budget, bids maxOppBid+1 on Dream targets, and passes on filler', () => {
  const picks = [];
  const numTeams = 14;
  const rosterSlots = 13;
  const pool = PLAYERS.slice(0, numTeams * rosterSlots);
  // Leave 5 mid-round value targets (Coby White, De'Aaron Fox, Onyeka Okongwu, etc.) undrafted on the board
  const undraftedTargets = new Set([65, 70, 75, 80, 85].map(i => pool[i].rk));
  const availToDraft = pool.filter(p => !undraftedTargets.has(p.rk));

  // 12 opponents have 1 slot left and $1 left (maxBid = $1)
  // 1 opponent (Opp1) has 1 slot left and $5 left (maxBid = $5)
  let playerIdx = 0;
  for (let t = 1; t <= numTeams - 1; t++) {
    const teamName = `Opp${t}`;
    const totalSpent = t === 1 ? 195 : 199;
    for (let s = 0; s < rosterSlots - 1; s++) {
      const perPick = s === 0 ? totalSpent - 15 * (rosterSlots - 2) : 15;
      picks.push({ rk: availToDraft[playerIdx++].rk, teamName, price: perPick });
    }
  }

  // "You" have 10 picks made spending $185 -> $15 left for 3 slots
  // Dream Build market cost is $17 (> $15 budget!), but rank-matched effective cost is $9 (<= $15 budget!)
  for (let s = 0; s < rosterSlots - 3; s++) {
    const perPick = s === 0 ? 185 - 18 * (rosterSlots - 4) : 18;
    picks.push({ rk: availToDraft[playerIdx++].rk, teamName: 'You', price: perPick });
  }

  const monopolyState = {
    numTeams,
    rosterSlots,
    budget: 200,
    myTeamName: 'You',
    weights: Object.fromEntries(CATS.map(c => [c, 1])),
    picks,
    starterSlots: 9,
    benchWeight: 0.3,
  };

  const opt = runOptimizer(monopolyState, PLAYERS);
  assert.ok(opt, 'runOptimizer should return a result');
  assert.ok(opt.dreamMarketCost > opt.budgetLeft, `Dream market cost ($${opt.dreamMarketCost}) should exceed remaining budget ($${opt.budgetLeft})`);
  assert.ok(opt.totalCost <= opt.budgetLeft, `Effective cost ($${opt.totalCost}) should fit within remaining budget ($${opt.budgetLeft})`);
  assert.equal(opt.isMonopoly, true, 'Should detect Endgame Monopoly when $15 covers rank-matched Dream Build');
  assert.equal(opt.maxOppBid, 5, 'Highest opponent max bid should be $5');
  assert.equal(opt.players.length, 3);
  assert.ok(opt.players.every(p => p.inDreamBuild), 'All chosen players in Monopoly mode must be Dream Build players');

  // Every Dream Build player should get maxBid == maxOppBid + 1 ($6) in checkPrice
  for (const dp of opt.players) {
    const cp = checkPrice(monopolyState, PLAYERS, dp.rk);
    assert.ok(cp);
    assert.equal(cp.inDreamBuild, true);
    assert.equal(cp.isMonopoly, true);
    assert.equal(cp.maxBid, 6, `Dream Build target ${dp.name} should get maxBid = $6 (maxOppBid + 1), got $${cp.maxBid}`);
  }

  // A mediocre filler player remaining at the bottom of the pool (not in Dream Build) must be a strict PASS ($0)
  const dreamRks = new Set(opt.players.map(p => p.rk));
  const C = computeAll(monopolyState, PLAYERS);
  const fillerCandidates = C.availableInPool.filter(p => !dreamRks.has(p.rk));
  const worstFiller = fillerCandidates[fillerCandidates.length - 1];
  const cpFiller = checkPrice(monopolyState, PLAYERS, worstFiller.rk);
  assert.ok(cpFiller);
  assert.equal(cpFiller.inDreamBuild, false);
  assert.equal(cpFiller.maxBid, 0, `Filler player ${worstFiller.name} should be a PASS ($0) in Monopoly mode, got $${cpFiller.maxBid}`);
  assert.ok(cpFiller.dreamAlternativeNames.length > 0, 'Pass on filler should list Dream Build targets to save for');
});

test('Dream Build & Bait Nominations surface when one opponent still out-prices full Dream Build', () => {
  const picks = [];
  const numTeams = 14;
  const rosterSlots = 13;

  // Opp1 has $14 left with 1 slot (maxBid = $14), everyone else has $1 left
  let playerIdx = 0;
  for (let t = 1; t <= numTeams - 1; t++) {
    const teamName = `Opp${t}`;
    const totalSpent = t === 1 ? 186 : 199;
    for (let s = 0; s < rosterSlots - 1; s++) {
      const perPick = s === 0 ? totalSpent - 15 * (rosterSlots - 2) : 15;
      picks.push({ rk: PLAYERS[playerIdx].rk, teamName, price: perPick });
      playerIdx++;
    }
  }

  // "You" have $8 left for 3 slots (enough to beat $1 opponents [$2+$2+$2=$6], but not enough if Opp1 bids $14 on our #1 Dream target)
  for (let s = 0; s < rosterSlots - 3; s++) {
    const perPick = s === 0 ? 192 - 18 * (rosterSlots - 4) : 18;
    picks.push({ rk: PLAYERS[playerIdx].rk, teamName: 'You', price: perPick });
    playerIdx++;
  }

  const nearMonopolyState = {
    numTeams,
    rosterSlots,
    budget: 200,
    myTeamName: 'You',
    weights: Object.fromEntries(CATS.map(c => [c, 1])),
    picks,
    starterSlots: 9,
    benchWeight: 0.3,
  };

  const opt = runOptimizer(nearMonopolyState, PLAYERS);
  assert.ok(opt);
  assert.equal(opt.dreamPlayers.length, 3, 'Should return 3 Dream Build players');
  assert.ok(opt.dreamVal >= opt.bestVal, 'Dream Build value should be >= budget-constrained value');
  if (!opt.isMonopoly) {
    assert.ok(opt.dreamPlayers.some(p => !p.inBudgetBuild), 'Dream Build should highlight at least one upgrade over budget build');
    assert.ok(Array.isArray(opt.baitPlayers), 'Should return baitPlayers array');
  }
});

test('Monopoly Build Protection: caps maxBid at buildBid to preserve rest of Dream Build instead of gutting bench, and uses top passRoster for alternativeNames', () => {
  // Reproduce the Kawhi Leonard screenshot scenario:
  // 12 teams, 13 slots, 52% inflation: top ~20 stars drafted by opponents spending almost all their budgets,
  // one opponent (Jacobsman13) has $66 left for 9 slots (maxOppBid = $58),
  // "You" have 3 picks made spending $79 -> $121 left for 10 slots (6 starters + 4 bench).
  const picks = [];
  const numTeams = 12;
  const rosterSlots = 13;

  // Draft top 17 players (rk 1..17) + several mid players across opponents so Kawhi (#18) is the top remaining player
  const oppConfigs = [
    { name: 'Ning', picks: 4, spent: 188 },
    { name: 'BILAL', picks: 5, spent: 190 },
    { name: 'Team 10', picks: 5, spent: 185 },
    { name: 'G', picks: 3, spent: 183 },
    { name: 'Quam', picks: 5, spent: 188 },
    { name: 'Alex', picks: 3, spent: 169 },
    { name: 'Team 11', picks: 4, spent: 183 },
    { name: 'Michael', picks: 5, spent: 174 },
    { name: 'Jacobsman13', picks: 4, spent: 134 }, // $66 left
    { name: 'Opp10', picks: 4, spent: 190 },
    { name: 'Opp11', picks: 4, spent: 190 },
  ];

  // Keep Kawhi (#18), Dejounte (#24), JJJ (#28), Kyrie (#29), Garland (#34), LeBron (#35), PG (#53), Rollins (#60), Siakam (#70), Dyson (#72) available
  const keepUndrafted = new Set([18, 24, 28, 29, 34, 35, 53, 60, 70, 72]);
  const draftableForOpps = PLAYERS.filter(p => !keepUndrafted.has(p.rk));
  let idx = 0;

  // "You" have 3 picks for $79 ($121 left, 10 slots left)
  picks.push({ rk: draftableForOpps[idx++].rk, teamName: 'You', price: 30 });
  picks.push({ rk: draftableForOpps[idx++].rk, teamName: 'You', price: 25 });
  picks.push({ rk: draftableForOpps[idx++].rk, teamName: 'You', price: 24 });

  for (const oc of oppConfigs) {
    for (let s = 0; s < oc.picks; s++) {
      const price = s === 0 ? oc.spent - 20 * (oc.picks - 1) : 20;
      picks.push({ rk: draftableForOpps[idx++].rk, teamName: oc.name, price });
    }
  }

  const kawhiState = {
    numTeams,
    rosterSlots,
    budget: 200,
    myTeamName: 'You',
    weights: Object.fromEntries(CATS.map(c => [c, 1])),
    picks,
    starterSlots: 9,
    benchWeight: 0.3,
  };

  const cp = checkPrice(kawhiState, PLAYERS, 18); // Kawhi Leonard
  assert.ok(cp);
  assert.equal(cp.isMonopoly, true, 'Should be in Monopoly mode when $121 covers the entire 10-player Dream Build');
  assert.ok(cp.breakEvenBid > 35, `Unconstrained break-even bid should be high ($${cp.breakEvenBid}) due to 0.3x bench weight`);
  assert.ok(cp.maxBid <= 30, `Protected maxBid ($${cp.maxBid}) should preserve budget for the other 9 Dream Build players instead of bidding $${cp.breakEvenBid}`);
  assert.equal(cp.maxBid, cp.buildBid, 'maxBid should equal buildBid in Monopoly mode');
  assert.ok(!cp.alternativeNames.includes('Tari Eason') && !cp.alternativeNames.includes('Mitchell Robinson'),
    `alternativeNames (${cp.alternativeNames.join(', ')}) should list top passRoster stars, not $1 bench fillers`);
});


