const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slugFor, parseDossier, recentNotes, stub } = require('../season/dossiers.js');

const SAMPLE = [
  '# Ajay Mitchell', '',
  '## Current take', '', 'Minutes likely drop with Caruso back.', '',
  '## Notes', '',
  '### 2026-11-04 · Locked On Thunder: "Caruso\'s back"',
  'Source: sources/2026-11-04_locked-on-thunder.txt',
  'Tags: Role, minutes',
  '- **Reported:** Caruso has no minutes limit.',
  '- **Analysis:** Mitchell drops to low 20s',
  '  in minutes.',
  '',
  '### 2026-11-01 · The Athletic',
  '- **Stat:** 30 mpg in October.',
  '### 11/1 · bad heading'
].join('\n');

test('slugFor normalises names into file slugs', () => {
  assert.equal(slugFor('Luka Dončić'), 'luka-doncic');
  assert.equal(slugFor("Day'Ron Sharpe"), 'dayron-sharpe');
  assert.equal(slugFor('Robert Williams III'), 'robert-williams');
});

test('parseDossier reads take, notes, source, tags and wrapped bullets, and flags bad headings', () => {
  const d = parseDossier(SAMPLE);
  assert.equal(d.name, 'Ajay Mitchell');
  assert.equal(d.take, 'Minutes likely drop with Caruso back.');
  assert.equal(d.entries.length, 2);
  assert.deepEqual(d.entries[0].tags, ['role', 'minutes']);
  assert.equal(d.entries[0].sourceFile, 'sources/2026-11-04_locked-on-thunder.txt');
  assert.equal(d.entries[0].bullets[1], '**Analysis:** Mitchell drops to low 20s in minutes.');
  assert.equal(d.entries[1].source, 'The Athletic');
  assert.equal(d.problems.length, 1);
});

test('a fresh stub parses with no notes', () => {
  const d = parseDossier(stub('Bam Adebayo', { nbaTeam: 'MIA', pos: 'C', fantasyTeam: 'X' }));
  assert.equal(d.name, 'Bam Adebayo');
  assert.equal(d.entries.length, 0);
  assert.equal(d.problems.length, 0);
});

test('recentNotes filters by player and date, newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossiers-'));
  fs.writeFileSync(path.join(dir, 'ajay-mitchell.md'), SAMPLE);
  fs.writeFileSync(path.join(dir, 'bam-adebayo.md'), stub('Bam Adebayo'));
  const notes = recentNotes(['Ajay Mitchell', 'Bam Adebayo'], '2026-11-02', dir);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].entry.date, '2026-11-04');
  assert.equal(recentNotes(['Bam Adebayo'], '2026-01-01', dir).length, 0);
});
