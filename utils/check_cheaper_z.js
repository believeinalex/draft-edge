const fs = require('fs');
const path = require('path');
const players = require('../players.js');
const engine = require('../engine.js');
const analyzeMock = require('./analyze_mock.js');

const text = fs.readFileSync(path.join(__dirname, 'mock.txt'), 'utf8');
const parsed = analyzeMock.parseMockDraftText(text);

const state = {
  numTeams: 14,
  rosterSlots: 13,
  budget: 200,
  myTeamName: 'Alex',
  weights: Object.fromEntries(engine.CATS.map(c => [c, 1])),
  picks: parsed.picks.map(p => ({ rk: p.rk, teamName: p.teamName, price: p.price })),
  starterSlots: 10,
  benchWeight: 0.3
};

const C = engine.computeAll(state, players);

const allPicksWithZ = parsed.picks.map(p => {
  const zObj = C.zAll.get(p.rk) || {};
  let totalZ = 0;
  for (const c of engine.CATS) {
    totalZ += zObj[c] || 0;
  }
  return {
    pickNum: p.pickNum,
    teamName: p.teamName,
    name: p.player.name,
    rk: p.rk,
    price: p.price,
    totalZ
  };
});

const alexPicks = allPicksWithZ.filter(p => p.teamName.toLowerCase() === 'alex');
const otherPicks = allPicksWithZ.filter(p => p.teamName.toLowerCase() !== 'alex');

console.log('=== ALEX PICKS vs CHEAPER HIGHER-Z PLAYERS ===\n');

alexPicks.forEach(ap => {
  const betterCheaper = otherPicks.filter(op => op.price < ap.price && op.totalZ > ap.totalZ);
  betterCheaper.sort((a, b) => b.totalZ - a.totalZ);

  console.log(`Alex Pick: ${ap.name} ($${ap.price} | Z: ${ap.totalZ.toFixed(2)})`);
  if (betterCheaper.length === 0) {
    console.log(`  -> NONE! No player went for cheaper than $${ap.price} with a higher Z-score.`);
  } else {
    console.log(`  -> Found ${betterCheaper.length} player(s) bought cheaper with higher Z-score:`);
    betterCheaper.forEach(bc => {
      const diffZ = (bc.totalZ - ap.totalZ).toFixed(2);
      console.log(`     * ${bc.name.padEnd(24)} (${bc.teamName.padEnd(10)}) - Paid $${String(bc.price).padStart(2)} (Z: ${bc.totalZ.toFixed(2)} | +${diffZ}z)`);
    });
  }
  console.log('');
});
