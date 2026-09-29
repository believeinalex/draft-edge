const PLAYERS = require('../players.js');
const { computeAll, checkPrice, runOptimizer, buildNameIndex, matchPlayer } = require('../engine.js');
const nameIndex = buildNameIndex(PLAYERS);

// 5 PG/SG players for You
const pg1 = matchPlayer('Tyrese Haliburton', PLAYERS, nameIndex);
const pg2 = matchPlayer('Shai Gilgeous-Alexander', PLAYERS, nameIndex);
const pg3 = matchPlayer('Stephen Curry', PLAYERS, nameIndex);
const pg4 = matchPlayer('Tyrese Maxey', PLAYERS, nameIndex);
const pg5 = matchPlayer('Donovan Mitchell', PLAYERS, nameIndex);

const picks = [
  { rk: pg1.rk, teamName: 'You', price: 35 },
  { rk: pg2.rk, teamName: 'You', price: 35 },
  { rk: pg3.rk, teamName: 'You', price: 25 },
  { rk: pg4.rk, teamName: 'You', price: 15 },
  { rk: pg5.rk, teamName: 'You', price: 11 },
];

const state = {
  numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'You',
  weights: {fgPct:1,ftPct:1,tpm:1,pts:1,treb:1,ast:1,stl:1,blk:1},
  picks: picks, starterSlots: 10, benchWeight: 0.3
};

const buz = matchPlayer('Matas Buzelis', PLAYERS, nameIndex);
const qui = matchPlayer('Immanuel Quickley', PLAYERS, nameIndex);

console.log('Optimizer:', runOptimizer(state, PLAYERS).players.map(p=> `#${p.rk} ${p.name} (${p.pos.join('/')}) $${p.cost} (${p.z.toFixed(2)}z)`));
console.log('\nBuzelis (SF/PF):', checkPrice(state, PLAYERS, buz.rk));
console.log('\nQuickley (PG/SG):', checkPrice(state, PLAYERS, qui.rk));
