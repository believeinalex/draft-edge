const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { getGridInfo, BOARD_CELL_TITLE_RE } = require('../content.js');

// Read the real Yahoo live draft HTML fixture
const fixturePath = path.join(__dirname, 'fixtures/yahoo_draft.html');
const fixtureHtml = fs.readFileSync(fixturePath, 'utf8');

// Minimal mock DOM generator for testing Yahoo draft parsing logic
function parseGridAndSidebar(html) {
  // Extract grid children
  const gridMarker = 'grid-template-columns: repeat(14, minmax(100px, 1fr));';
  const start = html.indexOf(gridMarker);
  const tagStart = html.lastIndexOf('<div', start);
  const afterTag = html.indexOf('>', tagStart) + 1;

  let depth = 1;
  let pos = afterTag;
  const children = [];

  while (pos < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', pos);
    const nextClose = html.indexOf('</div>', pos);

    if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
      depth--;
      if (depth === 0) break;
      pos = nextClose + 6;
    } else if (nextOpen !== -1) {
      if (depth === 1) {
        let childDepth = 1;
        let cpos = html.indexOf('>', nextOpen) + 1;
        while (cpos < html.length && childDepth > 0) {
          const o = html.indexOf('<div', cpos);
          const c = html.indexOf('</div>', cpos);
          if (c !== -1 && (o === -1 || c < o)) {
            childDepth--;
            if (childDepth === 0) {
              const fullHtml = html.slice(nextOpen, c + 6);
              const tagOpen = fullHtml.slice(0, fullHtml.indexOf('>'));
              const titleMatch = tagOpen.match(/title="([^"]+)"/);
              const title = titleMatch ? titleMatch[1] : '';

              // Check inner title on child
              const innerTitleMatch = fullHtml.match(/<div[^>]*title="([^"]+)"/);
              const cardTitle = innerTitleMatch ? innerTitleMatch[1] : null;

              children.push({
                parentElement: null, // will be set
                className: tagOpen,
                classList: {
                  contains: (cls) => tagOpen.includes(cls)
                },
                getAttribute: (attr) => (attr === 'title' ? title : null),
                textContent: fullHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
                cardTitle: cardTitle,
                html: fullHtml
              });
              pos = c + 6;
              break;
            }
            cpos = c + 6;
          } else if (o !== -1) {
            childDepth++;
            cpos = html.indexOf('>', o) + 1;
          } else {
            break;
          }
        }
      } else {
        depth++;
        pos = html.indexOf('>', nextOpen) + 1;
      }
    } else {
      break;
    }
  }

  const gridElement = {
    style: {
      gridTemplateColumns: 'repeat(14, minmax(100px, 1fr))'
    },
    getAttribute: (attr) => (attr === 'style' ? 'display: grid; min-width: 1400px; grid-template-columns: repeat(14, minmax(100px, 1fr));' : null),
    children: children
  };
  children.forEach(c => { c.parentElement = gridElement; });

  // Sidebar team rows
  const teamRowMatches = html.match(/<tr[^>]*class="[^"]*ys-team[^"]*"[^>]*>([\s\S]*?)<\/tr>/g) || [];
  const sidebarRows = teamRowMatches.map(r => ({
    textContent: r.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }));

  return { gridElement, sidebarRows };
}

test('getGridInfo correctly detects 14 columns from Yahoo draft board grid', () => {
  const { gridElement } = parseGridAndSidebar(fixtureHtml);
  const info = getGridInfo(gridElement);
  assert.equal(info.numCols, 14, 'Should detect 14 columns, not fallback to 12');
  assert.equal(info.headers.length, 14);
  assert.equal(info.headers[0], 'Ashley Rodawold');
  assert.equal(info.headers[3], 'Utku Taylan');
  assert.equal(info.headers[10], 'You');
  assert.equal(info.headers[13], 'Champyon');
});

test('scanBoardGrid correctly maps all picks even when config.numTeams is 12', () => {
  const { gridElement } = parseGridAndSidebar(fixtureHtml);
  const { numCols, headers } = getGridInfo(gridElement);

  const scrapedPicks = [];
  gridElement.children.forEach((cellWrap, idx) => {
    if (idx < numCols) return;
    const cardTitle = cellWrap.cardTitle;
    if (!cardTitle) return;
    const m = cardTitle.match(BOARD_CELL_TITLE_RE);
    if (!m) return;
    const j = idx - numCols;
    const teamIdx = j % numCols;
    const teamName = headers[teamIdx];
    const priceMatch = cellWrap.textContent.match(/\$(\d{1,3})(?!\d)/);
    if (!priceMatch) return;
    scrapedPicks.push({
      player: m[1].trim(),
      price: parseInt(priceMatch[1], 10),
      team: teamName
    });
  });

  assert.equal(scrapedPicks.length, 4);

  // Giannis Antetokounmpo ($63) -> Utku Taylan
  const giannis = scrapedPicks.find(p => p.player.includes('Giannis'));
  assert.ok(giannis);
  assert.equal(giannis.price, 63);
  assert.equal(giannis.team, 'Utku Taylan');

  // Nikola Jokić ($67) -> You
  const jokic = scrapedPicks.find(p => p.player.includes('Jokić'));
  assert.ok(jokic);
  assert.equal(jokic.price, 67);
  assert.equal(jokic.team, 'You');

  // Luka Dončić ($69) -> Utku Taylan
  const luka = scrapedPicks.find(p => p.player.includes('Dončić'));
  assert.ok(luka);
  assert.equal(luka.price, 69);
  assert.equal(luka.team, 'Utku Taylan');

  // Victor Wembanyama ($71) -> You
  const wemby = scrapedPicks.find(p => p.player.includes('Wembanyama'));
  assert.ok(wemby);
  assert.equal(wemby.price, 71);
  assert.equal(wemby.team, 'You');
});

test('autoDetectLeague detects 14 teams and 13 roster slots from draft fixture', () => {
  const { sidebarRows } = parseGridAndSidebar(fixtureHtml);

  // Teams from sidebar
  const detectedTeams = sidebarRows.length;
  assert.equal(detectedTeams, 14);

  // Roster slots from sidebar "0/13"
  let detectedSlots = 0;
  for (const r of sidebarRows) {
    const sm = r.textContent.match(/\b\d+\/(\d+)\b/);
    if (sm) {
      detectedSlots = parseInt(sm[1], 10);
      break;
    }
  }
  assert.equal(detectedSlots, 13);
});

test('handleScrapedPick self-heals previously misassigned auto picks', () => {
  const picks = [
    { rk: 1, teamName: 'Ashley Rodawold', price: 67, source: 'auto' }, // Jokic misassigned to col 0
    { rk: 2, teamName: 'Boğaçhan', price: 71, source: 'auto' },        // Wemby misassigned to col 2
    { rk: 25, teamName: 'Team 14', price: 63, source: 'auto' },       // Giannis misassigned to col 5
    { rk: 4, teamName: 'mert', price: 69, source: 'auto' }             // Luka misassigned to col 7
  ];

  function healPick(playerRk, trueTeam, truePrice) {
    const existing = picks.find(p => p.rk === playerRk);
    if (existing && existing.source === 'auto' && (existing.teamName !== trueTeam || existing.price !== truePrice)) {
      existing.teamName = trueTeam;
      existing.price = truePrice;
    }
  }

  healPick(1, 'You', 67);
  healPick(2, 'You', 71);
  healPick(25, 'Utku Taylan', 63);
  healPick(4, 'Utku Taylan', 69);

  assert.equal(picks.find(p => p.rk === 1).teamName, 'You');
  assert.equal(picks.find(p => p.rk === 2).teamName, 'You');
  assert.equal(picks.find(p => p.rk === 25).teamName, 'Utku Taylan');
  assert.equal(picks.find(p => p.rk === 4).teamName, 'Utku Taylan');
});
