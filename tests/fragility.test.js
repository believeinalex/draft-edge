const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAll, checkPrice, runOptimizer, getFragility, getFragUnits, CATS } = require('../engine.js');
const PLAYERS = require('../players.js');

const defaultState = {
  numTeams: 15,
  rosterSlots: 12,
  budget: 200,
  myTeamName: 'You',
  weights: Object.fromEntries(CATS.map(c => [c, 1])),
  picks: [],
  starterSlots: 9,
  benchWeight: 0.3,
  maxFragility: 1.0
};

test('getFragility correctly identifies Tier 1 (1.0), Tier 2 (0.5), Durable (0.0), and DND (Infinity)', () => {
  // Tier 1 (1.0)
  assert.equal(getFragility({ name: 'Kawhi Leonard' }, defaultState), 1.0);
  assert.equal(getFragility({ name: 'Joel Embiid' }, defaultState), 1.0);
  assert.equal(getFragility({ name: 'Kyrie Irving' }, defaultState), 1.0);
  assert.equal(getFragility({ name: 'LaMelo Ball' }, defaultState), 1.0);
  assert.equal(getFragility({ name: 'Zion Williamson' }, defaultState), 1.0);
  assert.equal(getFragility({ name: 'Ja Morant' }, defaultState), 1.0);

  // Tier 2 (0.5)
  assert.equal(getFragility({ name: 'Stephen Curry' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'LeBron James' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Kevin Durant' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Anthony Davis' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Zach Edey' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Jayson Tatum' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Dejounte Murray' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Paul George' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Tyrese Haliburton' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Domantas Sabonis' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Damian Lillard' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Walker Kessler' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Jalen Suggs' }, defaultState), 0.5);
  assert.equal(getFragility({ name: 'Kon Knueppel' }, defaultState), 0.5);

  // Durable (0.0)
  assert.equal(getFragility({ name: 'Nikola Jokic' }, defaultState), 0.0);
  assert.equal(getFragility({ name: 'Luka Doncic' }, defaultState), 0.0);
  assert.equal(getFragility({ name: 'Shai Gilgeous-Alexander' }, defaultState), 0.0);
  assert.equal(getFragility({ name: "Kel'el Ware" }, defaultState), 0.0);
  assert.equal(getFragility({ name: 'Brandon Miller' }, defaultState), 0.0);
  assert.equal(getFragility({ name: 'Lauri Markkanen' }, defaultState), 0.0);

  // DND (Infinity)
  assert.equal(getFragility({ name: 'Brandon Ingram', doNotDraft: true }, defaultState), Infinity);
  assert.equal(getFragility({ name: 'Kristaps Porzingis', doNotDraft: true }, defaultState), Infinity);
  assert.equal(getFragility({ name: 'Jimmy Butler III', doNotDraft: true }, defaultState), Infinity);
  assert.equal(getFragility({ name: 'Nikola Jokic' }, { doNotDraft: ['Nikola Jokic'] }), Infinity);
});

test('getFragUnits returns correct quantized units (0, 1, 2, 999)', () => {
  assert.equal(getFragUnits({ name: 'Nikola Jokic' }, defaultState), 0);
  assert.equal(getFragUnits({ name: 'Anthony Davis' }, defaultState), 1);
  assert.equal(getFragUnits({ name: 'Kawhi Leonard' }, defaultState), 2);
  assert.equal(getFragUnits({ name: 'Brandon Ingram', doNotDraft: true }, defaultState), 999);
});

test('checkPrice permits fragile player when roster fragility is 0', () => {
  const kawhi = PLAYERS.find(p => p.name === 'Kawhi Leonard');
  assert.ok(kawhi);
  const cp = checkPrice(defaultState, PLAYERS, kawhi.rk);
  assert.ok(cp.maxBid > 0, `Kawhi should have positive maxBid on empty roster, got ${cp.maxBid}`);
  assert.equal(cp.fragilityCapped, false);
  assert.equal(cp.fragility, 1.0);
  assert.equal(cp.currentRosterFragility, 0);
});

test('checkPrice caps 1.0 fragile player when roster already has 0.5 fragility', () => {
  const ad = PLAYERS.find(p => p.name === 'Anthony Davis');
  const kawhi = PLAYERS.find(p => p.name === 'Kawhi Leonard');
  assert.ok(ad && kawhi);

  const stateWithAD = Object.assign({}, defaultState, {
    picks: [{ rk: ad.rk, teamName: 'You', price: 25 }]
  });

  const cp = checkPrice(stateWithAD, PLAYERS, kawhi.rk);
  assert.equal(cp.maxBid, 0, 'Kawhi must have maxBid 0 when AD is already on roster');
  assert.equal(cp.fragilityCapped, true);
  assert.equal(cp.currentRosterFragility, 0.5);
  assert.equal(cp.fragility, 1.0);
});

test('checkPrice allows second 0.5 player when roster has 0.5 fragility', () => {
  const ad = PLAYERS.find(p => p.name === 'Anthony Davis');
  const curry = PLAYERS.find(p => p.name === 'Stephen Curry');
  assert.ok(ad && curry);

  const stateWithAD = Object.assign({}, defaultState, {
    picks: [{ rk: ad.rk, teamName: 'You', price: 25 }]
  });

  const cp = checkPrice(stateWithAD, PLAYERS, curry.rk);
  assert.ok(cp.maxBid > 0, `Curry should have positive maxBid when AD is on roster, got ${cp.maxBid}`);
  assert.equal(cp.fragilityCapped, false);
  assert.equal(cp.currentRosterFragility, 0.5);
  assert.equal(cp.fragility, 0.5);
});

test('checkPrice caps 0.5 player when roster already reached 1.0 fragility', () => {
  const ad = PLAYERS.find(p => p.name === 'Anthony Davis');
  const edey = PLAYERS.find(p => p.name === 'Zach Edey');
  const curry = PLAYERS.find(p => p.name === 'Stephen Curry');
  const luka = PLAYERS.find(p => p.name === 'Luka Doncic');
  assert.ok(ad && edey && curry && luka);

  const stateFullFrag = Object.assign({}, defaultState, {
    picks: [
      { rk: ad.rk, teamName: 'You', price: 25 },
      { rk: edey.rk, teamName: 'You', price: 16 }
    ]
  });

  // Steph Curry (0.5) should be capped
  const cpCurry = checkPrice(stateFullFrag, PLAYERS, curry.rk);
  assert.equal(cpCurry.maxBid, 0, 'Curry must have maxBid 0 when roster fragility is at 1.0');
  assert.equal(cpCurry.fragilityCapped, true);
  assert.equal(cpCurry.currentRosterFragility, 1.0);

  // Luka Doncic (0.0) should NOT be capped
  const cpLuka = checkPrice(stateFullFrag, PLAYERS, luka.rk);
  assert.ok(cpLuka.maxBid > 0, 'Luka (0.0) should have positive maxBid');
  assert.equal(cpLuka.fragilityCapped, false);
});

test('runOptimizer and solveDreamBuild never exceed 1.0 total fragility in recommended builds', () => {
  const opt = runOptimizer(defaultState, PLAYERS);
  assert.ok(opt);
  assert.ok(opt.players.length > 0);

  const totalBuildFrag = opt.players.reduce((sum, p) => sum + (p.fragility || 0), 0);
  assert.ok(totalBuildFrag <= 1.0 + 1e-6, `Recommended build fragility must be <= 1.0, got ${totalBuildFrag}`);

  if (opt.dreamPlayers && opt.dreamPlayers.length > 0) {
    const totalDreamFrag = opt.dreamPlayers.reduce((sum, p) => sum + (p.fragility || 0), 0);
    assert.ok(totalDreamFrag <= 1.0 + 1e-6, `Dream build fragility must be <= 1.0, got ${totalDreamFrag}`);
  }
});
