// Draft Edge extension — valuation engine
// Ported from the Draft Edge artifact's computeAll(), trimmed to what a live
// overlay needs (budget, inflation, VORP-based recommendations, position
// alerts). Deliberately NOT reimplementing the knapsack team-optimizer or the
// standings power-rankings table — those stay exclusive to the full Draft
// Edge tab. Keep this file's math in sync with Draft Edge's computeAll() by
// hand; there's no shared module between the two runtimes.

const CATS = ['fgPct','ftPct','tpm','pts','treb','ast','stl','blk'];
const CAT_LABEL = {fgPct:'FG%',ftPct:'FT%',tpm:'3PM',pts:'PTS',treb:'REB',ast:'AST',stl:'STL',blk:'BLK'};
const CORE_POS = ['PG','SG','SF','PF','C'];

function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function mean(arr){ return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function stdev(arr, m){ if(arr.length<2) return 1e-9; const v = arr.reduce((a,b)=>a+(b-m)*(b-m),0)/arr.length; return Math.sqrt(v)||1e-9; }

function posMaskOf(p){
  let m = 0;
  for(const pos of p.pos){ const i = CORE_POS.indexOf(pos); if(i>=0) m |= (1<<i); }
  return m;
}

// state = { numTeams, rosterSlots, budget, myTeamName, weights, picks:[{rk,teamName,price,ts}] }
// Unlike Draft Edge (which pre-assigns a fixed 0..N-1 team index array from
// its own setup form), the extension only knows teams by whatever name
// string Yahoo's draft-results feed shows for the winning bidder, so picks
// are keyed by teamName here, not a numeric index.
function computeAll(state, PLAYERS){
  const poolSize = clamp(state.numTeams * state.rosterSlots, 1, PLAYERS.length);
  const rosterPool = PLAYERS.slice(0, poolSize);
  const rosterPoolByRk = new Map(rosterPool.map(p=>[p.rk,p]));
  const draftedMap = new Map(state.picks.map(p=>[p.rk,p]));
  const availableInPool = rosterPool.filter(p=>!draftedMap.has(p.rk));

  const poolStats = {};
  for(const c of CATS){
    if(c==='fgPct' || c==='ftPct'){
      const mkey = c==='fgPct' ? 'fgm' : 'ftm';
      const akey = c==='fgPct' ? 'fga' : 'fta';
      let totMakes=0, totAtt=0;
      const impacts = [];
      for(const p of availableInPool){
        totMakes += p[mkey]; totAtt += p[akey];
      }
      const poolAvg = totAtt>0 ? totMakes/totAtt : 0;
      for(const p of availableInPool){
        const perGameA = p[akey];
        impacts.push((p[c]-poolAvg)*perGameA);
      }
      const m = mean(impacts), sd = stdev(impacts,m);
      poolStats[c] = {mode:'pct', poolAvg, m, sd, mkey, akey};
    } else {
      const totals = availableInPool.map(p=>p[c]);
      const m = mean(totals), sd = stdev(totals,m);
      poolStats[c] = {mode:'count', m, sd};
    }
  }

  function zOf(p, c){
    const st = poolStats[c];
    if(st.mode==='pct'){
      const perGameA = p[st.akey];
      const impact = (p[c]-st.poolAvg)*perGameA;
      return (impact - st.m)/st.sd;
    } else {
      return (p[c] - st.m)/st.sd;
    }
  }

  const zAll = new Map();
  for(const p of PLAYERS){
    const zc = {};
    for(const c of CATS) zc[c] = zOf(p,c);
    zAll.set(p.rk, zc);
  }
  function baseCompositeZ(zc){
    let s=0; 
    for(const c of CATS) {
      s += zc[c];
    }
    return s;
  }

  function compositeZ(zc){
    let s=0; 
    for(const c of CATS) {
      const userW = (state.weights && typeof state.weights[c] === 'number') ? state.weights[c] : 1.0;
      s += userW * zc[c];
    }
    return s;
  }

  const isPunting = state.weights && Object.values(state.weights).some(w => typeof w === 'number' && Math.abs(w - 1.0) > 1e-4);

  const zRankMap = new Map();
  if (!isPunting) {
    PLAYERS.forEach(p => {
      zRankMap.set(p.rk, p.rk);
    });
  } else {
    const playerZScores = PLAYERS.map(p => {
      const zc = zAll.get(p.rk);
      const delta = zc ? (compositeZ(zc) - baseCompositeZ(zc)) : 0;
      const baseScore = typeof p.totalZ === 'number' ? p.totalZ : (301 - p.rk);
      return {
        rk: p.rk,
        score: baseScore + delta
      };
    }).sort((a,b) => b.score - a.score);

    playerZScores.forEach((item, index) => {
      zRankMap.set(item.rk, index + 1);
    });
  }

  const draftedCount = state.picks.length;
  const remainingSlots = clamp(poolSize - draftedCount, 0, poolSize);
  const availSortedByComposite = availableInPool.slice().sort((a,b)=> compositeZ(zAll.get(b.rk)) - compositeZ(zAll.get(a.rk)));
  const replIdx = clamp(remainingSlots-1, 0, Math.max(0,availSortedByComposite.length-1));
  const winLo = clamp(replIdx-4,0,availSortedByComposite.length-1);
  const winHi = clamp(replIdx+5,0,availSortedByComposite.length);
  const replWindow = availSortedByComposite.slice(winLo, Math.max(winHi, winLo+1));
  const replZ = {};
  for(const c of CATS){
    replZ[c] = replWindow.length ? mean(replWindow.map(p=>zAll.get(p.rk)[c])) : 0;
  }

  const remainingBudgetAllTeams = state.numTeams*state.budget - state.picks.reduce((a,pk)=>a+(pk.price||0),0);

  const totalMarketCostAtStart = rosterPool.reduce((a,p)=>a+(p.mktCost||1),0);
  const remainingMarketCost = availableInPool.reduce((a,p)=>a+(p.mktCost||1),0);
  const origSpendable = state.numTeams*state.budget - state.numTeams*state.rosterSlots;
  const baselineRatio = totalMarketCostAtStart>0 ? origSpendable/totalMarketCostAtStart : 1;
  const nowRatio = remainingMarketCost>0 ? Math.max(remainingBudgetAllTeams - remainingSlots,0)/remainingMarketCost : 1;
  const inflation = clamp(baselineRatio>0 ? nowRatio/baselineRatio : 1, 0.4, 2.2);
  function fairPrice(rk){
    const p = rosterPoolByRk.get(rk);
    return p ? Math.max(1, Math.round((p.mktCost || 1) * inflation)) : 1;
  }

  function teamBudgetAndSlotsLeft(teamName){
    const picks = state.picks.filter(p=>p.teamName===teamName);
    const spent = picks.reduce((a,p)=>a+(p.price||0),0);
    return { budgetLeft: state.budget - spent, slotsLeft: Math.max(state.rosterSlots - picks.length, 0), picksMade: picks.length };
  }
  const my = teamBudgetAndSlotsLeft(state.myTeamName);

  // position coverage: which of PG/SG/SF/PF/C can I currently fill from my roster
  const myPicks = state.picks.filter(p=>p.teamName===state.myTeamName).map(pk=>rosterPoolByRk.get(pk.rk) || PLAYERS.find(p=>p.rk===pk.rk)).filter(Boolean);
  let reach = 0;
  for(const p of myPicks) reach |= posMaskOf(p);
  const missingPos = CORE_POS.filter((_,i)=> !(reach & (1<<i)));

  // ---- power rankings: projected roto finish for every team seen so far ----
  // Ported from Draft Edge's teamProjZ/rankPoints. Draft Edge knows the full
  // fixed team list from setup; the extension only knows a team once it's
  // made a pick, so `teamNames` here is "every distinct name seen in
  // state.picks, plus myTeamName" rather than a complete pre-declared roster.
  // Teams that haven't picked yet just aren't in the table — noted in the UI.
  const teamNames = Array.from(new Set(state.picks.map(p=>p.teamName).concat(state.myTeamName ? [state.myTeamName] : [])));
  // Matches Draft Edge's renderPowerRankings exactly: per-category cells show
  // RAW RANK POSITION (1 = best in that category, numTeams = worst), tiered
  // into good/mid/bad thirds for coloring — not a continuous z-heatmap and
  // not tie-averaged points. Tot is the points-equivalent sum
  // (numTeams+1-rank per category) so a higher total still reads as better,
  // matching the sort order.
  let powerRankings = [];
  if(teamNames.length){
    const n = teamNames.length;
    const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
    const benchWeight = state.benchWeight !== undefined ? state.benchWeight : 0.3;
    const teamProjZ = teamNames.map(name=>{
      const picksOfTeam = state.picks.filter(pk=>pk.teamName===name).slice().sort((a,b)=>{
        const za = zAll.get(a.rk), zb = zAll.get(b.rk);
        const ca = za ? baseCompositeZ(za) : -1e9;
        const cb = zb ? baseCompositeZ(zb) : -1e9;
        return (cb - ca) || (a.rk - b.rk);
      });
      const proj = {};
      const numPicks = picksOfTeam.length;
      const emptyStarters = Math.max(0, starterSlots - numPicks);
      const emptyBench = Math.max(0, state.rosterSlots - Math.max(starterSlots, numPicks));
      for(const c of CATS){
        let s = emptyStarters * replZ[c] + emptyBench * benchWeight * replZ[c];
        picksOfTeam.forEach((pk, idx)=>{
          const zc = zAll.get(pk.rk);
          if(zc){
            const w = (idx < starterSlots) ? 1.0 : benchWeight;
            s += w * zc[c];
          }
        });
        proj[c] = s;
      }
      return proj;
    });
    const rankOfCat = {};
    const leadOfCat = {};
    for(const c of CATS){
      const values = teamProjZ.map(t=>t[c]);
      const idx = values.map((v,i)=>i).sort((a,b)=>values[b]-values[a]);
      const ranks = new Array(n);
      const leads = new Array(n);
      idx.forEach((teamIdx,pos)=>{
        ranks[teamIdx] = pos+1;
        if(pos === 0){
          leads[teamIdx] = n > 1 ? values[teamIdx] - values[idx[1]] : 0;
        } else {
          leads[teamIdx] = values[teamIdx] - values[idx[0]];
        }
      });
      rankOfCat[c] = ranks;
      leadOfCat[c] = leads;
    }
    const tierOf = (r)=> r<=Math.ceil(n/3) ? 'good' : (r<=Math.ceil(n*2/3) ? 'mid' : 'bad');
    const totals = teamNames.map((_,i)=> CATS.reduce((a,c)=>a + (n+1-rankOfCat[c][i]), 0));
    powerRankings = teamNames.map((name,i)=>{
      const {budgetLeft} = C_teamBudget(name);
      return {
        teamName: name,
        isMe: !!state.myTeamName && name===state.myTeamName,
        total: totals[i],
        catRanks: Object.fromEntries(CATS.map(c=>[c, {rank: rankOfCat[c][i], tier: tierOf(rankOfCat[c][i]), leadZ: leadOfCat[c][i]}])),
        picksMade: state.picks.filter(pk=>pk.teamName===name).length,
        budgetLeft,
      };
    }).sort((a,b)=> b.total-a.total);
  }
  function C_teamBudget(name){
    const picksT = state.picks.filter(p=>p.teamName===name);
    const spent = picksT.reduce((a,p)=>a+(p.price||0),0);
    return { budgetLeft: state.budget - spent };
  }

  return {
    poolSize, rosterPool, availableInPool, zAll, compositeZ, baseCompositeZ, replZ,
    fairPrice, remainingBudgetAllTeams, remainingSlots, draftedCount, inflation,
    myBudgetLeft: my.budgetLeft, mySlotsLeft: my.slotsLeft, myPicksMade: my.picksMade,
    missingPos, teamBudgetAndSlotsLeft, powerRankings, zRankMap, teamNamesAll: teamNames
  };
}

// ---------- price check (ported from Draft Edge's checkPrice, verbatim math) ----------
// "The highest bid at which winning this player still leaves you at least as
// well off as passing and drafting the best alternative team with the money
// and slots you'd have left." Exact 0/1 knapsack over the remaining pool,
// tracking PG/SG/SF/PF/C coverage as a 32-state bitmask so the alternative
// build has to be a legal fieldable team, not just the highest-z pile of
// players. This is the calculation Alex actually leans on during a live
// auction, so it's ported in full rather than approximated.
const FULL_COVERAGE = (1<<CORE_POS.length)-1;
const COVERAGE_STATES = 1<<CORE_POS.length;
const FULL_COVERAGE_2C = (1<<6)-1;
const COVERAGE_STATES_2C = 1<<6;

function getDynamicCategoryWeights(state, PLAYERS, zAll){
  const cfg = state.hillClimbConfig || {};
  const alpha = typeof cfg.alpha === 'number' ? cfg.alpha : 0.10;
  const wMin = typeof cfg.wMin === 'number' ? cfg.wMin : 0.75;
  const wMax = typeof cfg.wMax === 'number' ? cfg.wMax : 1.48;
  const targetPerPick = typeof cfg.targetPerPick === 'number' ? cfg.targetPerPick : 0.08;
  const satThreshold = typeof cfg.satThreshold === 'number' ? cfg.satThreshold : 99.0;
  const satDecay = typeof cfg.satDecay === 'number' ? cfg.satDecay : 0.0;
  const satMin = typeof cfg.satMin === 'number' ? cfg.satMin : 0.45;
  const lateDeficitBoost = typeof cfg.lateDeficitBoost === 'number' ? cfg.lateDeficitBoost : 1.25;

  const baseWeights = {
    fgPct: typeof cfg.baseFgPct === 'number' ? cfg.baseFgPct : 1.08,
    ftPct: typeof cfg.baseFtPct === 'number' ? cfg.baseFtPct : 1.00,
    tpm: typeof cfg.baseTpm === 'number' ? cfg.baseTpm : 1.06,
    pts: 1.00,
    treb: typeof cfg.baseTreb === 'number' ? cfg.baseTreb : 1.22,
    ast: 1.00,
    stl: 1.00,
    blk: typeof cfg.baseBlk === 'number' ? cfg.baseBlk : 1.15
  };
  const userWeights = state.weights || {};
  const weights = {};
  for(const c of CATS){
    const uW = (typeof userWeights[c] === 'number') ? userWeights[c] : 1.0;
    weights[c] = (baseWeights[c] || 1.0) * uW;
  }
  const myPicks = (state.picks || []).filter(pk=>pk.teamName===state.myTeamName);
  const myPlayers = myPicks.map(pk=>PLAYERS.find(x=>x.rk===pk.rk)).filter(Boolean);
  const picksMade = myPlayers.length;
  if(picksMade === 0) return weights;

  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const benchWeight = state.benchWeight !== undefined ? state.benchWeight : 0.3;
  const sortedMy = myPlayers.slice().sort((a, b) => {
    const za = zAll.get(a.rk), zb = zAll.get(b.rk);
    const sa = za ? CATS.reduce((acc, c) => acc + weights[c] * za[c], 0) : -1e9;
    const sb = zb ? CATS.reduce((acc, c) => acc + weights[c] * zb[c], 0) : -1e9;
    return (sb - sa) || (a.rk - b.rk);
  });

  const currentZ = {};
  for(const c of CATS) currentZ[c] = 0;
  sortedMy.forEach((p, idx) => {
    const zc = zAll.get(p.rk);
    if(zc){
      const w = (idx < starterSlots) ? 1.0 : benchWeight;
      for(const c of CATS) currentZ[c] += w * zc[c];
    }
  });

  const targetZ = picksMade * targetPerPick;
  const isLateHalf = picksMade >= Math.floor((state.rosterSlots || 12) * 0.4);
  for(const c of CATS){
    const deficit = targetZ - currentZ[c];
    let effAlpha = alpha;
    if(deficit > 0 && isLateHalf && lateDeficitBoost > 1.0){
      effAlpha *= lateDeficitBoost;
    }
    if(c === 'treb' && deficit > 0){
      effAlpha *= 1.20;
    }
    const adj = deficit * effAlpha;
    let w = clamp(weights[c] + adj, wMin, wMax);
    if(currentZ[c] > satThreshold && satDecay > 0){
      const excess = currentZ[c] - satThreshold;
      w = Math.max(satMin, w - excess * satDecay);
    }
    weights[c] = w;
  }
  return weights;
}

function reachableCoverage(players, multiCenter = false){
  if(!multiCenter){
    const reach = new Uint8Array(COVERAGE_STATES);
    reach[0] = 1;
    for(const p of players){
      const pm = posMaskOf(p);
      if(!pm) continue;
      for(let mask=reach.length-1; mask>=0; mask--){
        if(!reach[mask]) continue;
        for(let j=0;j<CORE_POS.length;j++){
          if((pm & (1<<j)) && !(mask & (1<<j))) reach[mask | (1<<j)] = 1;
        }
      }
    }
    return reach;
  } else {
    const reach = new Uint8Array(COVERAGE_STATES_2C);
    reach[0] = 1;
    const C1 = 1 << 4;
    const C2 = 1 << 5;
    for(const p of players){
      if(!p.pos) continue;
      const pm = posMaskOf(p);
      const canC = p.pos.includes('C');
      for(let mask=COVERAGE_STATES_2C-1; mask>=0; mask--){
        if(!reach[mask]) continue;
        for(let j=0;j<4;j++){
          if((pm & (1<<j)) && !(mask & (1<<j))) reach[mask | (1<<j)] = 1;
        }
        if(canC){
          if(!(mask & C1)) reach[mask | C1] = 1;
          else if(!(mask & C2)) reach[mask | C2] = 1;
        }
      }
    }
    return reach;
  }
}
function missingCorePositions(players){
  const reach = reachableCoverage(players);
  if(reach[FULL_COVERAGE]) return [];
  const haveAny = new Set();
  for(const p of players){ const pm = posMaskOf(p); for(let j=0;j<CORE_POS.length;j++) if(pm & (1<<j)) haveAny.add(CORE_POS[j]); }
  const zeroEligible = CORE_POS.filter(pos=>!haveAny.has(pos));
  return zeroEligible.length ? zeroEligible : ['(position conflict)'];
}

function knapsackDP(pool, costFn, valFn, capBudget, capSlots, baseReach, starterSlotsLeft, benchWeight, multiCenter = false, myPlayers = null, totalStarterSlots = null, maxFragility = 1.0, state = null){
  const hasMyPlayers = Array.isArray(myPlayers) && typeof totalStarterSlots === 'number';
  const sortedPool = hasMyPlayers ? pool.slice().sort((a, b) => {
    const diff = valFn(b) - valFn(a);
    return Math.abs(diff) > 1e-12 ? diff : (a.rk - b.rk);
  }) : pool;
  const n = sortedPool.length;
  const B = Math.max(0, Math.floor(capBudget));
  const K = Math.max(0, Math.floor(capSlots));
  const M = multiCenter ? COVERAGE_STATES_2C : COVERAGE_STATES;
  const effMaxFrag = (state && typeof state.maxFragility === 'number') ? state.maxFragility : (typeof maxFragility === 'number' ? maxFragility : 1.0);
  const maxFragUnits = Math.round(effMaxFrag * 2);
  const curFragUnits = (myPlayers || []).reduce((sum, p) => sum + getFragUnits(p, state), 0);
  const maxNewUnits = Math.max(0, maxFragUnits - curFragUnits);
  const F = maxFragUnits + 1;
  const NEG = -1e15;
  const reach0 = baseReach || (()=>{ const r = new Uint8Array(M); r[0]=1; return r; })();
  const idx = (k,b,mask,f) => ((k*(B+1)+b)*M+mask)*F + f;
  let dp = new Float64Array((K+1)*(B+1)*M*F).fill(NEG);
  for(let b=0;b<=B;b++) for(let mask=0;mask<M;mask++) if(reach0[mask]) dp[idx(0,b,mask,0)] = 0;
  const choice = new Array(n);
  const sSlots = (starterSlotsLeft !== undefined) ? starterSlotsLeft : K;
  const bWeight = (benchWeight !== undefined) ? benchWeight : 0.3;
  const C1 = 1 << 4;
  const C2 = 1 << 5;

  const sortedMy = (hasMyPlayers && myPlayers.length > 0) ? myPlayers.slice().sort((a, b) => {
    const diff = valFn(b) - valFn(a);
    return Math.abs(diff) > 1e-12 ? diff : (a.rk - b.rk);
  }) : [];
  const effStarterSlots = hasMyPlayers ? Math.min(totalStarterSlots, sortedMy.length + K) : sSlots;
  let mIdx = 0;

  function applyMyPlayerDemotion(mPlayer, mRank1Based){
    if(mRank1Based > effStarterSlots || bWeight === 1.0) return;
    const mVal = valFn(mPlayer);
    const demotionDelta = (1.0 - bWeight) * mVal;
    if(Math.abs(demotionDelta) < 1e-12) return;
    const minKForDemotion = Math.max(1, effStarterSlots - mRank1Based + 1);
    for(let k=minKForDemotion; k<=K; k++){
      for(let b=0; b<=B; b++){
        for(let mask=0; mask<M; mask++){
          for(let f=0; f<=maxNewUnits; f++){
            const t = idx(k,b,mask,f);
            if(dp[t] > NEG/2){
              dp[t] -= demotionDelta;
            }
          }
        }
      }
    }
  }

  for(let i=0;i<n;i++){
    const baseVal = valFn(sortedPool[i]);
    while(mIdx < sortedMy.length){
      const mVal = valFn(sortedMy[mIdx]);
      if(mVal > baseVal + 1e-12 || (Math.abs(mVal - baseVal) <= 1e-12 && sortedMy[mIdx].rk < sortedPool[i].rk)){
        mIdx++;
        applyMyPlayerDemotion(sortedMy[mIdx - 1], mIdx);
      } else {
        break;
      }
    }

    const cost = Math.round(costFn(sortedPool[i]));
    const pFragUnits = getFragUnits(sortedPool[i], state);
    const pm = posMaskOf(sortedPool[i]);
    const canC = sortedPool[i].pos && sortedPool[i].pos.includes('C');
    const newDp = dp.slice();
    const take = new Int8Array((K+1)*(B+1)*M*F).fill(-1);
    if(cost <= B && pFragUnits <= maxNewUnits){
      for(let k=K;k>=1;k--){
        const itemVal = ((k + mIdx) <= effStarterSlots) ? baseVal : baseVal * bWeight;
        for(let b=B;b>=cost;b--){
          for(let f=maxNewUnits; f>=pFragUnits; f--){
            const srcF = f - pFragUnits;
            for(let mask=0;mask<M;mask++){
              const srcVal = dp[idx(k-1,b-cost,mask,srcF)];
              if(srcVal <= NEG/2) continue;
              const withItem = srcVal + itemVal;
              const t0 = idx(k,b,mask,f);
              if(withItem > newDp[t0]){ newDp[t0] = withItem; take[t0] = mask; }
              if(!multiCenter){
                for(let j=0;j<CORE_POS.length;j++){
                  if((pm & (1<<j)) && !(mask & (1<<j))){
                    const t1 = idx(k,b,mask|(1<<j),f);
                    if(withItem > newDp[t1]){ newDp[t1] = withItem; take[t1] = mask; }
                  }
                }
              } else {
                for(let j=0;j<4;j++){
                  if((pm & (1<<j)) && !(mask & (1<<j))){
                    const t1 = idx(k,b,mask|(1<<j),f);
                    if(withItem > newDp[t1]){ newDp[t1] = withItem; take[t1] = mask; }
                  }
                }
                if(canC){
                  if(!(mask & C1)){
                    const t1 = idx(k,b,mask|C1,f);
                    if(withItem > newDp[t1]){ newDp[t1] = withItem; take[t1] = mask; }
                  } else if(!(mask & C2)){
                    const t1 = idx(k,b,mask|C2,f);
                    if(withItem > newDp[t1]){ newDp[t1] = withItem; take[t1] = mask; }
                  }
                }
              }
            }
          }
        }
      }
    }
    dp = newDp;
    choice[i] = take;
  }
  while(mIdx < sortedMy.length){
    mIdx++;
    applyMyPlayerDemotion(sortedMy[mIdx - 1], mIdx);
  }
  return {
    dp, choice, pool: sortedPool, B, K, M, F, idx, multiCenter,
    maxNewUnits,
    costOf: (p) => Math.round(costFn(p)),
    fragUnitsOf: (p) => getFragUnits(p, state)
  };
}
function bestFeasible(res, k, b){
  const targetMask = res.multiCenter ? FULL_COVERAGE_2C : FULL_COVERAGE;
  let best = -1e15;
  for(let f=0; f<=res.maxNewUnits; f++){
    const v = res.dp[res.idx(k,b,targetMask,f)];
    if(v > best) best = v;
  }
  return best;
}
function bestAny(res, k, b){
  let best = -1e15, bestMask = 0;
  for(let mask=0; mask<res.M; mask++){
    for(let f=0; f<=res.maxNewUnits; f++){
      const v = res.dp[res.idx(k,b,mask,f)];
      if(v > best){ best = v; bestMask = mask; }
    }
  }
  return {value: best, mask: bestMask};
}
function knapsackReconstruct(res, k, b, mask){
  const {choice, pool, maxNewUnits, fragUnitsOf, costOf} = res;
  let ck=k, cb=b, cm=mask;
  let cf = 0, bestVal = -1e15;
  for(let f=0; f<=maxNewUnits; f++){
    const v = res.dp[res.idx(ck, cb, cm, f)];
    if(v > bestVal){
      bestVal = v;
      cf = f;
    }
  }
  const chosen = [];
  for(let i=pool.length-1; i>=0 && ck>0; i--){
    const fromMask = choice[i][res.idx(ck,cb,cm,cf)];
    if(fromMask >= 0){
      chosen.push(pool[i]);
      ck -= 1;
      cb -= (typeof costOf === 'function' ? costOf(pool[i]) : 0);
      cm = fromMask;
      cf -= (typeof fragUnitsOf === 'function' ? fragUnitsOf(pool[i]) : 0);
      if(cf < 0) cf = 0;
    }
  }
  return chosen;
}

function getMaxOppBid(state, C){
  let maxOppBid = 0;
  const knownOppNames = (C.teamNamesAll || []).filter(t => t !== state.myTeamName);
  for(const t of knownOppNames){
    const tInfo = C.teamBudgetAndSlotsLeft(t);
    if(tInfo.slotsLeft > 0){
      const tMax = tInfo.budgetLeft - (tInfo.slotsLeft - 1);
      if(tMax > maxOppBid) maxOppBid = tMax;
    }
  }
  const unseenOpponents = Math.max(0, ((state.numTeams || 15) - 1) - knownOppNames.length);
  if(unseenOpponents > 0){
    const unseenMax = Math.max(1, (state.budget || 200) - ((state.rosterSlots || 12) - 1));
    if(unseenMax > maxOppBid) maxOppBid = unseenMax;
  }
  return maxOppBid;
}

function buildEffectiveCostMap(state, C, targetPlayers){
  const cfg = state.hillClimbConfig || {};
  const useEffectiveCost = typeof cfg.useEffectiveCost === 'boolean' ? cfg.useEffectiveCost : true;
  const costMap = new Map();
  if(!useEffectiveCost){
    for(const p of C.availableInPool) costMap.set(p.rk, C.fairPrice(p.rk));
    return costMap;
  }

  const oppStates = [];
  const knownOppNames = (C.teamNamesAll || []).filter(t => t !== state.myTeamName);
  for(const t of knownOppNames){
    const info = C.teamBudgetAndSlotsLeft(t);
    if(info.slotsLeft > 0 && info.budgetLeft > 0){
      oppStates.push({ budgetLeft: info.budgetLeft, slotsLeft: info.slotsLeft });
    }
  }
  const unseenOpponents = Math.max(0, ((state.numTeams || 15) - 1) - knownOppNames.length);
  for(let i = 0; i < unseenOpponents; i++){
    oppStates.push({
      budgetLeft: state.budget || 200,
      slotsLeft: state.rosterSlots || 12
    });
  }

  // First match the target (Dream Build) players sorted by fairPrice descending against the highest opponent bids,
  // then match the remaining available pool players sorted by fairPrice descending.
  const targetRks = new Set((targetPlayers || []).map(p => p.rk));
  const sortedPool = C.availableInPool.slice().sort((a, b) => {
    const aInT = targetRks.has(a.rk) ? 1 : 0;
    const bInT = targetRks.has(b.rk) ? 1 : 0;
    if(aInT !== bInT) return bInT - aInT;
    const fpDiff = C.fairPrice(b.rk) - C.fairPrice(a.rk);
    return fpDiff !== 0 ? fpDiff : a.rk - b.rk;
  });

  for(const p of sortedPool){
    const fp = C.fairPrice(p.rk);
    if(fp <= 1){
      costMap.set(p.rk, 1);
      continue;
    }
    let bestOppIdx = -1;
    let bestMaxLegal = 0;
    for(let i = 0; i < oppStates.length; i++){
      const opp = oppStates[i];
      if(opp.slotsLeft <= 0) continue;
      const maxLegal = Math.max(1, opp.budgetLeft - (opp.slotsLeft - 1));
      if(maxLegal > bestMaxLegal){
        bestMaxLegal = maxLegal;
        bestOppIdx = i;
      }
    }

    if(bestOppIdx === -1){
      costMap.set(p.rk, 1);
    } else {
      const effCost = Math.max(1, Math.min(fp, bestMaxLegal + 1));
      costMap.set(p.rk, effCost);

      const opp = oppStates[bestOppIdx];
      const spentByOpp = Math.max(1, Math.min(fp, bestMaxLegal));
      opp.budgetLeft = Math.max(0, opp.budgetLeft - spentByOpp);
      opp.slotsLeft = Math.max(0, opp.slotsLeft - 1);
    }
  }

  return costMap;
}

function solveDreamBuild(C, myPlayers, slotsLeft, starterSlotsLeft, benchWeight, multiCenter, valFn, starterSlots, state){
  const pool = (state && (state.doNotDraft || C.availableInPool.some(p => p.doNotDraft)))
    ? C.availableInPool.filter(p => !isDoNotDraft(p, state))
    : C.availableInPool;
  if(slotsLeft <= 0 || pool.length < slotsLeft){
    return { dreamPlayers: [], dreamVal: -1e15, dreamRks: new Set() };
  }
  const baseReach = reachableCoverage(myPlayers, multiCenter);
  const fullCoverage = multiCenter ? FULL_COVERAGE_2C : FULL_COVERAGE;
  const unitCost = () => 1;
  const totalStarterSlots = typeof starterSlots === 'number' ? starterSlots : (myPlayers.length + starterSlotsLeft);
  const maxFragility = (state && typeof state.maxFragility === 'number') ? state.maxFragility : 1.0;
  const resDream = knapsackDP(pool, unitCost, valFn, slotsLeft, slotsLeft, baseReach, starterSlotsLeft, benchWeight, multiCenter, myPlayers, totalStarterSlots, maxFragility, state);
  resDream.costOf = unitCost;
  let dreamVal = bestFeasible(resDream, slotsLeft, slotsLeft);
  let dreamMask = fullCoverage;
  if(dreamVal < -1e14){
    const fb = bestAny(resDream, slotsLeft, slotsLeft);
    dreamVal = fb.value;
    dreamMask = fb.mask;
  }
  if(dreamVal < -1e14){
    return { dreamPlayers: [], dreamVal: -1e15, dreamRks: new Set() };
  }
  const dreamPlayers = knapsackReconstruct(resDream, slotsLeft, slotsLeft, dreamMask);
  const dreamRks = new Set(dreamPlayers.map(p => p.rk));
  return { dreamPlayers, dreamVal, dreamRks };
}

// Returns null if the player isn't found or the roster is already full.
// Otherwise: { player, maxBid, soloZ, mktNow, baselineZ, baselineInfeasible,
//              alternativeNames, positionWarning, doNotDraft }
function checkPrice(state, PLAYERS, rk){
  const C = computeAll(state, PLAYERS);
  const p = PLAYERS.find(x=>x.rk===rk);
  if(!p) return null;
  const {budgetLeft, slotsLeft, picksMade} = C.teamBudgetAndSlotsLeft(state.myTeamName);
  if(slotsLeft<=0) return { player:p, full:true };

  if(isDoNotDraft(p, state)){
    const zRank = (C.zRankMap && C.zRankMap.get(rk)) || p.rk;
    const zc = C.zAll.get(p.rk);
    return {
      player: p,
      maxBid: 0,
      buildBid: 0,
      breakEvenBid: 0,
      soloZ: 0,
      mktNow: C.fairPrice(rk),
      effCost: C.fairPrice(rk),
      zRank,
      zc,
      baselineZ: null,
      baselineInfeasible: false,
      passRoster: [],
      alternativeNames: [],
      alternativeMore: false,
      inDreamBuild: false,
      isMonopoly: false,
      isEndgame: false,
      maxOppBid: getMaxOppBid(state, C),
      doNotDraft: true,
      dreamAlternativeNames: [],
      dreamAlternativeMore: false
    };
  }

  const centerMode = state.centerMode || 'hybrid';
  const multiCenter = centerMode === 'multi_center' || centerMode === 'hybrid';
  const useDynamicWeights = centerMode === 'dynamic_weights' || centerMode === 'hybrid';
  const fullCoverage = multiCenter ? FULL_COVERAGE_2C : FULL_COVERAGE;
  
  const myPicks = state.picks.filter(pk=>pk.teamName===state.myTeamName);
  const myPlayers = myPicks.map(pk=>PLAYERS.find(x=>x.rk===pk.rk)).filter(Boolean);
  const numCenters = myPlayers.filter(pl => pl.pos && pl.pos.includes('C')).length;

  const maxFragility = (state && typeof state.maxFragility === 'number') ? state.maxFragility : 1.0;
  const pFragility = getFragility(p, state);
  const currentRosterFragility = myPlayers.reduce((sum, mp) => sum + getFragility(mp, state), 0);

  if (currentRosterFragility + pFragility > maxFragility + 1e-6) {
    const zRank = (C.zRankMap && C.zRankMap.get(rk)) || p.rk;
    const zc = C.zAll.get(p.rk);
    const soloZ = (zc && C.compositeZ) ? C.compositeZ(zc) : 0;
    return {
      player: p,
      maxBid: 0,
      buildBid: 0,
      breakEvenBid: 0,
      fairPrice: C.fairPrice(rk),
      mktNow: C.fairPrice(rk),
      soloZ,
      effCost: C.fairPrice(rk),
      val: soloZ,
      zRank,
      zc,
      baselineZ: null,
      baselineInfeasible: false,
      passRoster: [],
      alternativeNames: [],
      alternativeMore: false,
      inDreamBuild: false,
      isMonopoly: false,
      isEndgame: false,
      maxOppBid: getMaxOppBid(state, C),
      fragilityCapped: true,
      fragility: pFragility,
      currentRosterFragility,
      maxFragility,
      dreamAlternativeNames: [],
      dreamAlternativeMore: false
    };
  }

  const cfg = state.hillClimbConfig || {};
  let valFn;
  let rankValFn;
  if(useDynamicWeights){
    const dynW = getDynamicCategoryWeights(state, PLAYERS, C.zAll);
    const ftGuardrail = typeof cfg.ftGuardrail === 'number' ? cfg.ftGuardrail : 1.0;
    valFn = x => {
      let z = 0;
      const zc = C.zAll.get(x.rk);
      if(zc){
        for(const c of CATS) {
          let w = dynW[c];
          if(c === 'ftPct' && zc[c] < 0 && ftGuardrail > 1.0){
            const pObj = (x && typeof x.fta === 'number') ? x : PLAYERS.find(pl => pl.rk === x.rk);
            const volumeScale = (pObj && pObj.fta > 3.0) ? Math.min(2.0, pObj.fta / 3.0) : 1.0;
            w *= ftGuardrail * volumeScale;
          }
          z += w * zc[c];
        }
      }
      return z;
    };
    rankValFn = valFn;
  } else if(multiCenter){
    valFn = x => C.compositeZ(C.zAll.get(x.rk));
    rankValFn = valFn;
  } else {
    valFn = x => {
      let z = C.compositeZ(C.zAll.get(x.rk));
      // ONLY apply the positional bonus to the nominated player (p) to prevent suppressing bids on non-centers
      if (x.rk === p.rk) {
        if (numCenters === 0 && x.pos && x.pos.includes('C')) z += 4.0;
        else if (numCenters === 1 && x.pos && x.pos.includes('C')) z += 2.0;
      }
      return z;
    };
    rankValFn = x => {
      let z = C.compositeZ(C.zAll.get(x.rk));
      if (numCenters === 0 && x.pos && x.pos.includes('C')) z += 4.0;
      else if (numCenters === 1 && x.pos && x.pos.includes('C')) z += 2.0;
      return z;
    };
  }

  const pVal = valFn(p);
  const poolExcl = C.availableInPool.filter(x => x.rk !== rk && !isDoNotDraft(x, state));
  const B = Math.max(budgetLeft, 0);
  const baseReach = reachableCoverage(myPlayers, multiCenter);
  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const benchWeight = state.benchWeight !== undefined ? state.benchWeight : 0.3;
  const starterSlotsLeft = Math.max(0, starterSlots - picksMade);

  const maxOppBid = getMaxOppBid(state, C);
  const { dreamPlayers, dreamVal, dreamRks } = solveDreamBuild(C, myPlayers, slotsLeft, starterSlotsLeft, benchWeight, multiCenter, rankValFn, starterSlots, state);
  const costMap = buildEffectiveCostMap(state, C, dreamPlayers);
  const effCostFn = x => costMap.get(x.rk) !== undefined ? costMap.get(x.rk) : C.fairPrice(x.rk);
  const dreamTotalCost = dreamPlayers.reduce((a, dp) => a + effCostFn(dp), 0);
  const isMonopoly = dreamPlayers.length === slotsLeft && dreamTotalCost <= B;

  // Only pivot costFn to rank-matched opponent bid ceiling once we have Endgame Monopoly purchasing power!
  // Before Monopoly is reached, pricing future players at fairPrice preserves mid-draft budget discipline.
  const costFn = isMonopoly ? effCostFn : (x => C.fairPrice(x.rk));

  const resExcl = knapsackDP(poolExcl, costFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, benchWeight, multiCenter, myPlayers, starterSlots, maxFragility, state);
  resExcl.costOf = costFn;

  let baseline = bestFeasible(resExcl, slotsLeft, resExcl.B);
  let baselineInfeasible = baseline < -1e14;
  let baselineMask = fullCoverage;
  if(baselineInfeasible){
    const fb = bestAny(resExcl, slotsLeft, resExcl.B);
    baseline = fb.value;
    baselineMask = fb.mask;
  }

  // Preserve natural rk sorting in poolWithP so knapsackDP evaluates starter vs bench weights consistently with runOptimizer
  const poolWithP = poolExcl.concat([p]).sort((a,b) => a.rk - b.rk);

  let bestX = 0;
  let bestXChosen = [];
  if(slotsLeft - 1 >= 0 && B >= 1){
    const useMaxOppBid = typeof cfg.useMaxOppBid === 'boolean' ? cfg.useMaxOppBid : true;
    const myMaxLegal = Math.max(1, B - (slotsLeft - 1));
    let low = 1, high = (useMaxOppBid && maxOppBid > 0) ? Math.min(myMaxLegal, maxOppBid + 1) : myMaxLegal;

    // Dual Mega-Anchor Spend Ceiling:
    // If our roster already contains an anchor who cost >= $65, cap the max bid on any secondary star
    // such that total top-2 spend does not exceed $138, preserving at least $62 for the remaining 10 slots.
    const maxSpentOnPlayer = myPicks.reduce((m, pk) => Math.max(m, pk.price || 0), 0);
    const topTwoMaxSpend = typeof cfg.topTwoMaxSpend === 'number' ? cfg.topTwoMaxSpend : 138;
    if (maxSpentOnPlayer >= 65) {
      const maxAllowedForSecond = Math.max(1, topTwoMaxSpend - maxSpentOnPlayer);
      high = Math.min(high, maxAllowedForSecond);
    }
    const betterInMy = myPlayers.filter(m => {
      const diff = valFn(m) - pVal;
      return diff > 1e-12 || (Math.abs(diff) <= 1e-12 && m.rk < p.rk);
    }).length;
    const pWouldStart = (starterSlotsLeft > 0) || (betterInMy < starterSlots);
    const starterTol = (pWouldStart && typeof cfg.starterTolerance === 'number')
      ? cfg.starterTolerance
      : (typeof cfg.benchTolerance === 'number' ? cfg.benchTolerance : 0.005);
    while(low <= high){
      const X = Math.floor((low + high) / 2);
      const customCostFn = x => (x.rk === rk ? X : costFn(x));
      const resWithP = knapsackDP(poolWithP, customCostFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, benchWeight, multiCenter, myPlayers, starterSlots, maxFragility, state);
      resWithP.costOf = customCostFn;

      let valWithP = bestFeasible(resWithP, slotsLeft, B);
      let maskToUse = fullCoverage;
      if(valWithP < -1e14){
        const fb = bestAny(resWithP, slotsLeft, B);
        valWithP = fb.value;
        maskToUse = fb.mask;
      }

      const chosen = knapsackReconstruct(resWithP, slotsLeft, B, maskToUse);
      const pWasTaken = chosen.some(x => x.rk === rk);

      if(pWasTaken && (valWithP >= baseline - starterTol)){
        bestX = X;
        bestXChosen = chosen;
        low = X + 1;
      } else {
        high = X - 1;
      }
    }
  }

  let breakEvenBid = bestX;
  let buildBid = null;
  if(isMonopoly){
    if(dreamRks.has(rk)){
      const dreamMarketCost = dreamPlayers.reduce((a, dp) => a + C.fairPrice(dp.rk), 0);
      const otherDreamPlayers = dreamPlayers.filter(x => x.rk !== rk);
      const otherCostMap = buildEffectiveCostMap(state, C, otherDreamPlayers);
      const otherDreamEffCost = otherDreamPlayers.reduce((a, dp) => a + (otherCostMap.get(dp.rk) !== undefined ? otherCostMap.get(dp.rk) : C.fairPrice(dp.rk)), 0);
      const myMaxLegal = Math.max(1, B - (slotsLeft - 1));
      const oppCap = maxOppBid > 0 ? maxOppBid + 1 : myMaxLegal;
      let maxToKeepDream;
      const minDefend = Math.min(2, B - otherDreamEffCost);
      if(dreamMarketCost <= B && slotsLeft > 1){
        const otherMarketCost = dreamMarketCost - C.fairPrice(rk);
        const propShare = Math.round(C.fairPrice(rk) * (B / Math.max(1, dreamMarketCost)) * 1.15);
        maxToKeepDream = Math.max(C.fairPrice(rk), minDefend, Math.min(B - otherMarketCost, propShare));
      } else {
        maxToKeepDream = Math.max(effCostFn(p), B - otherDreamEffCost);
      }
      buildBid = Math.min(myMaxLegal, oppCap, maxToKeepDream);
      bestX = buildBid;
      breakEvenBid = Math.max(breakEvenBid, buildBid);
    } else {
      bestX = 0;
    }
  }

  const passRoster = (baseline < -1e14) ? [] : knapsackReconstruct(resExcl, slotsLeft, resExcl.B, baselineMask);
  const passRosterSorted = passRoster.slice().sort((a,b)=>costFn(b)-costFn(a) || rankValFn(b)-rankValFn(a));
  const zRank = (C.zRankMap && C.zRankMap.get(rk)) || p.rk;
  const zc = C.zAll.get(p.rk);
  const dreamSorted = dreamPlayers.slice().sort((a,b) => rankValFn(b) - rankValFn(a));
  const myMaxBid = Math.max(1, B - (slotsLeft - 1));
  const isEndgame = isMonopoly || myMaxBid > maxOppBid || maxOppBid <= 25 || slotsLeft <= 5;

  return {
    player: p, maxBid: bestX, buildBid, breakEvenBid, soloZ: pVal, mktNow: C.fairPrice(rk),
    effCost: effCostFn(p),
    zRank, zc,
    baselineZ: baseline > -1e14 ? baseline : null, baselineInfeasible,
    passRoster: passRosterSorted,
    alternativeNames: passRosterSorted.slice(0,2).map(x=>x.name),
    alternativeMore: passRosterSorted.length>2,
    inDreamBuild: dreamRks.has(rk),
    isMonopoly,
    isEndgame,
    maxOppBid,
    dreamAlternativeNames: dreamSorted.filter(x => x.rk !== rk).slice(0, 3).map(x => x.name),
    dreamAlternativeMore: dreamSorted.filter(x => x.rk !== rk).length > 3,
    fragility: pFragility,
    currentRosterFragility,
    maxFragility,
    fragilityCapped: false
  };
}

// ---------- team optimizer (ported from Draft Edge's runOptimizer, verbatim
// math) ----------
// "Best possible team right now": an exact knapsack over every available
// player, priced at market valuation (not the model's own z-value), against
// remaining budget/slots — this is what Alex uses to see who's worth
// nominating or watching for, not just what one specific player is worth.
// Returns null only when the roster is already full; otherwise a data object
// for the caller to render (no DOM work here, unlike Draft Edge's original
// which wrote straight to the page).
function runOptimizer(state, PLAYERS){
  const C = computeAll(state, PLAYERS);
  const {budgetLeft, slotsLeft, picksMade} = C.teamBudgetAndSlotsLeft(state.myTeamName);
  if(slotsLeft<=0) return { full: true };

  // Dual Mega-Anchor Guardrail for Team Optimizer:
  // A viable 8-cat roster should never build around multiple $65+ anchors (e.g. Jokic + Wemby),
  // which leaves only $3-4/slot for depth. Constrain the optimizer to at most one $65+ anchor.
  if(!state._skipAnchorConstraint){
    const myPicks = (state.picks || []).filter(pk => pk.teamName === state.myTeamName);
    const myMegaAnchors = myPicks.filter(pk => (pk.price || 0) >= 65 || C.fairPrice(pk.rk) >= 65);
    const availableMegaAnchors = C.availableInPool.filter(p => !isDoNotDraft(p, state) && C.fairPrice(p.rk) >= 65);
    const existingDnd = Array.isArray(state.doNotDraft)
      ? state.doNotDraft
      : (state.doNotDraft instanceof Set ? Array.from(state.doNotDraft) : []);

    if(myMegaAnchors.length >= 1){
      if(availableMegaAnchors.length > 0){
        const subState = {
          ...state,
          _skipAnchorConstraint: true,
          doNotDraft: [...existingDnd, ...availableMegaAnchors.map(m => m.rk)]
        };
        return runOptimizer(subState, PLAYERS);
      }
    } else if(availableMegaAnchors.length > 1){
      let bestResult = null;
      const allAnchorsRks = availableMegaAnchors.map(m => m.rk);
      const balancedState = {
        ...state,
        _skipAnchorConstraint: true,
        doNotDraft: [...existingDnd, ...allAnchorsRks]
      };
      const balancedOpt = runOptimizer(balancedState, PLAYERS);
      if(balancedOpt && !balancedOpt.infeasible && !balancedOpt.full){
        bestResult = balancedOpt;
      }

      for(const anchor of availableMegaAnchors){
        const otherAnchors = availableMegaAnchors.filter(m => m.rk !== anchor.rk).map(m => m.rk);
        const subState = {
          ...state,
          _skipAnchorConstraint: true,
          doNotDraft: [...existingDnd, ...otherAnchors]
        };
        const candidateOpt = runOptimizer(subState, PLAYERS);
        if(candidateOpt && !candidateOpt.infeasible && !candidateOpt.full){
          const cVal = typeof candidateOpt.bestVal === 'number' ? candidateOpt.bestVal : (candidateOpt.val || 0);
          const bVal = bestResult ? (typeof bestResult.bestVal === 'number' ? bestResult.bestVal : (bestResult.val || 0)) : -1e14;
          if(!bestResult || cVal > bVal){
            bestResult = candidateOpt;
          }
        }
      }
      if(bestResult){
        return bestResult;
      }
    }
  }

  const centerMode = state.centerMode || 'hybrid';
  const multiCenter = centerMode === 'multi_center' || centerMode === 'hybrid';
  const useDynamicWeights = centerMode === 'dynamic_weights' || centerMode === 'hybrid';
  const fullCoverage = multiCenter ? FULL_COVERAGE_2C : FULL_COVERAGE;

  const myPicks = state.picks.filter(pk=>pk.teamName===state.myTeamName);
  const myPlayers = myPicks.map(pk=>PLAYERS.find(x=>x.rk===pk.rk)).filter(Boolean);
  const numCenters = myPlayers.filter(pl => pl.pos && pl.pos.includes('C')).length;

  const cfg = state.hillClimbConfig || {};
  let valFn;
  if(useDynamicWeights){
    const dynW = getDynamicCategoryWeights(state, PLAYERS, C.zAll);
    const ftGuardrail = typeof cfg.ftGuardrail === 'number' ? cfg.ftGuardrail : 1.0;
    valFn = p => {
      let z = 0;
      const zc = C.zAll.get(p.rk);
      if(zc){
        for(const c of CATS) {
          let w = dynW[c];
          if(c === 'ftPct' && zc[c] < 0 && ftGuardrail > 1.0){
            const pObj = (p && typeof p.fta === 'number') ? p : PLAYERS.find(pl => pl.rk === p.rk);
            const volumeScale = (pObj && pObj.fta > 3.0) ? Math.min(2.0, pObj.fta / 3.0) : 1.0;
            w *= ftGuardrail * volumeScale;
          }
          z += w * zc[c];
        }
      }
      return z;
    };
  } else if(multiCenter){
    valFn = p => C.compositeZ(C.zAll.get(p.rk));
  } else {
    valFn = p => {
      let z = C.compositeZ(C.zAll.get(p.rk));
      if (numCenters === 0 && p.pos && p.pos.includes('C')) z += 4.0;
      else if (numCenters === 1 && p.pos && p.pos.includes('C')) z += 2.0;
      return z;
    };
  }

  const baseReach = reachableCoverage(myPlayers, multiCenter);
  const B = Math.max(budgetLeft,0);
  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const benchWeight = state.benchWeight !== undefined ? state.benchWeight : 0.3;
  const starterSlotsLeft = Math.max(0, starterSlots - picksMade);

  const maxOppBid = getMaxOppBid(state, C);
  const { dreamPlayers, dreamVal, dreamRks } = solveDreamBuild(C, myPlayers, slotsLeft, starterSlotsLeft, benchWeight, multiCenter, valFn, starterSlots, state);
  const costMap = buildEffectiveCostMap(state, C, dreamPlayers);
  const effCostFn = p => costMap.get(p.rk) !== undefined ? costMap.get(p.rk) : C.fairPrice(p.rk);
  const dreamTotalCost = dreamPlayers.reduce((a, p) => a + effCostFn(p), 0);
  const dreamMarketCost = dreamPlayers.reduce((a, p) => a + C.fairPrice(p.rk), 0);
  const canSweepDream = dreamPlayers.length === slotsLeft && dreamTotalCost <= B;

  const costFn = canSweepDream ? effCostFn : (p => C.fairPrice(p.rk));
  const optPool = (state && (state.doNotDraft || C.availableInPool.some(p => p.doNotDraft)))
    ? C.availableInPool.filter(p => !isDoNotDraft(p, state))
    : C.availableInPool;
  const maxFragility = (state && typeof state.maxFragility === 'number') ? state.maxFragility : 1.0;
  const res = knapsackDP(optPool, costFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, benchWeight, multiCenter, myPlayers, starterSlots, maxFragility, state);
  res.costOf = costFn;
  let bestVal = bestFeasible(res, slotsLeft, res.B);
  let posWarning = null;
  let chosen;
  if(bestVal < -1e14){
    const missing = missingCorePositions(myPlayers.concat(C.availableInPool));
    const fallback = bestAny(res, slotsLeft, res.B);
    if(fallback.value < -1e14){
      return { infeasible: true, budgetLeft, slotsLeft };
    }
    bestVal = fallback.value;
    posWarning = missing.length
      ? `No legal full team fits — nothing left in the pool plays ${missing.join(', ')}. This build is the best available anyway, but you'll need a trade or a waiver stream to actually field it.`
      : `The highest-value build within your budget/slots can't cover every named position — this is the best fully-legal fallback found.`;
    chosen = knapsackReconstruct(res, slotsLeft, res.B, fallback.mask);
  } else {
    chosen = knapsackReconstruct(res, slotsLeft, res.B, fullCoverage);
  }
  const sortedMyForExisting = myPlayers.slice().sort((a, b) => {
    const diff = valFn(b) - valFn(a);
    return Math.abs(diff) > 1e-12 ? diff : (a.rk - b.rk);
  });
  const existingZ = sortedMyForExisting.reduce((a, p, idx)=>{
    const zc = C.zAll.get(p.rk);
    const w = (idx < starterSlots) ? 1.0 : benchWeight;
    return a + w * (zc ? C.compositeZ(zc) : 0);
  }, 0);
  const totalCost = chosen.reduce((a,p)=>a+costFn(p),0);
  const catTotals = {};
  for(const c of CATS){
    catTotals[c] = chosen.reduce((a,p)=>a+C.zAll.get(p.rk)[c],0) + myPicks.reduce((a,pk)=>{ const zc=C.zAll.get(pk.rk); return a+(zc?zc[c]:0); },0);
  }
  const finalReach = reachableCoverage(myPlayers.concat(chosen));
  const fullyCovered = !!finalReach[FULL_COVERAGE];
  const posCoverage = CORE_POS.map(pos=>({
    pos, covered: fullyCovered || myPlayers.concat(chosen).some(p=>p.pos && p.pos.includes(pos)),
  }));

  const chosenRks = new Set(chosen.map(p => p.rk));
  const sameAsDream = dreamPlayers.length > 0 && chosen.length === dreamPlayers.length && dreamPlayers.every(dp => chosenRks.has(dp.rk));
  const isMonopoly = canSweepDream || sameAsDream || (dreamVal > -1e14 && Math.abs(bestVal - dreamVal) < 1e-6);
  const myMaxBid = Math.max(1, B - (slotsLeft - 1));
  const isEndgame = isMonopoly || myMaxBid > maxOppBid || maxOppBid <= 25 || slotsLeft <= 5;

  const baitPlayers = [];
  if(!isMonopoly && maxOppBid >= 2 && myMaxBid >= 2){
    const minBaitPrice = isEndgame ? 3 : 15;
    for(const p of C.availableInPool){
      if(dreamRks.has(p.rk) || chosenRks.has(p.rk)) continue;
      const fp = C.fairPrice(p.rk);
      if(fp >= minBaitPrice){
        baitPlayers.push({
          rk: p.rk,
          name: p.name,
          pos: p.pos,
          team: p.team,
          fairPrice: fp,
          z: C.baseCompositeZ(C.zAll.get(p.rk)),
        });
      }
    }
    baitPlayers.sort((a,b) => b.fairPrice - a.fairPrice || a.rk - b.rk);
  }
  const topBaitPlayers = baitPlayers.slice(0, 3);

  // --- Snipe Detection Pass ---
  // Identify high-value players acquirable well below market value because
  // opponents lack the budget to compete.
  const snipes = [];
  for(const p of C.availableInPool) {
    if(isDoNotDraft(p, state)) continue;
    const fp = C.fairPrice(p.rk);
    const snipeCost = Math.min(fp, maxOppBid + 1);
    if(snipeCost < fp * 0.5) {
      const zc = C.zAll.get(p.rk);
      snipes.push({
        rk: p.rk,
        name: p.name,
        pos: p.pos,
        team: p.team,
        compositeZ: zc ? C.compositeZ(zc) : 0,
        fairPrice: fp,
        snipeCost,
        surplus: fp - snipeCost,
      });
    }
  }
  snipes.sort((a,b) => b.compositeZ - a.compositeZ);
  const topSnipes = snipes.slice(0, 5);

  return {
    posWarning, budgetLeft, slotsLeft, bestVal, totalCost, existingZ,
    catTotals, posCoverage,
    isMonopoly,
    isEndgame,
    maxOppBid,
    totalFragility: (chosen || []).concat(myPlayers || []).reduce((sum, p) => sum + getFragility(p, state), 0),
    maxFragility,
    players: chosen.slice().sort((a,b)=>costFn(b)-costFn(a) || C.fairPrice(b.rk)-C.fairPrice(a.rk) || valFn(b)-valFn(a)).map(p=>({
      rk: p.rk, name: p.name, pos: p.pos, team: p.team, cost: costFn(p), fairPrice: C.fairPrice(p.rk), z: C.baseCompositeZ(C.zAll.get(p.rk)), inDreamBuild: dreamRks.has(p.rk), fragility: getFragility(p, state)
    })),
    dreamVal: dreamVal > -1e14 ? dreamVal : bestVal,
    dreamTotalCost,
    dreamMarketCost,
    dreamPlayers: isEndgame ? dreamPlayers.slice().sort((a,b)=>C.fairPrice(b.rk)-C.fairPrice(a.rk) || valFn(b)-valFn(a)).map(p=>({
      rk: p.rk, name: p.name, pos: p.pos, team: p.team, cost: effCostFn(p), fairPrice: C.fairPrice(p.rk), z: C.baseCompositeZ(C.zAll.get(p.rk)), inBudgetBuild: chosenRks.has(p.rk), fragility: getFragility(p, state)
    })) : [],
    baitPlayers: topBaitPlayers,
    snipes: topSnipes,
  };
}

// ---------- name matching ----------
// Yahoo displays names slightly differently in places (suffixes, accents,
// abbreviated first names for space). Normalize aggressively and fall back to
// a token-overlap match so "Nic Claxton" -> "Nicolas Claxton" still resolves.
const NAME_ALIASES = {
  'nic claxton': 'nicolas claxton',
  'alex sarr': 'alexandre sarr',
  'cam thomas': 'cameron thomas',
  'herb jones': 'herbert jones',
  'og anunoby': 'og anunoby',
  'porzingus': 'kristaps porzingis',
  'kristaps porzingus': 'kristaps porzingis',
  'embiid': 'joel embiid',
  'jimmy butler': 'jimmy butler iii',
};

function stripDiacritics(s){
  return s.normalize ? s.normalize('NFD').replace(/[̀-ͯ]/g,'') : s;
}
function normName(s){
  if(!s) return '';
  let n = stripDiacritics(s).toLowerCase();
  n = n.replace(/[.'']/g,'');
  n = n.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g,'');
  n = n.replace(/[^a-z\s-]/g,' ');
  n = n.replace(/\s+/g,' ').trim();
  return NAME_ALIASES[n] || n;
}

function matchPlayer(rawName, PLAYERS, byNorm, teamOrPosHint){
  const n = normName(rawName);
  if(!n) return null;
  if(byNorm.has(n)) return byNorm.get(n);
  // token-overlap fallback: last name must match, first name may be truncated/nicknamed
  const parts = n.split(' ');
  const last = parts[parts.length-1];
  let candidates = PLAYERS.filter(p=>{
    const pn = normName(p.name).split(' ');
    return pn[pn.length-1] === last;
  });

  if(parts.length > 1){
    const first = parts[0];
    const compatible = candidates.filter(p => {
      const candFirst = normName(p.name).split(' ')[0];
      return candFirst === first ||
             candFirst.startsWith(first) ||
             first.startsWith(candFirst) ||
             (candFirst.length > 0 && first.length > 0 && candFirst[0] === first[0]);
    });
    if(compatible.length > 0){
      candidates = compatible;
    } else {
      return null;
    }
  }

  if(candidates.length===1) return candidates[0];
  if(candidates.length>1){
    if(teamOrPosHint){
      const hint = String(teamOrPosHint).toUpperCase();
      const byTeam = candidates.filter(p => p.team && hint.includes(p.team.toUpperCase()));
      if(byTeam.length === 1) return byTeam[0];
      if(byTeam.length > 1) {
        candidates = byTeam;
      }
    }
    const first = parts[0];
    const exact = candidates.find(p=> normName(p.name).split(' ')[0] === first);
    if(exact) return exact;
    const starts = candidates.find(p=> normName(p.name).split(' ')[0].startsWith(first) || first.startsWith(normName(p.name).split(' ')[0]));
    if(starts) return starts;
  }
  return null;
}

function buildNameIndex(PLAYERS){
  const byNorm = new Map();
  for(const p of PLAYERS) byNorm.set(normName(p.name), p);
  return byNorm;
}

function isDoNotDraft(p, state){
  if(!p) return false;
  if(p.doNotDraft) return true;
  if(!state) return false;
  const dnd = state.doNotDraft;
  if(!dnd) return false;
  if(dnd instanceof Set){
    if(dnd.has(p.rk) || dnd.has(p.name)) return true;
    const pNorm = normName(p.name);
    for(const item of dnd){
      if(typeof item === 'string' && normName(item) === pNorm) return true;
    }
    return false;
  }
  if(Array.isArray(dnd)){
    if(dnd.includes(p.rk) || dnd.includes(p.name)) return true;
    const pNorm = normName(p.name);
    return dnd.some(item => {
      if(typeof item === 'string') return normName(item) === pNorm;
      if(item && typeof item === 'object' && (item.name || item.player)){
        return normName(item.name || item.player) === pNorm || item.rk === p.rk;
      }
      return false;
    });
  }
  return false;
}

const FRAGILITY_TIERS = {
  1.0: new Set([
    'kawhi leonard', 'joel embiid', 'jimmy butler iii', 'kyrie irving',
    'lamelo ball', 'lauri markkanen', 'zion williamson'
  ]),
  0.5: new Set([
    'stephen curry', 'lebron james', 'kevin durant', 'anthony davis',
    'zach edey', 'jayson tatum', 'dejounte murray', 'paul george',
    'tyrese haliburton', 'domantas sabonis', 'damian lillard',
    'walker kessler', 'jalen suggs', 'kon knueppel'
  ])
};

function getFragility(p, state){
  if(!p) return 0;
  if(isDoNotDraft(p, state)) return Infinity;
  if(typeof p.fragility === 'number') return p.fragility;
  const pNorm = normName(p.name);
  if(FRAGILITY_TIERS[1.0].has(pNorm)) return 1.0;
  if(FRAGILITY_TIERS[0.5].has(pNorm)) return 0.5;
  return 0;
}

function getFragUnits(p, state){
  const f = getFragility(p, state);
  if(f === Infinity) return 999;
  return Math.round(f * 2);
}

if(typeof module !== 'undefined'){
  module.exports = {
    computeAll, checkPrice, runOptimizer, matchPlayer, buildNameIndex,
    normName, isDoNotDraft, getFragility, getFragUnits, FRAGILITY_TIERS,
    CATS, CAT_LABEL, CORE_POS
  };
}


