const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft, rotoPoints } = require('../season/build_season.js');

test('parseDraft reads Yahoo draft-results lines, including hyphenated and emoji team names', () => {
  const text = [
    '1.\tNikola Jokić (DEN - C)\t$90\tHerb\'s Astonishing Team',
    '20.\tKarl-Anthony Towns (NYK - PF,C)\t$52\tThe New Day Co-op',
    '9.\tCade Cunningham (DET - PG,SG)\t$66\tthe tinkerballers 🧚🏼‍♀️🌸🎀'
  ].join('\n');
  const { picks, unmatched } = parseDraft(text);
  assert.equal(picks.length, 3);
  assert.equal(unmatched.length, 0);
  assert.deepEqual(picks[1].pos, ['PF', 'C']);
  assert.equal(picks[1].team, 'The New Day Co-op');
  assert.equal(picks[2].team, 'the tinkerballers 🧚🏼‍♀️🌸🎀');
  assert.equal(picks[0].price, 90);
  assert.ok(picks.every(p => p.rk));
});

test('rotoPoints awards N..1 per category and splits ties', () => {
  const base = { fgPct: 0.5, ftPct: 0.8, tpm: 100, pts: 1000, treb: 500, ast: 300, stl: 80, blk: 50 };
  const teams = [
    { projTotals: { ...base, pts: 2000 } },
    { projTotals: { ...base, pts: 1500 } },
    { projTotals: { ...base, pts: 1000 } }
  ];
  rotoPoints(teams);
  assert.equal(teams[0].projRoto.pts, 3);
  assert.equal(teams[2].projRoto.pts, 1);
  assert.equal(teams[0].projRoto.fgPct, 2); // three-way tie -> (1+2+3)/3
  assert.equal(teams[0].projRank, 1);
});
