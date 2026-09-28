const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSVLine, parsePctWithAtt } = require('../utils/update_projections.js');

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
