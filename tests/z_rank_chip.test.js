const test = require('node:test');
const assert = require('node:assert/strict');
const { injectZRankChips, getConfig, setConfig } = require('../content.js');
const { matchPlayer, buildNameIndex } = require('../engine.js');
const PLAYERS = require('../players.js');

// Simple DOM element mock
class MockElement {
  constructor(tagName = 'div', className = '', textContent = '') {
    this.tagName = tagName.toUpperCase();
    this.className = className;
    this.classList = {
      contains: (cls) => this.className.split(' ').includes(cls)
    };
    this._textContent = textContent;
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.title = '';
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map(c => c.textContent).join(' ') + (this._textContent ? ' ' + this._textContent : '');
  }

  set textContent(val) {
    this._textContent = val;
    this.children = [];
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val);
  }

  getAttribute(name) {
    return this.attributes[name] || null;
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(newChild, refChild) {
    newChild.parentElement = this;
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    }
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    if (idx > 0) return this.parentElement.children[idx - 1];
    return null;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (selector === '#de-overlay' && (curr.id === 'de-overlay' || (curr.attributes && curr.attributes.id === 'de-overlay'))) {
        return curr;
      }
      if (selector === '.ys-player' && curr.classList.contains('ys-player')) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    function traverse(node) {
      for (const child of node.children) {
        let match = false;
        if (selector === '.ys-player' && child.classList.contains('ys-player')) match = true;
        else if (selector === '.ys-player-notes' && child.classList.contains('ys-player-notes')) match = true;
        else if (selector === '.de-name-rank-badge' && child.classList.contains('de-name-rank-badge')) match = true;
        else if (selector === 'img[title]' && child.tagName === 'IMG' && child.getAttribute('title')) match = true;
        else if (selector === 'span:not([class*="de-"])' && child.tagName === 'SPAN' && !child.className.includes('de-')) match = true;
        else if (selector === 'span' && child.tagName === 'SPAN') match = true;

        if (match) results.push(child);
        traverse(child);
      }
    }
    traverse(this);
    return results;
  }
}

class MockDocument {
  constructor() {
    this.body = new MockElement('body');
  }

  createElement(tagName, className = '', textContent = '') {
    return new MockElement(tagName, className, textContent);
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.body.querySelector(selector);
  }
}

test('matchPlayer with teamHint disambiguates players with same last name', () => {
  const byNorm = buildNameIndex(PLAYERS);

  // Amen Thompson (HOU) vs Ausar Thompson (DET)
  const ausar = matchPlayer('A. Thompson', PLAYERS, byNorm, 'SG,SF,PF · DET');
  assert.ok(ausar);
  assert.equal(ausar.name, 'Ausar Thompson');
  assert.equal(ausar.team, 'DET');

  const amen = matchPlayer('A. Thompson', PLAYERS, byNorm, 'PG,SG · HOU');
  assert.ok(amen);
  assert.equal(amen.name, 'Amen Thompson');
  assert.equal(amen.team, 'HOU');

  // Without team hint falls back to first starting letter
  const defaultThompson = matchPlayer('A. Thompson', PLAYERS, byNorm);
  assert.ok(defaultThompson);
});

test('injectZRankChips attaches Z rank chip next to player name in .ys-player', () => {
  const doc = new MockDocument();
  global.document = doc;

  // Simulate a player row in the players board (e.g. Payton Pritchard, rk 91)
  const playerDiv = doc.createElement('div');
  playerDiv.className = 'ys-player';
  playerDiv.setAttribute('data-id', '1001');

  const nameWrap = doc.createElement('div');
  nameWrap.className = 'name-wrap';

  const nameSpan = doc.createElement('span', '_ys_name', 'P. Pritchard');
  const notesSpan = doc.createElement('span', 'ys-player-notes');
  notesSpan.setAttribute('data-id', '1001');

  nameWrap.appendChild(nameSpan);
  nameWrap.appendChild(notesSpan);
  playerDiv.appendChild(nameWrap);
  doc.body.appendChild(playerDiv);

  injectZRankChips();

  const badge = playerDiv.querySelector('.de-name-rank-badge');
  assert.ok(badge, 'Badge should be injected');
  assert.equal(badge.textContent, '#91');
  assert.equal(badge.title, 'Z-Score Rank #91');
  assert.equal(badge.dataset.rk, '91');

  // Verify badge is positioned before player name
  assert.equal(nameWrap.children[0], badge);
  assert.equal(nameWrap.children[1], nameSpan);
  assert.equal(nameWrap.children[2], notesSpan);

  // Re-running injectZRankChips should NOT create duplicate badges
  injectZRankChips();
  const allBadges = playerDiv.querySelectorAll('.de-name-rank-badge');
  assert.equal(allBadges.length, 1, 'Should not create duplicate badges');

  delete global.document;
});

test('injectZRankChips handles players without .ys-player wrapper via .ys-player-notes', () => {
  const doc = new MockDocument();
  global.document = doc;

  // Simulate Mikal Bridges (rk 102)
  const row = doc.createElement('div');
  row.className = 'custom-player-row';

  const nameWrap = doc.createElement('div');
  const nameSpan = doc.createElement('span', 'player-name', 'M. Bridges');
  const notesSpan = doc.createElement('span', 'ys-player-notes');

  nameWrap.appendChild(nameSpan);
  nameWrap.appendChild(notesSpan);
  row.appendChild(nameWrap);
  doc.body.appendChild(row);

  injectZRankChips();

  const badge = row.querySelector('.de-name-rank-badge');
  assert.ok(badge, 'Badge should be injected for .ys-player-notes fallback');
  assert.equal(badge.textContent, '#102');
  assert.equal(badge.dataset.rk, '102');

  delete global.document;
});

test('injectZRankChips ignores elements inside #de-overlay', () => {
  const doc = new MockDocument();
  global.document = doc;

  const overlay = doc.createElement('div');
  overlay.id = 'de-overlay';

  const playerDiv = doc.createElement('div');
  playerDiv.className = 'ys-player';
  const nameSpan = doc.createElement('span', '', 'Nikola Jokic');
  playerDiv.appendChild(nameSpan);
  overlay.appendChild(playerDiv);
  doc.body.appendChild(overlay);

  injectZRankChips();

  const badge = overlay.querySelector('.de-name-rank-badge');
  assert.equal(badge, null, 'Should not inject badges inside #de-overlay');

  delete global.document;
});

test('injectZRankChips updates existing badge when player row is recycled in virtual scroll', () => {
  const doc = new MockDocument();
  global.document = doc;

  const playerDiv = doc.createElement('div', 'ys-player');
  const nameWrap = doc.createElement('div');
  const nameSpan = doc.createElement('span', '_ys_name', 'P. Pritchard');
  const notesSpan = doc.createElement('span', 'ys-player-notes');

  nameWrap.appendChild(nameSpan);
  nameWrap.appendChild(notesSpan);
  playerDiv.appendChild(nameWrap);
  doc.body.appendChild(playerDiv);

  injectZRankChips();
  let badge = playerDiv.querySelector('.de-name-rank-badge');
  assert.equal(badge.textContent, '#91');
  assert.equal(badge.dataset.rk, '91');

  // Virtual scroll recycles row for Mikal Bridges (rk 102)
  nameSpan.textContent = 'M. Bridges';
  injectZRankChips();

  badge = playerDiv.querySelector('.de-name-rank-badge');
  assert.equal(badge.textContent, '#102');
  assert.equal(badge.dataset.rk, '102');

  delete global.document;
});

test('injectZRankChips works with img[title] and disambiguates Ausar Thompson via team text', () => {
  const doc = new MockDocument();
  global.document = doc;

  const playerDiv = doc.createElement('div', 'ys-player');
  const img = doc.createElement('img');
  img.setAttribute('title', 'A. Thompson');

  const metaDiv = doc.createElement('div', '', 'SG,SF,PF · DET');
  const nameWrap = doc.createElement('div');
  const nameSpan = doc.createElement('span', '_ys_name', 'A. Thompson');
  const notesSpan = doc.createElement('span', 'ys-player-notes');

  nameWrap.appendChild(nameSpan);
  nameWrap.appendChild(notesSpan);
  playerDiv.appendChild(img);
  playerDiv.appendChild(nameWrap);
  playerDiv.appendChild(metaDiv);
  doc.body.appendChild(playerDiv);

  injectZRankChips();

  const badge = playerDiv.querySelector('.de-name-rank-badge');
  assert.ok(badge);
  // Ausar Thompson is rk 98, Amen Thompson is rk 27
  assert.equal(badge.textContent, '#98');
  assert.equal(badge.dataset.rk, '98');

  delete global.document;
});

test('matchPlayer rejects different first name/initial even when last name matches a single player', () => {
  const byNorm = buildNameIndex(PLAYERS);

  // Thanasis Antetokounmpo (T.) should not match Giannis Antetokounmpo (G.)
  const thanasis = matchPlayer('T. Antetokounmpo', PLAYERS, byNorm, 'PF · MIL');
  assert.equal(thanasis, null, 'T. Antetokounmpo should not match Giannis');

  // Giannis Antetokounmpo should still match
  const giannisInit = matchPlayer('G. Antetokounmpo', PLAYERS, byNorm, 'PF · MIL');
  assert.ok(giannisInit);
  assert.equal(giannisInit.rk, 24);

  const giannisFull = matchPlayer('Giannis Antetokounmpo', PLAYERS, byNorm);
  assert.ok(giannisFull);
  assert.equal(giannisFull.rk, 24);
});

test('injectZRankChips removes existing badge when row is recycled for an unranked player', () => {
  const doc = new MockDocument();
  global.document = doc;

  const playerDiv = doc.createElement('div', 'ys-player');
  const nameWrap = doc.createElement('div');
  const nameSpan = doc.createElement('span', '_ys_name', 'Giannis Antetokounmpo');
  const notesSpan = doc.createElement('span', 'ys-player-notes');

  nameWrap.appendChild(nameSpan);
  nameWrap.appendChild(notesSpan);
  playerDiv.appendChild(nameWrap);
  doc.body.appendChild(playerDiv);

  injectZRankChips();
  let badge = playerDiv.querySelector('.de-name-rank-badge');
  assert.ok(badge);
  assert.equal(badge.textContent, '#24');

  // Row is recycled in virtual scroll for an unranked player (e.g. Joe Ingles or Thanasis)
  nameSpan.textContent = 'J. Ingles';
  injectZRankChips();

  badge = playerDiv.querySelector('.de-name-rank-badge');
  assert.equal(badge, null, 'Stale badge should be removed when row is recycled for unranked player');

  delete global.document;
});


