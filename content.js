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

  const DEFAULTS = { numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'You', starterSlots: 10, benchWeight: 0.3 };
  const PLAYERS = DRAFT_EDGE_PLAYERS;
  const nameIndex = buildNameIndex(PLAYERS);

  let config = Object.assign({}, DEFAULTS);
  let picks = []; // {rk, teamName, price, ts, source: 'auto'|'manual'}
  let seenSignatures = new Set();
  let weights = Object.fromEntries(CATS.map(c=>[c,1]));

  function state(){
    return { numTeams: config.numTeams, rosterSlots: config.rosterSlots, budget: config.budget,
             myTeamName: config.myTeamName, starterSlots: config.starterSlots, benchWeight: config.benchWeight,
             weights, picks };
  }

  function save(){
    chrome.storage.local.set({ picks, seenSignatures: Array.from(seenSignatures), weights });
  }

  function loadThenInit(){
    chrome.storage.local.get(['config','picks','seenSignatures','weights'], (res)=>{
      config = Object.assign({}, DEFAULTS, res.config||{});
      picks = Array.isArray(res.picks) ? res.picks : [];
      seenSignatures = new Set(res.seenSignatures||[]);
      if(res.weights && typeof res.weights === 'object'){
        weights = Object.assign(Object.fromEntries(CATS.map(c=>[c,1])), res.weights);
      }
      buildOverlay();
      render();
      startObserving();
    });
  }

  chrome.storage.onChanged.addListener((changes, area)=>{
    if(area!=='local') return;
    let dirty = false;
    if(changes.config){ config = Object.assign({}, DEFAULTS, changes.config.newValue||{}); dirty = true; }
    if(changes.picks){ picks = Array.isArray(changes.picks.newValue) ? changes.picks.newValue : []; dirty = true; }
    if(changes.weights){ weights = Object.assign(Object.fromEntries(CATS.map(c=>[c,1])), changes.weights.newValue||{}); dirty = true; }
    if(dirty) render();
  });

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
        const nameSpan = playerDiv.querySelector('span');
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
        handleScrapedPick(rawName, price, teamNameRaw, dataId);
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

  // ---- Board-tab grid: the persistent, full-history source. Structure
  // (verified live): a flat container of [numTeams header cells] followed by
  // [numTeams * rosterSlots player-slot cells] in ROW-MAJOR order (round 1
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
      const idx = Array.prototype.indexOf.call(grid.children, cellWrap);
      if(idx < config.numTeams) return; // it's a header cell, not a player slot
      const headers = Array.prototype.slice.call(grid.children, 0, config.numTeams).map(h=>h.textContent.trim());
      const j = idx - config.numTeams;
      const teamIdx = j % config.numTeams;
      const teamName = headers[teamIdx];
      if(!teamName) return;
      const priceMatch = cellWrap.textContent.match(/\$(\d{1,3})(?!\d)/);
      if(!priceMatch) return;
      handleScrapedPick(m[1].trim(), parseInt(priceMatch[1],10), teamName, null);
    });
  }

  let lastAutoNominatedId = null;
  function syncNomination(nominationDiv){
    if(!nominationDiv) return;
    const dataId = nominationDiv.getAttribute('data-id');
    if(dataId === lastAutoNominatedId) return;
    const img = nominationDiv.querySelector('img[title]');
    const rawName = img ? img.getAttribute('title') : null;
    if(!rawName) return;
    const player = matchPlayer(rawName, PLAYERS, nameIndex);
    if(!player || picks.some(p=>p.rk===player.rk)) return;
    lastAutoNominatedId = dataId;
    if(!els.search) return;
    els.search.value = player.name;
    els.results.classList.remove('open');
    renderCheck(player.rk);
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
      handleScrapedPick(rawName, parseInt(priceMatch[1],10), teamGuess, null);
    });
  }

  function handleScrapedPick(rawName, price, teamGuess, dataId){
    if(!rawName || !isFinite(price) || price<=0) return;
    const player = matchPlayer(rawName, PLAYERS, nameIndex);
    if(!player) return; // unmatched — left for the manual field to log, not guessed at
    const sig = (dataId || player.rk) + '|' + price + '|' + (teamGuess||'');
    if(seenSignatures.has(sig)) return;
    if(picks.some(p=>p.rk===player.rk)) { seenSignatures.add(sig); return; }
    seenSignatures.add(sig);
    logPick(player.rk, teamGuess, price, 'auto');
  }

  let observer = null;
  function runAllScans(){
    const nominationDiv = scanForPicks();
    scanBoardGrid();
    genericScan(document.body);
    syncNomination(nominationDiv);
  }
  function startObserving(){
    if(observer) return;
    // one full pass over whatever's already on the page (rejoining a draft
    // already in progress shouldn't require waiting for the next pick —
    // this is also what recovers full history from the Board tab if it's
    // already open when the extension loads)
    runAllScans();
    observer = new MutationObserver(()=>{
      // Re-scanning the whole (small, ≤~180-entry) pick set on every batch is
      // simpler and more robust than diffing individual added nodes —
      // logPick()/seenSignatures make repeat scans free no-ops.
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
      activeIdx = -1;
      els.results.innerHTML = matches.length
        ? matches.map(p=>`<div class="de-mr-item" data-rk="${p.rk}">${p.name} <span style="color:#8a93a5;">${p.pos.join('/')} · ${p.team||'FA'}</span></div>`).join('')
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
    const rows = opt.players.map(p=>`<div class="de-opt-row"><span>${escapeHtml(p.name)}<span class="de-opt-meta">${p.pos.join('/')} · ${p.team||'FA'}</span></span><span class="de-opt-right"><span class="de-opt-cost">$${p.cost}</span><span class="de-opt-z">${p.z.toFixed(2)}z</span></span></div>`).join('');
    box.innerHTML = `
      ${opt.posWarning ? `<div class="de-alert">${escapeHtml(opt.posWarning)}</div>` : ''}
      <div class="de-poscoverage">${posStrip}</div>
      <div class="de-opt-list">${rows}</div>
      <div class="de-opt-summary">Fill: ${opt.bestVal.toFixed(2)}z for $${opt.totalCost} of $${opt.budgetLeft} left across ${opt.slotsLeft} slots. Whole team incl. drafted: <b>${(opt.existingZ+opt.bestVal).toFixed(2)}z</b>.</div>
    `;
  }

  function selectPlayer(rk){
    els.results.classList.remove('open');
    const p = PLAYERS.find(x=>x.rk===rk);
    if(!p) return;
    els.search.value = p.name;
    renderCheck(rk);
  }

  function renderCheck(rk){
    const p = PLAYERS.find(x=>x.rk===rk);
    if(!p){ els.checkResult.innerHTML=''; return; }
    if(picks.some(pk=>pk.rk===rk)){
      els.checkResult.innerHTML = `<div class="de-check-result"><div class="n">${p.name}</div><div class="m">Already drafted.</div></div>`;
      return;
    }
    const result = checkPrice(state(), PLAYERS, rk);
    if(!result || result.full){
      els.checkResult.innerHTML = `<div class="de-check-result"><div class="m">Your roster is full — nothing left to spend on.</div></div>`;
      return;
    }
    const altTxt = result.alternativeNames.length
      ? `Above $${result.maxBid}, passing and building around ${result.alternativeNames.join(' + ')}${result.alternativeMore?' + others':''} instead comes out ahead.`
      : '';
    els.checkResult.innerHTML = `
      <div class="de-check-result">
        <div class="n">${p.name}</div>
        <div class="m">${p.pos.join('/')} · ${p.team||'FA'} · solo ${result.soloZ.toFixed(2)}z · mkt now $${result.mktNow}</div>
        <div class="p"><span class="lbl">Max worth bidding</span>${result.maxBid>0 ? '$'+result.maxBid : 'pass'}</div>
        ${altTxt ? `<div class="m" style="margin-top:4px;">${altTxt}</div>` : ''}
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

  loadThenInit();
})();
