const fs = require('fs');
const PLAYERS = require('../players.js');
const { computeAll, checkPrice, runOptimizer, buildNameIndex, matchPlayer } = require('../engine.js');

// Let's find players in PLAYERS
const nameIndex = buildNameIndex(PLAYERS);

// Search for players in screenshot
const buz = matchPlayer('Matas Buzelis', PLAYERS, nameIndex);
const qui = matchPlayer('Immanuel Quickley', PLAYERS, nameIndex);
const gar = matchPlayer('Darius Garland', PLAYERS, nameIndex);
const sug = matchPlayer('Jalen Suggs', PLAYERS, nameIndex);
const her = matchPlayer('Tyler Herro', PLAYERS, nameIndex);
const pg  = matchPlayer('Paul George', PLAYERS, nameIndex);
const rol = matchPlayer('Ryan Rollins', PLAYERS, nameIndex);
const ran = matchPlayer('Julius Randle', PLAYERS, nameIndex);
const por = matchPlayer('Kristaps Porzingis', PLAYERS, nameIndex);

console.log('Buzelis rk:', buz ? buz.rk : null);
console.log('Quickley rk:', qui ? qui.rk : null);

// Let's create a state where You has 5 picks and $79 left ($121 spent)
// We adjust inflation so fairPrice of Garland=$14, Suggs=$12, Herro=$12, PG=$11, Rollins=$9, Quickley=$8, Randle=$7, Porzingis=$6
// That happens when inflation is ~ 0.58-0.60
const picks = [
  // 5 picks for You spending $121
  { rk: 1, teamName: 'You', price: 50 }, // Jokic or similar
  { rk: 2, teamName: 'You', price: 35 },
  { rk: 3, teamName: 'You', price: 20 },
  { rk: 4, teamName: 'You', price: 10 },
  { rk: 5, teamName: 'You', price: 6 },
];

// Add picks for other teams so inflation drops to ~57% and total budget spent is high
for(let t=1; t<=11; t++) {
  picks.push({ rk: 10 + t*2, teamName: `Team${t}`, price: 40 });
  picks.push({ rk: 10 + t*2 + 1, teamName: `Team${t}`, price: 30 });
}

const state = {
  numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'You',
  weights: {fgPct:1,ftPct:1,tpm:1,pts:1,treb:1,ast:1,stl:1,blk:1},
  picks: picks, starterSlots: 10, benchWeight: 0.3
};

const C = computeAll(state, PLAYERS);
console.log('Inflation:', (C.inflation*100).toFixed(0) + '%');
console.log('Optimizer:', runOptimizer(state, PLAYERS).players.map(p=> `#${p.rk} ${p.name} $${p.cost} (${p.z.toFixed(2)}z)`));

console.log('\n--- checkPrice Buzelis (rk ' + buz.rk + ') ---');
console.log(checkPrice(state, PLAYERS, buz.rk));

console.log('\n--- checkPrice Quickley (rk ' + qui.rk + ') ---');
console.log(checkPrice(state, PLAYERS, qui.rk));
