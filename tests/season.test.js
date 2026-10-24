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

test('applyTransactions handles add/drops, two-way trades, and counts acquisitions', () => {
  const { applyTransactions } = require('../season/build_season.js');
  const mk = (name) => ({ name, rk: null, pos: ['PG'], price: 1, acquired: 'draft' });
  const teams = [
    { name: 'A', acquisitions: 0, roster: [mk('Jakob Poeltl'), mk('Kevin Love')] },
    { name: 'B', acquisitions: 0, roster: [mk('Kevin Porter Jr.')] }
  ];
  applyTransactions(teams, [
    { date: '2026-10-21 04:06', type: 'add_drop', team: 'A',
      add: [{ name: 'Santi Aldama', nbaTeam: 'DAL', pos: ['PF'], via: 'Waiver' }],
      drop: [{ name: 'Kevin Love' }] },
    { date: '2026-10-20 07:41', type: 'trade', moves: [
      { name: 'Kevin Porter Jr.', to: 'A' },
      { name: 'Jakob Poeltl', to: 'B' }
    ] }
  ]);
  assert.deepEqual(teams[0].roster.map(r => r.name).sort(), ['Kevin Porter Jr.', 'Santi Aldama']);
  assert.deepEqual(teams[1].roster.map(r => r.name), ['Jakob Poeltl']);
  assert.equal(teams[0].acquisitions, 1);
  assert.equal(teams[1].acquisitions, 0);
  assert.equal(teams[1].roster[0].acquired, 'trade');
  assert.throws(() => applyTransactions(teams, [
    { date: '2026-10-22', type: 'add_drop', team: 'B', add: [], drop: [{ name: 'Nobody Real' }] }
  ]), /not on B's roster/);
});

test('parseStatsText handles rank moves, blank positions, shooting splits and duplicate rows', () => {
  const { parseStatsText } = require('../stats/parse_stats.js');
  const text = [
    'R#\tPLAYER\tPOS\tTEAM\tGP\tMPG\tFG%\tFT%\t3PM\tPTS\tTREB\tAST\tSTL\tBLK\tTOTAL',
    '5  2\tPaolo Banchero\tPF\tORL\t1\t41.2\t0.833(10.0/12.0)\t0.750(12.0/16.0)\t3.0\t35.0\t7.0\t10.0\t1.0\t0.0\t13.37',
    '1\tAnthony Edwards\tPG,SG\tMIN\t1\t32.6\t0.552(16.0/29.0)\t0.800(4.0/5.0)\t9.0\t45.0\t10.0\t3.0\t2.0\t1.0\t18.33',
    '130  9\tTobe Awaka\t \tCHI\t1\t14.2\t1.000(1.0/1.0)\t0.000(0.0/0.0)\t0.0\t2.0\t7.0\t2.0\t1.0\t1.0\t3.23',
    '301  15\tChaney Johnson\tPF\tBKN\t2\t5.0\t0.000(0.0/1.0)\t0.000(0.0/0.0)\t0.0\t0.0\t1.0\t0.0\t0.0\t0.0\t-2.49',
    '302  14\tChaney Johnson\tPF\tBKN\t2\t5.0\t0.000(0.0/1.0)\t0.000(0.0/0.0)\t0.0\t0.0\t1.0\t0.0\t0.0\t0.0\t-2.49'
  ].join('\n');
  const { players, duplicates } = parseStatsText(text);
  assert.equal(players.length, 4);
  assert.deepEqual(duplicates, ['Chaney Johnson']);
  assert.equal(players[0].rank, 5);
  assert.equal(players[0].rankMove, 2);
  assert.equal(players[0].rankMoveSigned, false);
  assert.equal(players[0].fgm, 10);
  assert.equal(players[0].fta, 16);
  assert.equal(players[1].rankMove, null);
  assert.deepEqual(players[2].pos, []);
  assert.equal(players[3].valueTotal, -2.49);
});

test('attachSeasonStats does not fuzzy-match a different player on another team', () => {
  const { attachSeasonStats } = require('../season/build_season.js');
  const line = (name, nbaTeam, pts) => ({ name, nbaTeam, gp: 1, pts, fgm: 1, fga: 2, ftm: 1, fta: 1, tpm: 0, treb: 0, ast: 0, stl: 0, blk: 0 });
  const teams = [{ name: 'A', roster: [
    { name: 'Cameron Johnson', nbaTeam: 'DEN' },
    { name: 'Luka Dončić', nbaTeam: 'LAL' }
  ] }];
  const fa = attachSeasonStats(teams, [line('Chaney Johnson', 'BKN', 0), line('Luka Doncic', 'LAL', 28)]);
  assert.equal(teams[0].roster[0].stats, null);
  assert.equal(teams[0].roster[1].stats.pts, 28);
  assert.equal(teams[0].actualTotals.pts, 28);
  assert.deepEqual(fa.map(p => p.name), ['Chaney Johnson']);
});

test('parseLineupText reads slots, status tags, games today and a block with no team name', () => {
  const { parseLineupText } = require('../season/parse_lineups.js');
  const text = [
    'Pos', 'Player',
    'PG\t', 'Keyonte GeorgeNew Player Note', 'UTA - PG,SG',
    'Finn will cook Burt ', 'Pos', 'Player',
    'SG\t', 'Donovan MitchellPlayer Note', 'CLE - PG,SG', '7:00 pm @ PHI',
    'BN\t', 'Kevin LoveNANo new player Notes', 'UTA - PF,C',
    'IL\t', 'Jusuf NurkićONo new player Notes', 'UTA - C'
  ].join('\n');
  const blocks = parseLineupText(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].team, null);
  assert.equal(blocks[0].players[0].name, 'Keyonte George');
  assert.equal(blocks[1].team, 'Finn will cook Burt');
  assert.deepEqual(blocks[1].players.map(p => [p.slot, p.name, p.status]), [
    ['SG', 'Donovan Mitchell', null], ['BN', 'Kevin Love', 'NA'], ['IL', 'Jusuf Nurkić', 'O']
  ]);
  assert.equal(blocks[1].players[0].gameToday, '7:00 pm @ PHI');
});

test('attachLineups infers a missing team name, expands abbreviations and flags unlogged differences', () => {
  const { attachLineups } = require('../season/build_season.js');
  const r = name => ({ name });
  const nine = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'].map(r);
  const teams = [
    { name: 'Maru', roster: [r('Nickeil Alexander-Walker'), ...nine], moveLog: [] },
    { name: 'Finn', roster: [r('Malik Monk'), r('Ghost Player'), ...nine.map(p => r('F' + p.name))],
      moveLog: [{ name: 'Malik Monk', dir: 'in' }, { name: 'Kevin Love', dir: 'out' }] }
  ];
  const lp = (name, slot = 'Util') => ({ slot, name, status: null, gameToday: null });
  const issues = attachLineups(teams, { asOf: '2026-10-22', teams: [
    { team: null, players: [lp('N. Alexander-Walker'), ...nine.map(p => lp(p.name))] },
    { team: 'Finn', players: [lp('Kevin Love', 'BN'), ...nine.map(p => lp('F' + p.name))] }
  ] });
  assert.equal(teams[0].lineup.teamNameInferred, true);
  assert.equal(teams[0].roster[0].thisWeek.slot, 'Util');
  assert.deepEqual(teams[1].pendingIn, ['Malik Monk', 'Ghost Player']);
  assert.deepEqual(teams[1].pendingOut, ['Kevin Love']);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Ghost Player/);
});

test('valueReport rank-matches earned $ to draft prices and skips teams that have not played', () => {
  const { valueReport } = require('../season/value_report.js');
  const line = (rank, name, nbaTeam, valueTotal) => ({ rank, name, nbaTeam, valueTotal, gp: 1 });
  const stats = { players: [line(1, 'Cheap Star', 'BOS', 10), line(2, 'Pricey Flop', 'LAL', 1)] };
  const draft = [
    { name: 'Pricey Flop', nbaTeam: 'LAL', price: 50, team: 'A' },
    { name: 'Cheap Star', nbaTeam: 'BOS', price: 2, team: 'B' },
    { name: 'Hurt Guy', nbaTeam: 'LAL', price: 20, team: 'A' },
    { name: 'Idle Guy', nbaTeam: 'DEN', price: 30, team: 'B' }
  ];
  const roster = (team, names) => ({ name: team, roster: names.map(n => {
    const d = draft.find(x => x.name === n);
    const s = stats.players.find(p => p.name === n);
    return { name: n, nbaTeam: d.nbaTeam, acquired: 'draft', stats: s ? { rank: s.rank } : null };
  }) });
  const league = { draft, teams: [roster('A', ['Pricey Flop', 'Hurt Guy']), roster('B', ['Cheap Star', 'Idle Guy'])] };
  const { rows, waiting } = valueReport(league, stats);
  const by = n => rows.find(r => r.name === n);
  assert.equal(by('Cheap Star').earned, 50);   // best performer earns the top price
  assert.equal(by('Cheap Star').surplus, 48);
  assert.equal(by('Pricey Flop').earned, 30);  // second-best earns the second price
  assert.equal(by('Hurt Guy').earned, 0);      // team played, he didn't
  assert.deepEqual(waiting, ['Idle Guy']);     // DEN hasn't played
});

test('fetch_htb tableToText matches the pasted format, with signed rank moves and full names', () => {
  const { tableToText, formFields } = require('../stats/fetch_htb.js');
  const { parseStatsText } = require('../stats/parse_stats.js');
  const head = ['R#', 'PLAYER', 'POS', 'TEAM', 'GP', 'MPG', 'FG%', 'FT%', '3PM', 'PTS', 'TREB', 'AST', 'STL', 'BLK', 'TOTAL'];
  const shoot = (p, m, a) => `<input type="hidden" name="x" value="1" /><span class="float-start">${p}</span> <span class="float-end small">(${m}/${a})</span>`;
  const row = (rankCell, nameCell, pos) => `<tr><td> ${rankCell} </td><td>${nameCell}</td><td>${pos}</td><td>ORL</td><td>1</td><td>41.2</td>` +
    `<td>${shoot('0.833', '10.0', '12.0')}</td><td>${shoot('0.750', '12.0', '16.0')}</td>` +
    ['3.0', '35.0', '7.0', '10.0', '1.0', '0.0', '13.37'].map(v => `<td><span>${v}</span></td>`).join('') + '</tr>';
  const html = `<form><input type="hidden" name="__VIEWSTATE" value="abc" /><input type="checkbox" name="CBTO" checked="checked" />` +
    `<select name="DDSHOW"><option value="200" selected="selected">200</option><option value="900">All</option></select></form>` +
    `<table id="ContentPlaceHolder1_GridView1"><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>` +
    row('5 <span class="small text-muted"><i class="fa fa-arrow-circle-up"></i> 2</span>',
      '<a id="x_HyperLink1_0" class="d-none">Paolo Banchero</a><a id="x_HyperLinkShort_0">P.Banchero</a>', 'PF') +
    row('6 <span class="small text-muted"><i class="fa fa-arrow-circle-down"></i> 1</span>',
      '<a id="x_HyperLink1_1">Tobe Awaka</a><a id="x_HyperLinkShort_1">T.Awaka</a>', '') +
    '</table>';
  const txt = tableToText(html);
  assert.equal(txt.split('\n')[1], '5  +2\tPaolo Banchero\tPF\tORL\t1\t41.2\t0.833(10.0/12.0)\t0.750(12.0/16.0)\t3.0\t35.0\t7.0\t10.0\t1.0\t0.0\t13.37');
  const { players } = parseStatsText(txt);
  assert.deepEqual(players.map(p => [p.name, p.rankMove, p.rankMoveSigned]), [['Paolo Banchero', 2, true], ['Tobe Awaka', -1, true]]);
  assert.deepEqual(players[1].pos, []);
  const f = formFields(html);
  assert.equal(f.get('__VIEWSTATE'), 'abc');
  assert.equal(f.get('CBTO'), 'on');
  assert.equal(f.get('DDSHOW'), '200');
});

test('attachStandings scores Yahoo category totals into roto points and flags unknown teams', () => {
  const { attachStandings } = require('../season/build_season.js');
  const row = (team, pts, blk) => ({ team, yahooRank: 0, gp: 9, fgPct: 0.45, ftPct: 0.8, tpm: 10, pts, treb: 50, ast: 30, stl: 10, blk });
  const teams = [{ name: 'A' }, { name: 'B' }];
  const unknown = attachStandings(teams, { teams: [row('A', 200, 5), row('B', 150, 9), row('Ghost', 1, 1)] });
  assert.deepEqual(unknown, ['Ghost']);
  assert.equal(teams[0].realRoto.pts, 2);
  assert.equal(teams[1].realRoto.blk, 2);
  assert.equal(teams[0].realRoto.fgPct, 1.5); // tie
  assert.equal(teams[0].realRoto.total, teams[1].realRoto.total);
});

test('parseInjuries reads name, team, positions, note and status from Yahoo injury rows', () => {
  const { parseInjuries } = require('../season/fetch_injuries.js');
  const row = (name, teamPos, note, status) => `<tr><td class="player"><div><a class="Nowrap name F-link playernote" href="#" title="${name}">${name}</a>` +
    `<span class="ysf-player-status"><span>${status}</span></span></div><div>${teamPos}</div></td><td>${note}</td><td>${status}</td></tr>`;
  const html = '<table><tr><th>Player</th><th>Note</th><th>Status</th></tr>' +
    row('Cameron Johnson', 'DEN - SF,PF', 'Ankle', 'O') + row('Kristaps Porziņģis', 'GSW - C', 'Illness', 'Q') + '</table>';
  const players = parseInjuries(html);
  assert.deepEqual(players[0], { name: 'Cameron Johnson', nbaTeam: 'DEN', pos: ['SF', 'PF'], note: 'Ankle', status: 'O' });
  assert.equal(players[1].name, 'Kristaps Porziņģis');
  assert.throws(() => parseInjuries('<html></html>'), /No injury rows/);
});
