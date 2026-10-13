// Draft Edge Live Sync — content script for the Yahoo Fantasy Basketball
// live auction draft room.
//
// STATUS: verified against a live Yahoo auction draft room (2026-09-08).
// Two independent detection sources feed the same log (deduped by player):
// the "Queue" side-panel's live pick feed (fast, but Yahoo appears to clear
// its DOM history on a page refresh — good for live updates, useless for
// recovering what happened before you loaded the extension), and the
// "Board" tab's full team-by-team grid (persists everything for the whole
// draft, but only scrapable while that tab is actually open/mounted). Using
// both means a refresh mid-draft still recovers full history as long as the
// Board tab gets opened at least once. Every auto-logged pick shows up in
// the log with an "auto" tag and a one-click undo (×) in case a scrape is
// ever wrong.

(function(){
  'use strict';

  const DEFAULTS = { numTeams: 14, rosterSlots: 13, budget: 200, myTeamName: 'You', starterSlots: 9, benchWeight: 0.3 };
  const PLAYERS = typeof DRAFT_EDGE_PLAYERS !== 'undefined' ? DRAFT_EDGE_PLAYERS : (typeof require !== 'undefined' ? require('./players.js') : []);
  const _buildNameIndex = typeof buildNameIndex === 'function' ? buildNameIndex : (typeof require !== 'undefined' ? require('./engine.js').buildNameIndex : null);
  const _matchPlayer = typeof matchPlayer === 'function' ? matchPlayer : (typeof require !== 'undefined' ? require('./engine.js').matchPlayer : null);
  const _computeAll = typeof computeAll === 'function' ? computeAll : (typeof require !== 'undefined' ? require('./engine.js').computeAll : null);
  const _isDoNotDraft = typeof isDoNotDraft === 'function' ? isDoNotDraft : (typeof require !== 'undefined' ? require('./engine.js').isDoNotDraft : null);
  const _CATS = typeof CATS !== 'undefined' ? CATS : (typeof require !== 'undefined' ? require('./engine.js').CATS : ['fgPct','ftPct','tpm','pts','treb','ast','stl','blk']);
  const _CAT_LABEL = typeof CAT_LABEL !== 'undefined' ? CAT_LABEL : (typeof require !== 'undefined' ? require('./engine.js').CAT_LABEL : {});
  const nameIndex = _buildNameIndex ? _buildNameIndex(PLAYERS) : null;

  let config = Object.assign({}, DEFAULTS);
  let picks = []; // {rk, teamName, price, ts, source: 'auto'|'manual'}
  let seenSignatures = new Set();
  let weights = Object.fromEntries(_CATS.map(c=>[c,1]));
  let doNotDraft = [];

  function state(){
    return { numTeams: config.numTeams, rosterSlots: config.rosterSlots, budget: config.budget,
             myTeamName: config.myTeamName, starterSlots: config.starterSlots, benchWeight: config.benchWeight,
             weights, picks, doNotDraft };
  }

  function save(){
    if(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
      chrome.storage.local.set({ picks, seenSignatures: Array.from(seenSignatures), weights, doNotDraft });
    }
  }

  function loadThenInit(){
    if(typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['config','picks','seenSignatures','weights','doNotDraft'], (res)=>{
      config = Object.assign({}, DEFAULTS, res.config||{});
      picks = Array.isArray(res.picks) ? res.picks : [];
      seenSignatures = new Set(res.seenSignatures||[]);
      if(res.weights && typeof res.weights === 'object'){
        weights = Object.assign(Object.fromEntries(_CATS.map(c=>[c,1])), res.weights);
      }
      doNotDraft = Array.isArray(res.doNotDraft) ? res.doNotDraft : [];
      buildOverlay();
      render();
      startObserving();
    });
  }

  if(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged){
    chrome.storage.onChanged.addListener((changes, area)=>{
      if(area!=='local') return;
      let dirty = false;
      if(changes.config){ config = Object.assign({}, DEFAULTS, changes.config.newValue||{}); dirty = true; }
      if(changes.picks){ picks = Array.isArray(changes.picks.newValue) ? changes.picks.newValue : []; dirty = true; }
      if(changes.weights){ weights = Object.assign(Object.fromEntries(_CATS.map(c=>[c,1])), changes.weights.newValue||{}); dirty = true; }
      if(changes.doNotDraft){ doNotDraft = Array.isArray(changes.doNotDraft.newValue) ? changes.doNotDraft.newValue : []; dirty = true; }
      if(dirty) render();
    });
  }

  /* ---------------------------------------------------------------------
   * 1. Pick logging (shared by auto-detect and the manual check/log field)
   * ------------------------------------------------------------------- */
  function logPick(rk, teamName, price, source){
    if(picks.some(p=>p.rk===rk)) return false; // already logged
    teamName = normalizeTeamName(teamName);
    picks.push({ rk, teamName, price: clamp(Math.round(price),1,999), ts: Date.now(), source });
    save();
    render(true);
    return true;
  }
  function undoPick(rk){
    picks = picks.filter(p=>p.rk!==rk);
    save();
    render();
  }
  function normalizeTeamName(raw){
    const t = (raw||'').trim().replace(/\s+/g,' ');
    if(!t) return 'Unknown team';
    if(config.myTeamName){
      const tLower = t.toLowerCase();
      const myLower = config.myTeamName.toLowerCase();
      if(tLower === myLower || tLower === 'you'){
        return config.myTeamName;
      }
    }
    return t;
  }
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

  /* ---------------------------------------------------------------------
   * 2. Pick detection adapter — verified against a live Yahoo auction draft
   *    room (2026-09-08 mock). Yahoo's build uses hashed/atomic CSS class
   *    names everywhere EXCEPT one plain, unhashed class: `.ys-player`, used
   *    on every player entry across the app (draft board, roster grid, and
   *    the "Queue" side panel's live pick feed). Each carries a stable
   *    `data-id` = Yahoo's own internal player id, and an `img[title]` with
   *    the player's name (Yahoo's own display abbreviation, e.g.
   *    "N. Jokić" — matchPlayer()'s last-name + first-initial fallback
   *    handles that).
   *
   *    A completed-pick entry in the Queue feed has this shape:
   *      <div>                                   <- row
   *        <span>$66</span>                       <- price
   *        <div>                                  <- wrap
   *          <span>Law</span>                      <- winning team's display name
   *          <div class="ys-player" data-id="...">  <- player
   *            ...<img title="V. Wembanyama">...
   *            ...<abbr title="Center">C</abbr>...
   *            ...<abbr title="San Antonio Spurs">SAS</abbr>...
   *          </div>
   *        </div>
   *      </div>
   *    `.ys-player` also appears WITHOUT a preceding team-name sibling in a
   *    couple of other widgets (the "Last: <player>" summary header, and —
   *    if the Players/Board tab ever renders concurrently — the full player
   *    pool list). Requiring a non-empty, non-"$" previousElementSibling is
   *    what filters those out; if Yahoo ships a redesign that breaks this,
   *    the symptom is "nothing gets auto-logged" rather than bad data, since
   *    a failed match/price-parse is just skipped, never guessed at.
   * ------------------------------------------------------------------- */

  function scanForPicks(){
    const nodes = document.querySelectorAll('.ys-player[data-id]');
    let nominationDiv = null;
    nodes.forEach(playerDiv=>{
      const teamEl = playerDiv.previousElementSibling;
      const teamNameRaw = teamEl ? teamEl.textContent.trim() : '';
      if(teamEl && teamNameRaw && !teamNameRaw.startsWith('$')){
        const img = playerDiv.querySelector('img[title]');
        const nameSpan = playerDiv.querySelector('span:not([class*="de-"])');
        const rawName = img ? img.getAttribute('title') : (nameSpan ? nameSpan.textContent.trim() : null);
        if(!rawName) return;
        // price sits one level further up: playerDiv -> wrap div -> row div
        const wrap = playerDiv.parentElement;
        const row = wrap ? wrap.parentElement : null;
        const rowText = (row && row.textContent) || (wrap && wrap.textContent) || '';
        const priceMatch = rowText.match(/\$(\d{1,3})(?!\d)/);
        if(!priceMatch) return;
        const price = parseInt(priceMatch[1],10);
        const dataId = playerDiv.getAttribute('data-id');
        handleScrapedPick(rawName, price, teamNameRaw, dataId, playerDiv.textContent);
        return;
      }
      // No team-name sibling: either the "Last:" summary widget, or the
      // current up-for-auction nomination widget (identified by a nearby
      // "Max Offer $" string within a few ancestor levels).
      let up = playerDiv;
      for(let i=0;i<6 && up; i++){
        if(/Max Offer/.test(up.textContent||'')){ nominationDiv = playerDiv; break; }
        up = up.parentElement;
      }
    });
    return nominationDiv;
  }

  // Helper to dynamically inspect board grid columns and headers.
  // Yahoo dynamically defines columns using CSS grid: repeat(N, minmax(100px, 1fr))
  // where N matches the league size (14 teams, 12 teams, etc.).
  function getGridInfo(grid){
    let numCols = 0;
    const inlineStyle = (grid.style && grid.style.gridTemplateColumns) || (typeof grid.getAttribute === 'function' ? grid.getAttribute('style') : '') || '';
    const repeatMatch = inlineStyle.match(/repeat\(\s*(\d+)/i);
    if(repeatMatch){
      numCols = parseInt(repeatMatch[1], 10);
    } else if(typeof window !== 'undefined' && window.getComputedStyle){
      try {
        const comp = window.getComputedStyle(grid).gridTemplateColumns || '';
        const repComp = comp.match(/repeat\(\s*(\d+)/i);
        if(repComp){
          numCols = parseInt(repComp[1], 10);
        } else {
          const parts = comp.trim().split(/\s+/).filter(Boolean);
          if(parts.length > 1) numCols = parts.length;
        }
      } catch(e){}
    }

    if(!numCols || numCols <= 0){
      let count = 0;
      for(let i = 0; i < grid.children.length; i++){
        const c = grid.children[i];
        const isSticky = c && (
          (c.classList && c.classList.contains('Pos(st)')) ||
          (c.className && typeof c.className === 'string' && c.className.indexOf('Pos(st)') !== -1)
        );
        if(isSticky){
          count++;
        } else {
          break;
        }
      }
      if(count > 0) numCols = count;
    }

    if(!numCols || numCols <= 0){
      const sidebarCount = document.querySelectorAll('tr.ys-team, .ys-team[data-id]').length;
      if(sidebarCount > 0) numCols = sidebarCount;
    }

    if(!numCols || numCols <= 0){
      numCols = config.numTeams || 14;
    }

    const headers = [];
    for(let i = 0; i < numCols && i < grid.children.length; i++){
      const h = grid.children[i];
      const name = (h.textContent||'').trim() || (typeof h.getAttribute === 'function' ? h.getAttribute('title') : '') || `Team ${i+1}`;
      headers.push(name);
    }

    return { numCols, headers };
  }

  // ---- Board-tab grid: the persistent, full-history source. Structure
  // (verified live): a flat container of [numCols header cells] followed by
  // [numCols * rosterSlots player-slot cells] in ROW-MAJOR order (round 1
  // for every team, then round 2 for every team, ...). Each filled slot's
  // player card carries a `title` attribute of the exact shape
  // "Full Player Name, TEAM-POS, " — unlike the Queue feed this gives the
  // real (non-abbreviated) name and needs no img/abbr digging.
  const BOARD_CELL_TITLE_RE = /^(.+),\s*([A-Za-z]{2,4})-([A-Za-z\/]+),\s*$/;
  function scanBoardGrid(){
    const titleDivs = document.querySelectorAll('div[title]');
    titleDivs.forEach(div=>{
      const title = div.getAttribute('title')||'';
      const m = title.match(BOARD_CELL_TITLE_RE);
      if(!m) return;
      const cellWrap = div.parentElement;
      const grid = cellWrap ? cellWrap.parentElement : null;
      if(!grid) return;
      const { numCols, headers } = getGridInfo(grid);
      const idx = Array.prototype.indexOf.call(grid.children, cellWrap);
      if(idx < numCols) return; // it's a header cell, not a player slot
      const j = idx - numCols;
      const teamIdx = j % numCols;
      const teamName = headers[teamIdx];
      if(!teamName) return;
      const priceMatch = cellWrap.textContent.match(/\$(\d{1,3})(?!\d)/);
      if(!priceMatch) return;
      handleScrapedPick(m[1].trim(), parseInt(priceMatch[1],10), teamName, null);
    });
  }

  function autoDetectLeague(){
    let detectedTeams = 0;
    const grid = document.querySelector('div[style*="grid-template-columns"]');
    if(grid){
      const info = getGridInfo(grid);
      if(info.numCols >= 4 && info.numCols <= 30) detectedTeams = info.numCols;
    }
    if(!detectedTeams || detectedTeams <= 0){
      const sidebarTeams = document.querySelectorAll('tr.ys-team, .ys-team[data-id]');
      if(sidebarTeams.length >= 4 && sidebarTeams.length <= 30){
        detectedTeams = sidebarTeams.length;
      }
    }

    let detectedSlots = 0;
    const teamRows = document.querySelectorAll('tr.ys-team');
    for(let r of teamRows){
      const text = r.textContent || '';
      const sm = text.match(/\b\d+\/(\d+)\b/);
      if(sm){
        const val = parseInt(sm[1], 10);
        if(val >= 5 && val <= 25){
          detectedSlots = val;
          break;
        }
      }
    }

    let changed = false;
    if(detectedTeams && detectedTeams !== config.numTeams){
      config.numTeams = detectedTeams;
      changed = true;
    }
    if(detectedSlots && detectedSlots !== config.rosterSlots){
      config.rosterSlots = detectedSlots;
      changed = true;
    }
    if(changed){
      if(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
        chrome.storage.local.set({ config });
      }
      render();
    }
  }

  let lastAutoNominatedId = null;
  function syncNomination(nominationDiv){
    if(!nominationDiv) return;
    const dataId = nominationDiv.getAttribute('data-id');
    if(dataId === lastAutoNominatedId) return;
    const img = nominationDiv.querySelector('img[title]');
    const nameSpan = nominationDiv.querySelector('span:not([class*="de-"])');
    const rawName = img ? img.getAttribute('title') : (nameSpan ? nameSpan.textContent.trim() : null);
    if(!rawName) return;
    const matcher = _matchPlayer || matchPlayer;
    const player = matcher(rawName, PLAYERS, nameIndex, nominationDiv.textContent);
    if(!player || picks.some(p=>p.rk===player.rk)) return;
    lastAutoNominatedId = dataId;
    if(!els.search) return;
    els.search.value = player.name;
    els.results.classList.remove('open');
    renderCheck(player.rk, true);
  }

  // Last-resort fallback if `.ys-player` ever disappears (Yahoo redesign):
  // player-profile links + a nearby "$NNN" + leftover row text as team name.
  const PLAYER_LINK_RE = /\/(nba\/)?players?\//i;
  function genericScan(root){
    if(document.querySelector('.ys-player[data-id]')) return; // primary adapter is working, skip
    const links = root.querySelectorAll ? root.querySelectorAll('a[href*="player"]') : [];
    links.forEach(a=>{
      if(!PLAYER_LINK_RE.test(a.getAttribute('href')||'')) return;
      const rawName = a.textContent.trim();
      if(!rawName || rawName.length>40) return;
      let row = a.closest('tr, li, [role="listitem"], .row') || a.parentElement;
      let hops = 0;
      while(row && hops<4 && !/\$\s?\d/.test(row.textContent)){ row = row.parentElement; hops++; }
      if(!row) return;
      const text = row.textContent.replace(/\s+/g,' ').trim();
      const priceMatch = text.match(/\$\s?(\d{1,3})(?!\d)/);
      if(!priceMatch) return;
      let leftover = text.replace(rawName, '').replace(priceMatch[0], '').trim();
      leftover = leftover.replace(/[|•·,-]+/g,' ').replace(/\s+/g,' ').trim();
      const teamGuess = leftover.split(' ').slice(0,4).join(' ');
      handleScrapedPick(rawName, parseInt(priceMatch[1],10), teamGuess, null, text);
    });
  }

  function handleScrapedPick(rawName, price, teamGuess, dataId, teamHint){
    if(!rawName || !isFinite(price) || price<=0) return;
    const matcher = _matchPlayer || matchPlayer;
    const player = matcher(rawName, PLAYERS, nameIndex, teamHint);
    if(!player) return; // unmatched — left for the manual field to log, not guessed at
    const normTeam = normalizeTeamName(teamGuess);
    const existing = picks.find(p=>p.rk===player.rk);
    if(existing){
      // Self-heal previously misassigned auto picks (e.g. from an earlier incorrect team count)
      if(existing.source==='auto' && (existing.teamName!==normTeam || existing.price!==price)){
        existing.teamName = normTeam;
        existing.price = price;
        const sig = (dataId || player.rk) + '|' + price + '|' + normTeam;
        seenSignatures.add(sig);
        save();
        render(true);
      }
      return;
    }
    const sig = (dataId || player.rk) + '|' + price + '|' + normTeam;
    if(seenSignatures.has(sig)) return;
    seenSignatures.add(sig);
    logPick(player.rk, teamGuess, price, 'auto');
  }

  /* ---------------------------------------------------------------------
   * 2b. In-page player Z-Rank chip injection (Players board / Draft room)
   * ------------------------------------------------------------------- */
  let isInjectingChips = false;
  function injectZRankChips(){
    if(isInjectingChips) return;
    if(typeof document === 'undefined') return;
    if(!PLAYERS || !PLAYERS.length) return;
    const matcher = _matchPlayer || (typeof matchPlayer === 'function' ? matchPlayer : null);
    if(!matcher) return;

    isInjectingChips = true;
    try {
      const compute = _computeAll || (typeof computeAll === 'function' ? computeAll : null);
      const C = compute ? compute(state(), PLAYERS) : { zRankMap: new Map() };
      const zRankMap = C.zRankMap || new Map();

      // 1. Process all .ys-player elements across the page (players table, nomination widget, etc.)
      const playerDivs = document.querySelectorAll('.ys-player');
      playerDivs.forEach(playerDiv => {
        if(playerDiv.closest && playerDiv.closest('#de-overlay')) return;

        const img = playerDiv.querySelector('img[title]');
        const notes = playerDiv.querySelector('.ys-player-notes');
        const nameEl = (notes && notes.previousElementSibling) || playerDiv.querySelector('span:not([class*="de-"])');
        const rawName = (img && img.getAttribute('title')) || (nameEl ? nameEl.textContent.trim() : null);
        if(!rawName){
          const existing = playerDiv.querySelector('.de-name-rank-badge');
          if(existing && existing.remove) existing.remove();
          return;
        }

        const teamHint = playerDiv.textContent || '';
        const player = matcher(rawName, PLAYERS, nameIndex, teamHint);
        if(!player){
          const existing = playerDiv.querySelector('.de-name-rank-badge');
          if(existing && existing.remove) existing.remove();
          return;
        }

        const zRank = (zRankMap && zRankMap.get(player.rk)) || player.rk;
        const targetAnchor = nameEl || notes;
        if(targetAnchor){
          const isDnd = _isDoNotDraft ? _isDoNotDraft(player, state()) : (player.doNotDraft || false);
          attachOrUpdateBadge(playerDiv, targetAnchor, player.rk, zRank, isDnd);
        }
      });

      // 2. Also check .ys-player-notes elements in case any player row in the players board doesn't have an outer .ys-player
      const notesEls = document.querySelectorAll('.ys-player-notes');
      notesEls.forEach(notes => {
        if(notes.closest && notes.closest('#de-overlay')) return;
        const parent = notes.parentElement;
        if(!parent) return;

        const outerPlayer = notes.closest ? notes.closest('.ys-player') : null;
        if(outerPlayer && outerPlayer.querySelector('.de-name-rank-badge')) return;

        const nameEl = notes.previousElementSibling;
        if(!nameEl){
          const existing = parent.querySelector('.de-name-rank-badge');
          if(existing && existing.remove) existing.remove();
          return;
        }
        const rawName = nameEl.textContent.trim();
        if(!rawName){
          const existing = parent.querySelector('.de-name-rank-badge');
          if(existing && existing.remove) existing.remove();
          return;
        }

        const teamHint = (parent.parentElement && parent.parentElement.textContent) || parent.textContent || '';
        const player = matcher(rawName, PLAYERS, nameIndex, teamHint);
        if(!player){
          const existing = parent.querySelector('.de-name-rank-badge');
          if(existing && existing.remove) existing.remove();
          return;
        }

        const zRank = (zRankMap && zRankMap.get(player.rk)) || player.rk;
        const isDnd = _isDoNotDraft ? _isDoNotDraft(player, state()) : (player.doNotDraft || false);
        attachOrUpdateBadge(parent, nameEl, player.rk, zRank, isDnd);
      });
    } finally {
      isInjectingChips = false;
    }
  }

  function attachOrUpdateBadge(container, anchorEl, rk, zRank, isDnd){
    if(!container || !anchorEl) return;
    const existing = container.querySelector('.de-name-rank-badge');
    const badgeText = isDnd ? `#${zRank} ⛔` : '#' + zRank;
    const badgeTitle = isDnd ? `Z-Score Rank #${zRank} (DO NOT DRAFT)` : `Z-Score Rank #${zRank}`;
    const badgeClass = isDnd ? 'de-name-rank-badge de-dnd-chip' : 'de-name-rank-badge';

    if(existing){
      if(existing.textContent !== badgeText || existing.dataset.rk !== String(rk) || existing.className !== badgeClass){
        existing.className = badgeClass;
        existing.textContent = badgeText;
        existing.title = badgeTitle;
        existing.dataset.rk = String(rk);
      }
      return;
    }

    const badge = document.createElement('span');
    badge.className = badgeClass;
    badge.textContent = badgeText;
    badge.title = badgeTitle;
    badge.dataset.rk = String(rk);

    if(anchorEl.parentElement){
      anchorEl.parentElement.insertBefore(badge, anchorEl);
    }
  }

  let observer = null;
  function runAllScans(){
    autoDetectLeague();
    const nominationDiv = scanForPicks();
    scanBoardGrid();
    genericScan(document.body);
    syncNomination(nominationDiv);
    injectZRankChips();
  }
  function startObserving(){
    if(observer) return;
    // one full pass over whatever's already on the page (rejoining a draft
    // already in progress shouldn't require waiting for the next pick —
    // this is also what recovers full history from the Board tab if it's
    // already open when the extension loads)
    runAllScans();
    observer = new MutationObserver((mutations)=>{
      if(isInjectingChips) return;
      if(mutations && mutations.length){
        const allOurs = mutations.every(m => {
          if(!m.addedNodes || !m.addedNodes.length) return false;
          return Array.prototype.every.call(m.addedNodes, n => {
            return n.nodeType === 1 && (
              (n.classList && n.classList.contains('de-name-rank-badge')) ||
              (n.querySelector && n.querySelector('.de-name-rank-badge'))
            );
          });
        });
        if(allOurs) return;
      }
      runAllScans();
    });
    observer.observe(document.body, { childList:true, subtree:true });
  }

  /* ---------------------------------------------------------------------
   * 3. Overlay UI
   * ------------------------------------------------------------------- */
  let els = {};
  function buildOverlay(){
    if(document.getElementById('de-overlay')) return;
    const root = document.createElement('div');
    root.id = 'de-overlay';
    root.innerHTML = `
      <div class="de-head" id="deHead">
        <span class="de-dot" id="deDot"></span>
        <b>Draft Edge</b>
        <span class="de-badge" id="deUnmatched" title="Auto-detected rows that didn't match a player in the pool"></span>
        <button class="de-btn" id="deCollapse">–</button>
      </div>
      <div class="de-body" id="deBody">
        <div class="de-stats">
          <div class="de-stat"><div class="l">Budget</div><div class="v accent" id="deBudget">$—</div></div>
          <div class="de-stat"><div class="l">Slots</div><div class="v" id="deSlots">—</div></div>
          <div class="de-stat"><div class="l">Inflation</div><div class="v" id="deInflation">—</div></div>
        </div>
        <div id="dePosAlert"></div>

        <h2>Check / log a player</h2>
        <div class="de-manual-results">
          <input type="search" id="dePlayerSearch" placeholder="Type a name…" autocomplete="off">
          <div class="de-mr-list" id="dePlayerResults"></div>
        </div>
        <div id="deCheckResult"></div>

        <div class="de-punt-hdr">
          <h2>Punt strategy &amp; category weights</h2>
          <button class="de-btn" id="deResetWeights" title="Reset all category weights to 1.0">Reset 1x</button>
        </div>
        <div id="dePuntGrid" class="de-punt-grid"></div>

        <h2>Team optimizer <span style="text-transform:none; letter-spacing:0; font-weight:400;">best possible build, right now</span></h2>
        <button class="de-btn" id="deRunOptimizer" style="width:100%;">Build best possible team</button>
        <div id="deOptimizerResult"></div>

        <h2>Power rankings <span style="text-transform:none; letter-spacing:0; font-weight:400;" id="dePowerNote"></span></h2>
        <div id="dePower"></div>

        <h2>Draft log</h2>
        <div id="deLog"></div>
      </div>
    `;
    document.documentElement.appendChild(root);
    els = {
      root, head: root.querySelector('#deHead'), dot: root.querySelector('#deDot'),
      collapse: root.querySelector('#deCollapse'), body: root.querySelector('#deBody'),
      budget: root.querySelector('#deBudget'), slots: root.querySelector('#deSlots'),
      inflation: root.querySelector('#deInflation'), posAlert: root.querySelector('#dePosAlert'),
      search: root.querySelector('#dePlayerSearch'), results: root.querySelector('#dePlayerResults'),
      checkResult: root.querySelector('#deCheckResult'), power: root.querySelector('#dePower'),
      powerNote: root.querySelector('#dePowerNote'), log: root.querySelector('#deLog'),
      unmatched: root.querySelector('#deUnmatched'),
      puntGrid: root.querySelector('#dePuntGrid'), resetWeightsBtn: root.querySelector('#deResetWeights'),
      runOptimizerBtn: root.querySelector('#deRunOptimizer'), optimizerResult: root.querySelector('#deOptimizerResult'),
    };
    wireOverlay();
  }

  function wireOverlay(){
    els.collapse.addEventListener('click', ()=>{
      els.root.classList.toggle('de-collapsed');
      els.collapse.textContent = els.root.classList.contains('de-collapsed') ? '+' : '–';
    });
    makeDraggable(els.root, els.head);

    els.resetWeightsBtn.addEventListener('click', ()=>{
      weights = Object.fromEntries(CATS.map(c=>[c,1]));
      save();
      render();
    });

    let activeIdx = -1;
    els.search.addEventListener('input', ()=>{
      const q = els.search.value.trim().toLowerCase();
      if(q.length<2){ els.results.classList.remove('open'); els.results.innerHTML=''; return; }
      const draftedRks = new Set(picks.map(p=>p.rk));
      const matches = PLAYERS.filter(p=>!draftedRks.has(p.rk) && p.name.toLowerCase().includes(q)).slice(0,12);
      const C_search = computeAll(state(), PLAYERS);
      activeIdx = -1;
      els.results.innerHTML = matches.length
        ? matches.map(p=> {
            const zR = (C_search.zRankMap && C_search.zRankMap.get(p.rk)) || p.rk;
            return `<div class="de-mr-item" data-rk="${p.rk}"><span class="de-name-rank-badge">#${zR}</span>${escapeHtml(p.name)} <span style="color:#8a93a5;">${p.pos.join('/')} · ${p.team||'FA'}</span></div>`;
          }).join('')
        : `<div class="de-mr-item" style="cursor:default; color:#8a93a5;">No undrafted match</div>`;
      els.results.classList.add('open');
      els.results.querySelectorAll('.de-mr-item[data-rk]').forEach(item=>{
        item.addEventListener('click', ()=>selectPlayer(parseInt(item.dataset.rk,10)));
      });
    });
    els.search.addEventListener('keydown', (e)=>{
      if(e.key==='Escape'){ els.results.classList.remove('open'); }
    });
    document.addEventListener('click', (e)=>{
      if(!els.results.contains(e.target) && e.target!==els.search) els.results.classList.remove('open');
    });

    els.runOptimizerBtn.addEventListener('click', renderOptimizer);
  }

  function renderOptimizer(){
    const opt = runOptimizer(state(), PLAYERS);
    const box = els.optimizerResult;
    if(opt.full){ box.innerHTML = `<div class="de-empty">Your roster is already full.</div>`; return; }
    if(opt.infeasible){ box.innerHTML = `<div class="de-empty">No feasible build — you need ~$${opt.slotsLeft} minimum ($1/slot) for ${opt.slotsLeft} open slots but only have $${opt.budgetLeft} left.</div>`; return; }
    const posStrip = opt.posCoverage.map(pc=>`<span class="de-poschip ${pc.covered?'ok':'bad'}">${pc.pos}</span>`).join('');
    const C_opt = computeAll(state(), PLAYERS);
    const monopolyBanner = opt.isMonopoly
      ? `<div class="de-monopoly-banner">👑 <b>Endgame Monopoly</b> — Your $${opt.budgetLeft} budget covers the absolute best ${opt.slotsLeft}-player finish regardless of money (max opp bid: $${opt.maxOppBid}). Nominate your top Dream targets &amp; pass on everyone else!</div>`
      : (opt.budgetLeft <= opt.slotsLeft
          ? `<div class="de-monopoly-banner">💵 <b>$1/Slot Endgame</b> — Nominate from your optimal $1 targets below (sorted highest value first) to lock them in uncontested at $1.</div>`
          : '');
    const rows = opt.players.map(p=> {
      const zR = (C_opt.zRankMap && C_opt.zRankMap.get(p.rk)) || p.rk;
      const starHtml = (opt.isEndgame && p.inDreamBuild) ? `<span class="de-dream-star" title="In Dream Build (Best Team Regardless of $)">★</span>` : '';
      const costHtml = (p.fairPrice && p.cost < p.fairPrice)
        ? `<span class="de-opt-cost de-snipe-market"><s>$${p.fairPrice}</s></span><span class="de-opt-cost de-snipe-cost">$${p.cost}</span>`
        : `<span class="de-opt-cost">$${p.cost}</span>`;
      return `<div class="de-opt-row"><span><span class="de-name-rank-badge">#${zR}</span>${starHtml}${escapeHtml(p.name)}<span class="de-opt-meta">${p.pos.join('/')} · ${p.team||'FA'}</span></span><span class="de-opt-right">${costHtml}<span class="de-opt-z">${p.z.toFixed(2)}z</span></span></div>`;
    }).join('');

    const dreamRows = (!opt.isMonopoly && opt.dreamPlayers && opt.dreamPlayers.length > 0)
      ? opt.dreamPlayers.map(dp => {
          const zR = (C_opt.zRankMap && C_opt.zRankMap.get(dp.rk)) || dp.rk;
          const upgTag = !dp.inBudgetBuild ? `<span class="de-dream-upg-tag">UPGRADE</span>` : '';
          const costHtml = (dp.fairPrice && dp.cost < dp.fairPrice)
            ? `<span class="de-opt-cost de-snipe-market"><s>$${dp.fairPrice}</s></span><span class="de-opt-cost">$${dp.cost}</span>`
            : `<span class="de-opt-cost">$${dp.fairPrice || dp.cost}</span>`;
          return `<div class="de-opt-row ${!dp.inBudgetBuild ? 'de-dream-row' : ''}"><span><span class="de-name-rank-badge">#${zR}</span>${escapeHtml(dp.name)}${upgTag}<span class="de-opt-meta">${dp.pos.join('/')} · ${dp.team||'FA'}</span></span><span class="de-opt-right">${costHtml}<span class="de-opt-z">${dp.z.toFixed(2)}z</span></span></div>`;
        }).join('')
      : '';
    const dreamSection = dreamRows
      ? `<div class="de-dream-header">✨ Dream Build (Regardless of $) <span class="de-snipe-subtitle">+${Math.max(0, opt.dreamVal - opt.bestVal).toFixed(2)}z · eff $${opt.dreamTotalCost} (mkt $${opt.dreamMarketCost})</span></div><div class="de-opt-list de-dream-list">${dreamRows}</div>`
      : '';

    const baitRows = (!opt.isMonopoly && opt.baitPlayers && opt.baitPlayers.length > 0)
      ? opt.baitPlayers.map(b => {
          const zR = (C_opt.zRankMap && C_opt.zRankMap.get(b.rk)) || b.rk;
          return `<div class="de-opt-row de-bait-row"><span><span class="de-name-rank-badge">#${zR}</span>${escapeHtml(b.name)}<span class="de-opt-meta">${b.pos.join('/')} · ${b.team||'FA'}</span></span><span class="de-opt-right"><span class="de-opt-cost">mkt $${b.fairPrice}</span><span class="de-opt-z">${b.z.toFixed(2)}z</span></span></div>`;
        }).join('')
      : '';
    const baitSection = baitRows
      ? `<div class="de-bait-header">🪤 Bait nominations <span class="de-snipe-subtitle">not in your builds — drain opponents (max opp $${opt.maxOppBid})</span></div><div class="de-opt-list de-bait-list">${baitRows}</div>`
      : '';

    const snipeRows = (opt.snipes && opt.snipes.length > 0)
      ? opt.snipes.map(s => {
          const zR = (C_opt.zRankMap && C_opt.zRankMap.get(s.rk)) || s.rk;
          return `<div class="de-opt-row de-snipe-row"><span><span class="de-name-rank-badge">#${zR}</span>${escapeHtml(s.name)}<span class="de-opt-meta">${s.pos.join('/')} · ${s.team||'FA'}</span></span><span class="de-opt-right"><span class="de-opt-cost de-snipe-market"><s>$${s.fairPrice}</s></span><span class="de-opt-cost de-snipe-cost">$${s.snipeCost}</span><span class="de-opt-z">${s.compositeZ.toFixed(2)}z</span></span></div>`;
        }).join('')
      : '';
    const snipeSection = snipeRows
      ? `<div class="de-snipe-header">🎯 Snipe targets <span class="de-snipe-subtitle">opponents can't outbid you</span></div><div class="de-opt-list de-snipe-list">${snipeRows}</div>`
      : '';
    box.innerHTML = `
      ${opt.posWarning ? `<div class="de-alert">${escapeHtml(opt.posWarning)}</div>` : ''}
      ${monopolyBanner}
      <div class="de-poscoverage">${posStrip}</div>
      <div class="de-opt-list">${rows}</div>
      ${dreamSection}
      ${baitSection}
      ${snipeSection}
      <div class="de-opt-summary">Fill: ${opt.bestVal.toFixed(2)}z for $${opt.totalCost} of $${opt.budgetLeft} left across ${opt.slotsLeft} slots. Whole team incl. drafted: <b>${(opt.existingZ+opt.bestVal).toFixed(2)}z</b>.</div>
    `;
  }

  function getHashtagStyle(z){
    if(typeof z !== 'number' || !isFinite(z)) return 'background:#222834; color:#e9ecf1;';
    if(z >= 2.0) return 'background:#1f9d55; color:#ffffff; font-weight:700;';
    if(z >= 1.0) return 'background:#38c172; color:#ffffff; font-weight:600;';
    if(z >= 0.25) return 'background:#a8e6a1; color:#1a1f27; font-weight:500;';
    if(z > -0.25) return 'background:#ffffff; color:#1a1f27; font-weight:400;';
    if(z > -1.0) return 'background:#f8d7da; color:#1a1f27; font-weight:500;';
    if(z > -2.0) return 'background:#e3342f; color:#ffffff; font-weight:600;';
    return 'background:#b71c1c; color:#ffffff; font-weight:700;';
  }

  function renderStatBreakdownTable(p, zc){
    if(!p || !zc) return '';
    const ths = `<th>TYPE</th><th>FG%</th><th>FT%</th><th>3PM</th><th>PTS</th><th>TREB</th><th>AST</th><th>STL</th><th>BLK</th>`;

    let tds = `<td class="type-cell">2026-27 Proj</td>`;
    
    // FG%
    const fgZ = zc.fgPct || 0;
    const fgVal = p.fgPct !== undefined ? p.fgPct.toFixed(3) : '-';
    const fgAtt = (p.fgm && p.fga) ? `<div class="de-att">(${p.fgm}/${p.fga})</div>` : '';
    tds += `<td style="${getHashtagStyle(fgZ)}">${fgVal}${fgAtt}</td>`;

    // FT%
    const ftZ = zc.ftPct || 0;
    const ftVal = p.ftPct !== undefined ? p.ftPct.toFixed(3) : '-';
    const ftAtt = (p.ftm && p.fta) ? `<div class="de-att">(${p.ftm}/${p.fta})</div>` : '';
    tds += `<td style="${getHashtagStyle(ftZ)}">${ftVal}${ftAtt}</td>`;

    // Counting stats
    const countCats = [
      { key: 'tpm', val: p.tpm },
      { key: 'pts', val: p.pts },
      { key: 'treb', val: p.treb },
      { key: 'ast', val: p.ast },
      { key: 'stl', val: p.stl },
      { key: 'blk', val: p.blk }
    ];
    for(const item of countCats){
      const z = zc[item.key] || 0;
      const v = item.val !== undefined ? Number(item.val).toFixed(1) : '-';
      tds += `<td style="${getHashtagStyle(z)}">${v}</td>`;
    }

    return `
      <div class="de-breakdown-container">
        <div class="de-breakdown-hdr">Statistical Breakdowns</div>
        <table class="de-stat-breakdown-table">
          <thead><tr>${ths}</tr></thead>
          <tbody><tr>${tds}</tr></tbody>
        </table>
      </div>
    `;
  }

  function selectPlayer(rk){
    els.results.classList.remove('open');
    const p = PLAYERS.find(x=>x.rk===rk);
    if(!p) return;
    els.search.value = p.name;
    renderCheck(rk);
  }

  function renderCheck(rk, isUpNow){
    const p = PLAYERS.find(x=>x.rk===rk);
    if(!p){ els.checkResult.innerHTML=''; return; }
    const C = computeAll(state(), PLAYERS);
    const zRank = (C.zRankMap && C.zRankMap.get(rk)) || p.rk;
    const zc = C.zAll ? C.zAll.get(rk) : null;

    if(picks.some(pk=>pk.rk===rk)){
      els.checkResult.innerHTML = `
        <div class="de-check-result">
          <div class="n"><span class="de-name-rank-badge">#${zRank}</span> ${escapeHtml(p.name)}</div>
          <div class="m">Already drafted.</div>
          ${renderStatBreakdownTable(p, zc)}
        </div>
      `;
      return;
    }
    const result = checkPrice(state(), PLAYERS, rk);
    if(!result || result.full){
      els.checkResult.innerHTML = `
        <div class="de-check-result">
          <div class="n"><span class="de-name-rank-badge">#${zRank}</span> ${escapeHtml(p.name)}</div>
          <div class="m">Your roster is full — nothing left to spend on.</div>
          ${renderStatBreakdownTable(p, zc)}
        </div>
      `;
      return;
    }
    let altTxt = '';
    if(result.maxBid > 0 && result.alternativeNames.length){
      altTxt = `Above $${result.maxBid}, passing and building around ${result.alternativeNames.join(' + ')}${result.alternativeMore?' + others':''} instead comes out ahead.`;
    } else if(result.isEndgame && result.maxBid <= 0 && result.dreamAlternativeNames && result.dreamAlternativeNames.length){
      altTxt = `Saving slot & budget for Dream Build targets: ${result.dreamAlternativeNames.join(' + ')}${result.dreamAlternativeMore?' + others':''}.`;
    } else if(result.doNotDraft){
      altTxt = p.dndReason ? `Do Not Draft reason: ${p.dndReason}` : `Player is on your Do Not Draft list. Automatic pass ($0).`;
    }

    const upBannerHtml = isUpNow ? `<div class="de-player-up-tag">⚡ Player Up For Bidding</div>` : '';
    const dndBannerHtml = result.doNotDraft
      ? `<div class="de-dnd-banner">⛔ DO NOT DRAFT${p.dndReason ? ` — ${escapeHtml(p.dndReason)}` : ''}</div>`
      : '';
    const dreamBadgeHtml = (result.isEndgame && result.inDreamBuild)
      ? `<span class="de-dream-badge">${result.isMonopoly ? '👑 Endgame Monopoly Target' : '★ In Dream Build'}</span>`
      : '';
    const dndBadgeHtml = result.doNotDraft
      ? `<span class="de-dnd-badge">⛔ DO NOT DRAFT</span>`
      : '';
    const rankBadgeHtml = `<span class="de-name-rank-badge ${result.doNotDraft ? 'de-dnd-chip' : ''}">#${result.zRank}${result.doNotDraft ? ' ⛔' : ''}</span>`;

    const hasBreakEvenCap = result.maxBid > 0 && result.breakEvenBid && result.breakEvenBid > result.maxBid;
    const bidLabel = result.doNotDraft
      ? 'Max worth bidding (Do Not Draft)'
      : (hasBreakEvenCap ? 'Max worth bidding (keeps Dream Build)' : 'Max worth bidding');
    const breakEvenSpan = hasBreakEvenCap
      ? ` <span style="font-size:11px; font-weight:500; color:#8a93a5; margin-left:6px;">(break-even ceiling: $${result.breakEvenBid})</span>`
      : '';

    els.checkResult.innerHTML = `
      <div class="de-check-result ${isUpNow ? 'de-player-up-banner' : ''}">
        ${upBannerHtml}
        ${dndBannerHtml}
        <div class="n">${rankBadgeHtml}${escapeHtml(p.name)}${dreamBadgeHtml}${dndBadgeHtml}</div>
        <div class="m">${p.pos.join('/')} · ${p.team||'FA'} · Z-Score Rank #${result.zRank} · solo ${result.soloZ.toFixed(2)}z · mkt now $${result.mktNow}${result.isEndgame && result.effCost && result.effCost < result.mktNow ? ` (eff $${result.effCost})` : ''}</div>
        <div class="p"><span class="lbl">${bidLabel}</span>${result.maxBid>0 ? '$'+result.maxBid : 'pass'}${breakEvenSpan}</div>
        ${altTxt ? `<div class="m" style="margin-top:4px;">${escapeHtml(altTxt)}</div>` : ''}
        ${renderStatBreakdownTable(p, result.zc)}
        <div class="de-check-actions">
          <input type="text" id="deLogTeam" placeholder="Team" value="${config.myTeamName ? escapeHtml(config.myTeamName) : ''}">
          <input type="number" id="deLogPrice" min="1" value="${result.maxBid>0?result.maxBid:result.mktNow}">
          <button class="de-btn" id="deLogBtn">Log pick</button>
        </div>
      </div>
    `;
    document.getElementById('deLogBtn').addEventListener('click', ()=>{
      const teamName = document.getElementById('deLogTeam').value.trim() || 'Unknown team';
      const price = parseInt(document.getElementById('deLogPrice').value,10) || 1;
      logPick(rk, teamName, price, 'manual');
      els.search.value = ''; els.checkResult.innerHTML = '';
    });
  }

  function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function makeDraggable(panel, handle){
    let dragging=false, sx=0, sy=0, ox=0, oy=0;
    handle.addEventListener('mousedown', (e)=>{
      if(e.target.tagName==='BUTTON') return;
      dragging=true; sx=e.clientX; sy=e.clientY;
      const r = panel.getBoundingClientRect(); ox=r.left; oy=r.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e)=>{
      if(!dragging) return;
      panel.style.left = Math.max(0, ox + (e.clientX-sx)) + 'px';
      panel.style.top = Math.max(0, oy + (e.clientY-sy)) + 'px';
      panel.style.right = 'auto';
    });
    window.addEventListener('mouseup', ()=>{ dragging=false; });
  }

  function render(flashNewest){
    if(!els.root) return;
    const C = computeAll(state(), PLAYERS);
    els.budget.textContent = '$'+C.myBudgetLeft;
    els.slots.textContent = C.mySlotsLeft + '/' + config.rosterSlots;
    els.inflation.textContent = isFinite(C.inflation) ? Math.round(C.inflation*100)+'%' : '—';

    els.posAlert.innerHTML = C.missingPos.length && C.mySlotsLeft<=(5-1)
      ? `<div class="de-alert">No player yet for: ${C.missingPos.join(', ')} — ${C.mySlotsLeft} slot${C.mySlotsLeft===1?'':'s'} left.</div>`
      : '';

    renderPuntUI(C);

    // power rankings — mirrors Draft Edge's table: rank position per category
    // (1=best), tiered good/mid/bad coloring, points-based total.
    if(!C.powerRankings.length){
      els.powerNote.textContent = '';
      els.power.innerHTML = `<div class="de-empty">No picks detected yet.</div>`;
    } else {
      els.powerNote.textContent = `(${C.powerRankings.length} team${C.powerRankings.length===1?'':'s'} seen)`;
      const catHeaders = CATS.map(c=>`<th>${CAT_LABEL[c]}</th>`).join('');
      const rows = C.powerRankings.map((t,i)=>{
        const catCells = CATS.map(c=>{
          const cr = t.catRanks[c];
          return `<td><span class="de-rankchip ${cr.tier}">${cr.rank}</span></td>`;
        }).join('');
        return `<tr class="${t.isMe?'me':''}">
          <td class="rankpos">${i+1}</td>
          <td class="name" title="${escapeHtml(t.teamName)}">${escapeHtml(t.teamName)}${t.isMe?' (me)':''}</td>
          ${catCells}
          <td class="total">${t.total.toFixed(0)}</td>
          <td>${t.picksMade}/${config.rosterSlots}</td>
          <td>$${t.budgetLeft}</td>
        </tr>`;
      }).join('');
      els.power.innerHTML = `<div class="de-power-wrap"><table class="de-power"><thead><tr><th>#</th><th>Team</th>${catHeaders}<th>Tot</th><th>Pk</th><th>$L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    // log
    const unmatchedCount = 0; // reserved for future "couldn't match N rows" counter
    els.unmatched.textContent = '';
    if(!picks.length){
      els.log.innerHTML = `<div class="de-empty">No picks logged yet.</div>`;
    } else {
      const sorted = picks.slice().sort((a,b)=>b.ts-a.ts);
      els.log.innerHTML = sorted.map(pk=>{
        const p = PLAYERS.find(x=>x.rk===pk.rk);
        const isNew = flashNewest && pk===sorted[0];
        return `<div class="de-log-row ${isNew?'de-new':''}">
          <span>${p?p.name:('#'+pk.rk)} <span style="color:#8a93a5;">$${pk.price} · ${escapeHtml(pk.teamName)}${pk.source==='auto'?' · auto':''}</span></span>
          <button class="de-log-x" data-rk="${pk.rk}" title="Undo">×</button>
        </div>`;
      }).join('');
      els.log.querySelectorAll('.de-log-x').forEach(btn=>{
        btn.addEventListener('click', ()=>undoPick(parseInt(btn.dataset.rk,10)));
      });
    }
    injectZRankChips();
  }

  function renderPuntUI(C){
    if(!els.puntGrid) return;
    const myTeam = C.powerRankings ? C.powerRankings.find(t=>t.isMe) : null;
    const html = CATS.map(c=>{
      const w = typeof weights[c]==='number' ? weights[c] : 1;
      let tagHtml = '';
      if(myTeam && myTeam.picksMade >= 1){
        const cr = myTeam.catRanks[c];
        const leadZ = typeof cr.leadZ==='number' ? cr.leadZ : 0;
        if(cr.rank === 1){
          const leadText = '+' + leadZ.toFixed(1) + 'z';
          tagHtml = `<span class="de-punt-tag dominant" title="Rank #1 in ${CAT_LABEL[c]} (Surplus lead: ${leadText} over #2 team)">#1 (${leadText})</span>`;
        } else if(cr.tier === 'good'){
          const lagText = leadZ.toFixed(1) + 'z';
          tagHtml = `<span class="de-punt-tag dominant" title="Rank #${cr.rank} in ${CAT_LABEL[c]} (${lagText} behind #1)">#${cr.rank} (${lagText})</span>`;
        } else if(cr.tier === 'bad'){
          const lagText = leadZ.toFixed(1) + 'z';
          tagHtml = `<span class="de-punt-tag lagging" title="Rank #${cr.rank} in ${CAT_LABEL[c]} (${lagText} behind #1)">#${cr.rank} (${lagText})</span>`;
        } else {
          const lagText = leadZ.toFixed(1) + 'z';
          tagHtml = `<span class="de-punt-tag mid" title="Rank #${cr.rank} in ${CAT_LABEL[c]} (${lagText} behind #1)">#${cr.rank} (${lagText})</span>`;
        }
      }
      const chipClass = w === 0 ? 'punted' : (w === 0.5 ? 'soft' : 'active');
      const wLabel = w === 0 ? 'PUNT (0x)' : (w === 0.5 ? 'SOFT (0.5x)' : '1x');
      return `
        <div class="de-punt-chip ${chipClass}" data-cat="${c}" title="Click to cycle weight: 1x -> 0x (Punt) -> 0.5x (Soft)">
          <div class="de-punt-cat">${CAT_LABEL[c]}</div>
          <div class="de-punt-weight">${wLabel}</div>
          ${tagHtml}
        </div>
      `;
    }).join('');
    els.puntGrid.innerHTML = html;
    els.puntGrid.querySelectorAll('.de-punt-chip[data-cat]').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const c = chip.dataset.cat;
        const current = typeof weights[c]==='number' ? weights[c] : 1;
        const next = current === 1 ? 0 : (current === 0 ? 0.5 : 1);
        weights[c] = next;
        save();
        render();
      });
    });
  }

  if(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local){
    loadThenInit();
  }

  if(typeof module !== 'undefined' && module.exports){
    module.exports = {
      getGridInfo,
      scanBoardGrid,
      autoDetectLeague,
      handleScrapedPick,
      normalizeTeamName,
      injectZRankChips,
      BOARD_CELL_TITLE_RE,
      getConfig: () => config,
      setConfig: (c) => { config = Object.assign({}, DEFAULTS, c); },
      getPicks: () => picks,
      setPicks: (p) => { picks = p; },
      runAllScans
    };
  }
})();
