const PLAYERS = require('../players.js');
const { computeAll, runOptimizer, buildNameIndex, matchPlayer, CORE_POS } = require('../engine.js');
const FULL_COVERAGE = (1<<CORE_POS.length)-1;
const COVERAGE_STATES = 1<<CORE_POS.length;
function posMaskOf(p){
  let m = 0;
  for(const pos of (p.pos||[])){ const i = CORE_POS.indexOf(pos); if(i>=0) m |= (1<<i); }
  return m;
}

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
  const bWeight = (benchWeight !== undefined) ? benchWeight : 0.3;

  for(let i=0;i<n;i++){
    const cost = Math.round(costFn(pool[i]));
    const baseVal = valFn(pool[i]);
    const pm = posMaskOf(pool[i]);
    const newDp = dp.slice();
    const take = new Int8Array((K+1)*(B+1)*M).fill(-1);
    if(cost <= B){
      for(let k=K;k>=1;k--){
        const itemVal = (k <= sSlots) ? baseVal : baseVal * bWeight;
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

function checkPriceNew(state, PLAYERS, rk){
  const C = computeAll(state, PLAYERS);
  const p = PLAYERS.find(x=>x.rk===rk);
  if(!p) return null;
  const {budgetLeft, slotsLeft, picksMade} = C.teamBudgetAndSlotsLeft(state.myTeamName);
  if(slotsLeft<=0) return { player:p, full:true };
  const costFn = x=>C.fairPrice(x.rk);
  const valFn = x=>C.compositeZ(C.zAll.get(x.rk));
  const pZc = C.zAll.get(p.rk);
  const pVal = C.compositeZ(pZc);
  const pMask = posMaskOf(p);
  const poolExcl = C.availableInPool.filter(x=>x.rk!==rk);
  const B = Math.max(budgetLeft, 0);
  const myPicks = state.picks.filter(pk=>pk.teamName===state.myTeamName);
  const myPlayers = myPicks.map(pk=>PLAYERS.find(x=>x.rk===pk.rk)).filter(Boolean);
  const baseReach = reachableCoverage(myPlayers);
  const starterSlots = state.starterSlots !== undefined ? state.starterSlots : 10;
  const benchWeight = state.benchWeight !== undefined ? state.benchWeight : 0.3;
  const starterSlotsLeft = Math.max(0, starterSlots - picksMade);

  const res = knapsackDP(poolExcl, costFn, valFn, B, slotsLeft, baseReach, starterSlotsLeft, benchWeight);
  res.costOf = costFn;

  const isStarterTarget = picksMade < starterSlots;
  const pValEff = isStarterTarget ? pVal : pVal * benchWeight;
  const subStarterSlotsLeft = isStarterTarget ? Math.max(0, starterSlotsLeft - 1) : 0;
  const resSub = (subStarterSlotsLeft === starterSlotsLeft)
    ? res
    : knapsackDP(poolExcl, costFn, valFn, B, slotsLeft, baseReach, subStarterSlotsLeft, benchWeight);
  resSub.costOf = costFn;

  function bestCompatible(k, b){
    if(b < 0) return {value: -1e15, mask: -1};
    let maxCovered = -1;
    let bestVal = -1e15;
    let bestMask = -1;

    for(let m = 0; m < resSub.M; m++){
      const v = resSub.dp[resSub.idx(k, b, m)];
      if(v <= -1e14) continue;
      const combinedMask = m | pMask;
      let count = 0;
      for(let j = 0; j < CORE_POS.length; j++){
        if(combinedMask & (1 << j)) count++;
      }
      if(count > maxCovered){
        maxCovered = count;
        bestVal = v;
        bestMask = m;
      } else if(count === maxCovered && v > bestVal){
        bestVal = v;
        bestMask = m;
      }
    }
    return {value: bestVal, mask: bestMask};
  }

  let baseline = bestFeasible(res, slotsLeft, res.B);
  let baselineInfeasible = baseline < -1e14;
  let baselineMask = FULL_COVERAGE;
  if(baselineInfeasible){
    const fb = bestAny(res, slotsLeft, res.B);
    baseline = fb.value; baselineMask = fb.mask;
  }
  let bestX = 0, bestSubMask = -1;
  if(slotsLeft-1 >= 0){
    for(let X=1; X<=B; X++){
      const remB = B - X;
      const sub = bestCompatible(slotsLeft-1, remB);
      const withVal = pValEff + sub.value;
      if(withVal >= baseline){ bestX = X; bestSubMask = sub.mask; }
    }
  }
  const zRank = (C.zRankMap && C.zRankMap.get(rk)) || p.rk;
  const zc = C.zAll.get(p.rk);

  return {
    player: p, maxBid: bestX, soloZ: pVal, mktNow: C.fairPrice(rk),
    zRank, zc, baselineZ: baseline
  };
}

const nameIndex = buildNameIndex(PLAYERS);
const buz = matchPlayer('Matas Buzelis', PLAYERS, nameIndex);
const qui = matchPlayer('Immanuel Quickley', PLAYERS, nameIndex);

// Picks setup
const picks = [
  { rk: 1, teamName: 'You', price: 45 },
  { rk: 2, teamName: 'You', price: 35 },
  { rk: 3, teamName: 'You', price: 21 },
  { rk: 4, teamName: 'You', price: 12 },
  { rk: 5, teamName: 'You', price: 8 },
];

const state = {
  numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'You',
  weights: {fgPct:1,ftPct:1,tpm:1,pts:1,treb:1,ast:1,stl:1,blk:1},
  picks: picks, starterSlots: 10, benchWeight: 0.3
};

console.log('NEW Buzelis:', checkPriceNew(state, PLAYERS, buz.rk));
console.log('NEW Quickley:', checkPriceNew(state, PLAYERS, qui.rk));
