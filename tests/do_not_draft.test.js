const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { updateProjections, loadDoNotDraftList } = require('../utils/update_projections.js');
const { computeAll, checkPrice, runOptimizer, isDoNotDraft, CATS } = require('../engine.js');
const PLAYERS = require('../players.js');

const defaultState = {
  numTeams: 12,
  rosterSlots: 13,
  budget: 200,
  myTeamName: 'You',
  weights: Object.fromEntries(CATS.map(c => [c, 1])),
  picks: [],
  starterSlots: 10,
  benchWeight: 0.3
};

test('loadDoNotDraftList parses strings, objects with reasons, and {players: [...]} formats', () => {
  const tmpDndPath = path.join(__dirname, 'fixtures', 'test_dnd.json');
  const dndData = [
    "Ben Simmons",
    { "name": "Lonzo Ball", "reason": "Knee surgery rehabilitation" }
  ];
  fs.writeFileSync(tmpDndPath, JSON.stringify(dndData), 'utf8');

  try {
    const { map } = loadDoNotDraftList(tmpDndPath);
    assert.equal(map.size, 2);
    assert.ok(map.has('ben simmons'));
    assert.ok(map.has('lonzo ball'));
    assert.equal(map.get('lonzo ball').reason, 'Knee surgery rehabilitation');
  } finally {
    if (fs.existsSync(tmpDndPath)) fs.unlinkSync(tmpDndPath);
  }
});

test('updateProjections automatically drops totalZ to 0 and flags doNotDraft for DND players', () => {
  const tmpCsv = path.join(__dirname, 'fixtures', 'test_projections.csv');
  const tmpOut = path.join(__dirname, 'fixtures', 'test_players_out.js');
  const tmpDnd = path.join(__dirname, 'fixtures', 'test_dnd_list.json');

  const csvContent = [
    'R#,PLAYER,ADP,POS,TEAM,GP,MPG,FG%,FT%,3PM,PTS,TREB,AST,STL,BLK,TOTAL',
    '1,Nikola Jokic,1.9,C,DEN,72,35.1,0.573(10.5/18.3),0.816(5.6/6.8),1.8,28.4,12.7,10.4,1.6,0.7,16.48',
    '2,Victor Wembanyama,1.6,C,SA,66,30.4,0.502(9.2/18.3),0.831(5.1/6.1),2.2,25.6,11.8,3.6,1.1,3.2,14.67',
    '3,Ben Simmons,120.0,PG,BKN,40,24.0,0.550(3.0/5.5),0.450(1.0/2.2),0.0,7.0,6.5,6.0,1.0,0.5,2.15'
  ].join('\n');

  const dndContent = [
    { name: "Ben Simmons", reason: "Injury risk / limited games" }
  ];

  fs.writeFileSync(tmpCsv, csvContent, 'utf8');
  fs.writeFileSync(tmpDnd, JSON.stringify(dndContent), 'utf8');

  try {
    const updated = updateProjections(tmpCsv, tmpOut, tmpDnd);
    assert.equal(updated.length, 3);

    const jokic = updated.find(p => p.name === 'Nikola Jokic');
    assert.equal(jokic.totalZ, 16.48);
    assert.equal(jokic.doNotDraft, undefined);

    const simmons = updated.find(p => p.name === 'Ben Simmons');
    assert.ok(simmons);
    assert.equal(simmons.doNotDraft, true);
    assert.equal(simmons.totalZ, 0, 'Ben Simmons totalZ should be dropped to 0');
    assert.equal(simmons.originalTotalZ, 2.15, 'Ben Simmons originalTotalZ should be preserved');
    assert.equal(simmons.dndReason, 'Injury risk / limited games');
  } finally {
    if (fs.existsSync(tmpCsv)) fs.unlinkSync(tmpCsv);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
    if (fs.existsSync(tmpDnd)) fs.unlinkSync(tmpDnd);
  }
});

test('isDoNotDraft handles player.doNotDraft and state.doNotDraft (array, Set, case/diacritic insensitive)', () => {
  const p1 = { rk: 1, name: 'Nikola Jokić', doNotDraft: true };
  const p2 = { rk: 2, name: 'Lonzo Ball' };
  const p3 = { rk: 3, name: 'Stephen Curry' };

  // 1. Player flag
  assert.equal(isDoNotDraft(p1, {}), true);
  assert.equal(isDoNotDraft(p2, {}), false);

  // 2. State array with name string
  const stateWithArray = { doNotDraft: ['lonzo ball'] };
  assert.equal(isDoNotDraft(p2, stateWithArray), true);
  assert.equal(isDoNotDraft(p3, stateWithArray), false);

  // 3. State Set with diacritics / normalization
  const stateWithSet = new Set(['Nikola Jokic']);
  assert.equal(isDoNotDraft({ rk: 1, name: 'Nikola Jokić' }, { doNotDraft: stateWithSet }), true);

  // 4. State array with object { name, reason }
  const stateWithObjArray = { doNotDraft: [{ name: 'Stephen Curry', reason: 'Rest days' }] };
  assert.equal(isDoNotDraft(p3, stateWithObjArray), true);
});

test('checkPrice returns maxBid: 0 and doNotDraft: true for players on Do Not Draft list', () => {
  // Jokic is rk 1
  const normalJokic = checkPrice(defaultState, PLAYERS, 1);
  assert.ok(normalJokic.maxBid > 40, `Normal Jokic bid should be > 40, got ${normalJokic.maxBid}`);
  assert.equal(normalJokic.doNotDraft, undefined);

  // Now put Jokic on Do Not Draft list in state
  const dndState = Object.assign({}, defaultState, {
    doNotDraft: ['Nikola Jokic']
  });

  const dndJokic = checkPrice(dndState, PLAYERS, 1);
  assert.ok(dndJokic);
  assert.equal(dndJokic.doNotDraft, true);
  assert.equal(dndJokic.maxBid, 0, 'DND player maxBid must be 0 (pass)');
  assert.equal(dndJokic.buildBid, 0);
  assert.equal(dndJokic.breakEvenBid, 0);
});

test('runOptimizer never drafts Do Not Draft players in recommended build or dream build', () => {
  // Wemby is rk 2 (a top target)
  const dndState = Object.assign({}, defaultState, {
    doNotDraft: ['Victor Wembanyama']
  });

  const opt = runOptimizer(dndState, PLAYERS);
  assert.ok(opt);
  assert.ok(opt.players.length > 0);

  const hasWembyInBuild = opt.players.some(p => p.name === 'Victor Wembanyama');
  assert.equal(hasWembyInBuild, false, 'Wembanyama should NOT be drafted in recommended build');

  const hasWembyInDream = opt.dreamPlayers.some(p => p.name === 'Victor Wembanyama');
  assert.equal(hasWembyInDream, false, 'Wembanyama should NOT be in dream build');

  const hasWembyInSnipes = opt.snipes.some(p => p.name === 'Victor Wembanyama');
  assert.equal(hasWembyInSnipes, false, 'Wembanyama should NOT be in snipes');
});
