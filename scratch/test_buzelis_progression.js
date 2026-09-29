const fs = require('fs');
const path = require('path');
const PLAYERS = require('../players.js');
const { computeAll, checkPrice, runOptimizer, buildNameIndex, matchPlayer } = require('../engine.js');
const { parseMockDraftText } = require('../utils/analyze_mock.js');

const mockText = fs.readFileSync(path.join(__dirname, '../utils/mock.txt'), 'utf8');
const { picks } = parseMockDraftText(mockText, PLAYERS);

// Run checkPrice for Buzelis at various pick counts
for(let N = 40; N <= 65; N += 5) {
  const state = {
    numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'Alex',
    weights: {fgPct:1,ftPct:1,tpm:1,pts:1,treb:1,ast:1,stl:1,blk:1},
    picks: picks.slice(0, N), starterSlots: 10, benchWeight: 0.3
  };
  const C = computeAll(state, PLAYERS);
  const buzelis = checkPrice(state, PLAYERS, 48);
  const quickley = checkPrice(state, PLAYERS, 80);
  console.log(`--- At ${N} picks (Inflation ${(C.inflation*100).toFixed(0)}%) ---`);
  console.log('Buzelis (rk 48):', buzelis ? `maxBid=$${buzelis.maxBid}, mktNow=$${buzelis.mktNow}, soloZ=${buzelis.soloZ.toFixed(2)}` : null);
  console.log('Quickley (rk 80):', quickley ? `maxBid=$${quickley.maxBid}, mktNow=$${quickley.mktNow}, soloZ=${quickley.soloZ.toFixed(2)}` : null);
}
