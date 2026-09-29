const PLAYERS = require('../players.js');
const { computeAll, checkPrice, runOptimizer, buildNameIndex, matchPlayer } = require('../engine.js');

const nameIndex = buildNameIndex(PLAYERS);

// Target players from screenshot
const buz = matchPlayer('Matas Buzelis', PLAYERS, nameIndex);
const qui = matchPlayer('Immanuel Quickley', PLAYERS, nameIndex);
const gar = matchPlayer('Darius Garland', PLAYERS, nameIndex);
const sug = matchPlayer('Jalen Suggs', PLAYERS, nameIndex);
const her = matchPlayer('Tyler Herro', PLAYERS, nameIndex);
const pg  = matchPlayer('Paul George', PLAYERS, nameIndex);
const rol = matchPlayer('Ryan Rollins', PLAYERS, nameIndex);
const ran = matchPlayer('Julius Randle', PLAYERS, nameIndex);
const por = matchPlayer('Kristaps Porzingis', PLAYERS, nameIndex);

// Let's create draft state to match screenshot:
// Available pool has fair prices: Garland 14, Suggs 12, Herro 12, PG 11, Rollins 9, Quickley 8, Randle 7, Porzingis 6, Buzelis 12
// Total remaining budget for You = $79 across 8 slots.

// To get these exact fair prices, we set inflation ratio = 0.58
// Let's craft picks for state:
const picks = [];
// 5 picks for You spending $121
picks.push({ rk: 1, teamName: 'You', price: 45 }); // Jokic
picks.push({ rk: 2, teamName: 'You', price: 35 }); // Wemby
picks.push({ rk: 3, teamName: 'You', price: 21 }); // SGA
picks.push({ rk: 4, teamName: 'You', price: 12 });
picks.push({ rk: 5, teamName: 'You', price: 8 });

// Draft top market cost players for other teams so available pool fair prices match screenshot
PLAYERS.forEach(p => {
  if ([buz.rk, qui.rk, gar.rk, sug.rk, her.rk, pg.rk, rol.rk, ran.rk, por.rk].includes(p.rk)) return;
  if (p.rk <= 45 && !picks.some(pk => pk.rk === p.rk)) {
    picks.push({ rk: p.rk, teamName: 'Other', price: Math.round(p.mktCost * 0.6) });
  }
});

const state = {
  numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'You',
  weights: {fgPct:1,ftPct:1,tpm:1,pts:1,treb:1,ast:1,stl:1,blk:1},
  picks: picks, starterSlots: 10, benchWeight: 0.3
};

const C = computeAll(state, PLAYERS);
console.log('Inflation:', (C.inflation*100).toFixed(0) + '%');
console.log('Buzelis fairPrice:', C.fairPrice(buz.rk));
console.log('Quickley fairPrice:', C.fairPrice(qui.rk));
console.log('Optimizer:', runOptimizer(state, PLAYERS).players.map(p=> `#${p.rk} ${p.name} $${p.cost} (${p.z.toFixed(2)}z)`));

console.log('\n--- checkPrice Buzelis ---');
const resBuz = checkPrice(state, PLAYERS, buz.rk);
console.log(resBuz);

