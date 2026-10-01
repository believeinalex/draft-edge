const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSVLine, parsePctWithAtt } = require('../utils/update_projections.js');
const { parsePrice, updatePrices } = require('../utils/update_prices.js');

test('parseCSVLine handles quoted and unquoted commas', () => {
  const line = 'Luka Doncic,3.6,"PG,SG",LAL,68,35.4,0.465(10.6/22.9)';
  const cols = parseCSVLine(line);
  assert.equal(cols.length, 7);
  assert.equal(cols[0], 'Luka Doncic');
  assert.equal(cols[2], 'PG,SG');
  assert.equal(cols[3], 'LAL');
});

test('parsePctWithAtt extracts percentage, makes, and attempts', () => {
  const parsed = parsePctWithAtt('0.573(10.5/18.3)');
  assert.equal(parsed.pct, 0.573);
  assert.equal(parsed.m, 10.5);
  assert.equal(parsed.a, 18.3);
});

test('parsePrice correctly strips currency symbols and handles values', () => {
  assert.equal(parsePrice('$74.60'), 74.60);
  assert.equal(parsePrice('$0.00'), 0);
  assert.equal(parsePrice(''), 0);
  assert.equal(parsePrice('-'), 0);
  assert.equal(parsePrice(' 45.5 '), 45.5);
});

test('updatePrices updates players array with maximum price across sources (excluding ESPN)', () => {
  const res = updatePrices();
  assert.ok(res.updatedCount > 250);
  const players = require('../players.js');
  const jokic = players.find(p => p.name === 'Nikola Jokic');
  assert.ok(jokic);
  assert.equal(jokic.mktCost, 75); // Math.max(74.60, 70.00) rounded = 75
});

test('normalizeNameOrder flips Last, First to First Last correctly', () => {
  const { normalizeNameOrder } = require('../utils/analyze_mock.js');
  assert.equal(normalizeNameOrder('Jackson Jr., Jaren'), 'Jaren Jackson Jr.');
  assert.equal(normalizeNameOrder('Dončić, Luka'), 'Luka Dončić');
  assert.equal(normalizeNameOrder('Nikola Jokic'), 'Nikola Jokic');
});

test('analyzeMockDraft calculates correct power rankings and surplus for mock export', () => {
  const { runAnalysisFromFile } = require('../utils/analyze_mock.js');
  const analysis = runAnalysisFromFile(require('path').join(__dirname, '../utils/mock.txt'), 'Alex');
  assert.equal(analysis.powerRankings.length, 12);
  assert.equal(analysis.targetUserTeam, 'Alex');
  assert.ok(analysis.userPicks.length === 13);
  const userRank = analysis.powerRankings.findIndex(pr => pr.teamName === 'Alex');
  assert.equal(userRank, 0); // Ranked #1 in league
});


