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
  const embiidPrice = checkPrice(defaultState, PLAYERS, 47);
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
});

