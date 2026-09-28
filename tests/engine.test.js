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
  const resWeight03 = runOptimizer(defaultState, PLAYERS);
  const stateWeight00 = Object.assign({}, defaultState, { benchWeight: 0.0 });
  const resWeight00 = runOptimizer(stateWeight00, PLAYERS);

  assert.ok(resWeight00.bestVal <= resWeight03.bestVal);
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
