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
  if (p.pos) {
    for(const pos of p.pos){ const i = CORE_POS.indexOf(pos); if(i>=0) m |= (1<<i); }
  }
  return m;
}

// state = { numTeams, rosterSlots, budget, myTeamName, weights, picks:[{rk,teamName,price,ts}] }
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
    let s=0; for(const c of CATS) s += zc[c]; return s;
  }

  const availSortedBase = availableInPool.slice().sort((a,b)=> baseCompositeZ(zAll.get(b.rk)) - baseCompositeZ(zAll.get(a.rk)));
  const draftedCount = state.picks.length;
  const remainingSlots = clamp(poolSize - draftedCount, 0, poolSize);
  const replIdx = clamp(remainingSlots-1, 0, Math.max(0,availSortedBase.length-1));
  const winLo = clamp(replIdx-4,0,availSortedBase.length-1);
  const winHi = clamp(replIdx+5,0,availSortedBase.length);
  const replWindowBase = availSortedBase.slice(winLo, Math.max(winHi, winLo+1));
  const replZBase = {};
  for(const c of CATS){
    replZBase[c] = replWindowBase.length ? mean(replWindowBase.map(p=>zAll.get(p.rk)[c])) : 0;
  }

  const teamNamesAll = Array.from(new Set(state.picks.map(p=>p.teamName).concat(state.myTeamName ? [state.myTeamName] : [])));
  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const benchWeightConf = state.benchWeight !== undefined ? state.benchWeight : 0.3;
  const teamProjBase = teamNamesAll.map(name=>{
      const picksOfTeam = state.picks.filter(pk=>pk.teamName===name);
      const proj = {};
      const numPicks = picksOfTeam.length;
      const emptyStarters = Math.max(0, starterSlots - numPicks);
      const emptyBench = Math.max(0, state.rosterSlots - Math.max(starterSlots, numPicks));
      for(const c of CATS){
        let s = emptyStarters * replZBase[c] + emptyBench * benchWeightConf * replZBase[c];
        picksOfTeam.forEach((pk, idx)=>{
          const zc = zAll.get(pk.rk);
          if(zc){
            const w = (idx < starterSlots) ? 1.0 : benchWeightConf;
            s += w * zc[c];
          }
        });
        proj[c] = s;
      }
      return {name, proj};
  });

  const myProj = teamProjBase.find(t => t.name === state.myTeamName);
  const dynWeights = {};
  for(const c of CATS) {
      if(!myProj || teamProjBase.length < 2) {
          dynWeights[c] = 1.0;
          continue;
      }
      let minDist = 1e9;
      for(const t of teamProjBase) {
          if(t.name === state.myTeamName) continue;
          const dist = Math.abs(t.proj[c] - myProj.proj[c]);
          if(dist < minDist) minDist = dist;
      }
      const catVals = teamProjBase.map(t => t.proj[c]);
      const catSd = stdev(catVals, mean(catVals));
      const normDist = catSd > 0 ? minDist / catSd : 0;
      dynWeights[c] = Math.max(0.6, Math.exp(-Math.pow(normDist, 2) / 2) * 1.5);
  }

  function compositeZ(zc){
    let s=0; for(const c of CATS) s += dynWeights[c]*zc[c];
    return s;
  }

  const playerZScores = PLAYERS.map(p => ({
    rk: p.rk,
    compositeZ: compositeZ(zAll.get(p.rk))
  })).sort((a,b) => b.compositeZ - a.compositeZ);

  const zRankMap = new Map();
  playerZScores.forEach((item, index) => {
    zRankMap.set(item.rk, index + 1);
  });

  const availSortedByComposite = availableInPool.slice().sort((a,b)=> compositeZ(zAll.get(b.rk)) - compositeZ(zAll.get(a.rk)));
  const replWindow = availSortedByComposite.slice(winLo, Math.max(winHi, winLo+1));
  const replZ = {};
  for(const c of CATS){
    replZ[c] = replWindow.length ? mean(replWindow.map(p=>zAll.get(p.rk)[c])) : 0;
  }

  const totalSlots = state.numTeams * state.rosterSlots;
  const remainingGlobalSlots = Math.max(0, totalSlots - draftedCount);
  const slotsPerPos = remainingGlobalSlots / CORE_POS.length;
  const posScarcity = {};
  for(const pos of CORE_POS) {
      const viableRemaining = availableInPool.filter(p => p.pos && p.pos.includes(pos) && baseCompositeZ(zAll.get(p.rk)) > 0.5).length;
      posScarcity[pos] = viableRemaining > 0 ? (slotsPerPos / viableRemaining) : 1.5; 
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

  const myPicks = state.picks.filter(p=>p.teamName===state.myTeamName).map(pk=>rosterPoolByRk.get(pk.rk) || PLAYERS.find(p=>p.rk===pk.rk)).filter(Boolean);
  let reach = 0;
  for(const p of myPicks) reach |= posMaskOf(p);
  const missingPos = CORE_POS.filter((_,i)=> !(reach & (1<<i)));

  let powerRankings = [];
  if(teamNamesAll.length){
    const n = teamNamesAll.length;
    const teamProjZFinal = teamNamesAll.map(name=>{
      const picksOfTeam = state.picks.filter(pk=>pk.teamName===name);
      const proj = {};
      const numPicks = picksOfTeam.length;
      const emptyStarters = Math.max(0, starterSlots - numPicks);
      const emptyBench = Math.max(0, state.rosterSlots - Math.max(starterSlots, numPicks));
      for(const c of CATS){
        let s = emptyStarters * replZ[c] + emptyBench * benchWeightConf * replZ[c];
        picksOfTeam.forEach((pk, idx)=>{
          const zc = zAll.get(pk.rk);
          if(zc){
            const w = (idx < starterSlots) ? 1.0 : benchWeightConf;
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
      const values = teamProjZFinal.map(t=>t[c]);
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
    const totals = teamNamesAll.map((_,i)=> CATS.reduce((a,c)=>a + (n+1-rankOfCat[c][i]), 0));
    powerRankings = teamNamesAll.map((name,i)=>{
      const {budgetLeft} = teamBudgetAndSlotsLeft(name);
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

  return {
    poolSize, rosterPool, availableInPool, zAll, compositeZ, replZ,
    fairPrice, remainingBudgetAllTeams, remainingSlots, draftedCount, inflation,
    myBudgetLeft: my.budgetLeft, mySlotsLeft: my.slotsLeft, myPicksMade: my.picksMade,
    missingPos, teamBudgetAndSlotsLeft, powerRankings, zRankMap, teamNamesAll, dynWeights, posScarcity, myPicks
  };
}

const FULL_COVERAGE = (1<<CORE_POS.length)-1;
const COVERAGE_STATES = 1<<CORE_POS.length;

function reachableCoverage(players){
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
}
function missingCorePositions(players){
  const reach = reachableCoverage(players);
  if(reach[FULL_COVERAGE]) return [];
  const haveAny = new Set();
  for(const p of players){ const pm = posMaskOf(p); for(let j=0;j<CORE_POS.length;j++) if(pm & (1<<j)) haveAny.add(CORE_POS[j]); }
  const zeroEligible = CORE_POS.filter(pos=>!haveAny.has(pos));
  return zeroEligible.length ? zeroEligible : ['(position conflict)'];
}

function knapsackDP(pool, costFn, valFn, capBudget, capSlots, baseReach, starterSlotsLeft, benchWeight){
  const n = pool.length;
  const B = Math.max(0, Math.floor(capBudget));
  const K = Math.max(0, Math.floor(capSlots));
  const M = COVERAGE_STATES;
  const NEG = -1e15;
  const reach0 = baseReach || (()=>{ const r = new Uint8Array(M); r[0]=1; return r; })();
  const idx = (k,b,mask) => (k*(B+1)+b)*M+mask;
  let dp = new Float64Array((K+1)*(B+1)*M).fill(NEG);
  for(let b=0;b<=B;b++) for(let mask=0;mask<M;mask++) if(reach0[mask]) dp[idx(0,b,mask)] = 0;
  const choice = new Array(n);
  const sSlots = (starterSlotsLeft !== undefined) ? starterSlotsLeft : K;

  for(let i=0;i<n;i++){
    const cost = Math.round(costFn(pool[i]));
    const baseValStarter = valFn(pool[i], true);
    const baseValBench = valFn(pool[i], false);
    const pm = posMaskOf(pool[i]);
    const newDp = dp.slice();
    const take = new Int8Array((K+1)*(B+1)*M).fill(-1);
    if(cost <= B){
      for(let k=K;k>=1;k--){
        const itemVal = (k <= sSlots) ? baseValStarter : baseValBench;
        for(let b=B;b>=cost;b--){
          for(let mask=0;mask<M;mask++){
            const srcVal = dp[idx(k-1,b-cost,mask)];
            if(srcVal <= NEG/2) continue;
            const withItem = srcVal + itemVal;
            const t0 = idx(k,b,mask);
            if(withItem > newDp[t0]){ newDp[t0] = withItem; take[t0] = mask; }
            for(let j=0;j<CORE_POS.length;j++){
              if((pm & (1<<j)) && !(mask & (1<<j))){
                const t1 = idx(k,b,mask|(1<<j));
                if(withItem > newDp[t1]){ newDp[t1] = withItem; take[t1] = mask; }
              }
            }
          }
        }
      }
    }
    dp = newDp;
    choice[i] = take;
  }
  return {dp, choice, pool, B, K, M, idx};
}
function bestFeasible(res, k, b){ return res.dp[res.idx(k,b,FULL_COVERAGE)]; }
function bestAny(res, k, b){
  let best = -1e15, bestMask = 0;
  for(let mask=0; mask<res.M; mask++){
    const v = res.dp[res.idx(k,b,mask)];
    if(v > best){ best = v; bestMask = mask; }
  }
  return {value: best, mask: bestMask};
}
function knapsackReconstruct(res, k, b, mask){
  const {choice, pool} = res;
  let ck=k, cb=b, cm=mask;
  const chosen = [];
  for(let i=pool.length-1; i>=0 && ck>0; i--){
    const fromMask = choice[i][res.idx(ck,cb,cm)];
    if(fromMask >= 0){
      chosen.push(pool[i]);
      ck -= 1;
      cb -= res.costOf(pool[i]);
      cm = fromMask;
    }
  }
  return chosen;
}

function buildValFn(C) {
  return (x, isStarter = true) => {
    let z = 0;
    const zc = C.zAll.get(x.rk);
    if(zc) {
        for(const c of CATS) {
            let w = C.dynWeights[c] || 1.0;
            if (!isStarter) {
                if (c === 'fgPct' || c === 'ftPct') {
                    w *= (zc[c] < 0 ? 0.8 : 0.2);
                } else {
                    w *= 0.2;
                }
            }
            z += w * zc[c];
        }
    }
    // Original hardcoded Center bonus
    const numCenters = C.myPicks && C.myPicks.length > 0 ? C.myPicks.filter(pl => pl.pos && pl.pos.includes('C')).length : 0;
    if (numCenters === 0 && x.pos && x.pos.includes('C')) z += 4.0;
    else if (numCenters === 1 && x.pos && x.pos.includes('C')) z += 2.0;
    return z;
  };
}

function checkPrice(state, PLAYERS, rk){
  const C = computeAll(state, PLAYERS);
  const p = PLAYERS.find(x=>x.rk===rk);
  if(!p) return null;
  const {budgetLeft, slotsLeft, picksMade} = C.teamBudgetAndSlotsLeft(state.myTeamName);
  if(slotsLeft<=0) return { player:p, full:true };
  const costFn = x=>C.fairPrice(x.rk);
  
  const myPicks = state.picks.filter(pk=>pk.teamName===state.myTeamName);
  const myPlayers = myPicks.map(pk=>PLAYERS.find(x=>x.rk===pk.rk)).filter(Boolean);
  const valFn = buildValFn(C);
  
  const pZc = C.zAll.get(p.rk);
  const pVal = valFn(p, true);
  const poolExcl = C.availableInPool.filter(x=>x.rk!==rk);
  const B = Math.max(budgetLeft, 0);
  const baseReach = reachableCoverage(myPlayers);
  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const starterSlotsLeft = Math.max(0, starterSlots - picksMade);

  let maxOppBid = 0;
  for(const t of C.teamNamesAll || []) {
      if(t === state.myTeamName) continue;
      const tInfo = C.teamBudgetAndSlotsLeft(t);
      if(tInfo.slotsLeft > 0) {
          const tMax = tInfo.budgetLeft - (tInfo.slotsLeft - 1);
          if(tMax > maxOppBid) maxOppBid = tMax;
      }
  }

  const resExcl = knapsackDP(poolExcl, costFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, null);
  resExcl.costOf = costFn;

  let baseline = bestFeasible(resExcl, slotsLeft, resExcl.B);
  let baselineInfeasible = baseline < -1e14;
  let baselineMask = FULL_COVERAGE;
  if(baselineInfeasible){
    const fb = bestAny(resExcl, slotsLeft, resExcl.B);
    baseline = fb.value;
    baselineMask = fb.mask;
  }

  const poolWithP = C.availableInPool.some(x => x.rk === rk)
    ? C.availableInPool
    : poolExcl.concat([p]).sort((a,b) => a.rk - b.rk);

  let bestX = 0;
  let bestXChosen = [];
  if(slotsLeft - 1 >= 0 && B >= 1){
    let low = 1, high = maxOppBid > 0 ? Math.min(B, maxOppBid + 1) : B;
    while(low <= high){
      const X = Math.floor((low + high) / 2);
      const customCostFn = x => (x.rk === rk ? X : costFn(x));
      const resWithP = knapsackDP(poolWithP, customCostFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, null);
      resWithP.costOf = customCostFn;

      let valWithP = bestFeasible(resWithP, slotsLeft, B);
      let maskToUse = FULL_COVERAGE;
      if(valWithP < -1e14){
        const fb = bestAny(resWithP, slotsLeft, B);
        valWithP = fb.value;
        maskToUse = fb.mask;
      }

      const chosen = knapsackReconstruct(resWithP, slotsLeft, B, maskToUse);
      const pWasTaken = chosen.some(x => x.rk === rk);

      if(pWasTaken && valWithP >= baseline){
        bestX = X;
        bestXChosen = chosen;
        low = X + 1;
      } else {
        high = X - 1;
      }
    }
  }

  const passRoster = (baseline < -1e14) ? [] : knapsackReconstruct(resExcl, slotsLeft, resExcl.B, baselineMask);
  const restAtBestX = bestXChosen.filter(x => x.rk !== rk);
  const zRank = (C.zRankMap && C.zRankMap.get(rk)) || p.rk;
  const zc = C.zAll.get(p.rk);

  return {
    player: p, maxBid: bestX, soloZ: pVal, mktNow: C.fairPrice(rk),
    zRank, zc,
    baselineZ: baseline > -1e14 ? baseline : null, baselineInfeasible,
    passRoster: passRoster.slice().sort((a,b)=>costFn(b)-costFn(a)),
    alternativeNames: restAtBestX.slice(0,2).map(x=>x.name),
    alternativeMore: restAtBestX.length>2,
  };
}

function runOptimizer(state, PLAYERS){
  const C = computeAll(state, PLAYERS);
  const {budgetLeft, slotsLeft, picksMade} = C.teamBudgetAndSlotsLeft(state.myTeamName);
  if(slotsLeft<=0) return { full: true };
  const costFn = p=>C.fairPrice(p.rk);
  const myPicks = state.picks.filter(pk=>pk.teamName===state.myTeamName);
  const myPlayers = myPicks.map(pk=>PLAYERS.find(x=>x.rk===pk.rk)).filter(Boolean);
  const valFn = buildValFn(C);
  const baseReach = reachableCoverage(myPlayers);
  const B = Math.max(budgetLeft,0);
  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const starterSlotsLeft = Math.max(0, starterSlots - picksMade);
  const res = knapsackDP(C.availableInPool, costFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, null);
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
    chosen = knapsackReconstruct(res, slotsLeft, res.B, FULL_COVERAGE);
  }
  const existingZ = myPicks.reduce((a,pk)=>{ const zc=C.zAll.get(pk.rk); return a + (zc?C.compositeZ(zc):0); },0);
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
  return {
    posWarning, budgetLeft, slotsLeft, bestVal, totalCost, existingZ,
    catTotals, posCoverage,
    players: chosen.slice().sort((a,b)=>costFn(b)-costFn(a)).map(p=>({
      rk: p.rk, name: p.name, pos: p.pos, team: p.team, cost: costFn(p), z: C.compositeZ(C.zAll.get(p.rk)),
    })),
  };
}

const NAME_ALIASES = {
  'nic claxton': 'nicolas claxton',
  'alex sarr': 'alexandre sarr',
  'cam thomas': 'cameron thomas',
  'herb jones': 'herbert jones',
  'og anunoby': 'og anunoby',
};

function stripDiacritics(s){
  return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g,'') : s;
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

function matchPlayer(rawName, PLAYERS, byNorm){
  const n = normName(rawName);
  if(!n) return null;
  if(byNorm.has(n)) return byNorm.get(n);
  const parts = n.split(' ');
  const last = parts[parts.length-1];
  const candidates = PLAYERS.filter(p=>{
    const pn = normName(p.name).split(' ');
    return pn[pn.length-1] === last;
  });
  if(candidates.length===1) return candidates[0];
  if(candidates.length>1){
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

if(typeof module !== 'undefined'){
  module.exports = { computeAll, checkPrice, runOptimizer, matchPlayer, buildNameIndex, normName, CATS, CAT_LABEL, CORE_POS };
}
