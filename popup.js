const DEFAULTS = { numTeams: 15, rosterSlots: 12, budget: 200, myTeamName: 'You', starterSlots: 9, benchWeight: 0.3 };

function load(){
  chrome.storage.local.get(['config','picks','doNotDraft'], (res)=>{
    const cfg = Object.assign({}, DEFAULTS, res.config||{});
    document.getElementById('numTeams').value = cfg.numTeams;
    document.getElementById('rosterSlots').value = cfg.rosterSlots;
    document.getElementById('budget').value = cfg.budget;
    document.getElementById('myTeamName').value = cfg.myTeamName;
    document.getElementById('starterSlots').value = cfg.starterSlots !== undefined ? cfg.starterSlots : DEFAULTS.starterSlots;
    document.getElementById('benchWeight').value = cfg.benchWeight !== undefined ? cfg.benchWeight : DEFAULTS.benchWeight;
    const dnd = Array.isArray(res.doNotDraft) ? res.doNotDraft : [];
    document.getElementById('doNotDraft').value = dnd.join('\n');
    const n = (res.picks||[]).length;
    document.getElementById('status').textContent = n
      ? `${n} pick${n===1?'':'s'} logged this draft. Reopen the draft tab to see the overlay.`
      : `No picks logged yet. Open a live Yahoo draft room to start.`;
  });
}

document.getElementById('save').addEventListener('click', ()=>{
  const ss = parseInt(document.getElementById('starterSlots').value, 10);
  const bw = parseFloat(document.getElementById('benchWeight').value);
  const config = {
    numTeams: parseInt(document.getElementById('numTeams').value,10) || DEFAULTS.numTeams,
    rosterSlots: parseInt(document.getElementById('rosterSlots').value,10) || DEFAULTS.rosterSlots,
    budget: parseInt(document.getElementById('budget').value,10) || DEFAULTS.budget,
    myTeamName: document.getElementById('myTeamName').value.trim(),
    starterSlots: isNaN(ss) ? DEFAULTS.starterSlots : ss,
    benchWeight: isNaN(bw) ? DEFAULTS.benchWeight : bw,
  };
  const dndText = document.getElementById('doNotDraft').value;
  const doNotDraft = dndText.split('\n').map(s=>s.trim()).filter(Boolean);
  chrome.storage.local.set({ config, doNotDraft }, ()=>{
    document.getElementById('status').textContent = 'Saved. Refresh the draft tab to apply.';
  });
});

document.getElementById('reset').addEventListener('click', ()=>{
  if(!confirm('Clear all logged picks for this draft? This cannot be undone.')) return;
  chrome.storage.local.set({ picks: [], seenSignatures: [] }, ()=>{
    document.getElementById('status').textContent = 'Picks cleared. Refresh the draft tab.';
  });
});

load();
