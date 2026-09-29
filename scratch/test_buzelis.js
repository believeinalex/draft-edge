const fs = require('fs');
const PLAYERS = require('../players.js');
const { computeAll, checkPrice, runOptimizer, buildNameIndex, matchPlayer } = require('../engine.js');
const { parseMockDraftText } = require('../utils/analyze_mock.js');

const path = require('path');
const mockText = fs.readFileSync(path.join(__dirname, '../utils/mock.txt'), 'utf8');
const { picks } = parseMockDraftText(mockText, PLAYERS);

console.log('Total picks parsed:', picks.length);

// Let's test checkPrice at pick 40
const stateMid = {
  numTeams: 14, rosterSlots: 13, budget: 200, myTeamName: 'Alex',
  weights: {fgPct:1,ftPct:1,tpm:1,pts:1,treb:1,ast:1,stl:1,blk:1},
  picks: picks.slice(0, 40), starterSlots: 10, benchWeight: 0.3
};

console.log('Alex picks made:', stateMid.picks.filter(p=>p.teamName==='Alex'));
console.log('Buzelis (rk 48):', checkPrice(stateMid, PLAYERS, 48));
console.log('Quickley (rk 80):', checkPrice(stateMid, PLAYERS, 80));
