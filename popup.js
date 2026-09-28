const DEFAULTS = { numTeams: 12, rosterSlots: 13, budget: 200, myTeamName: 'You' };

function load(){
  chrome.storage.local.get(['config','picks'], (res)=>{
    const cfg = Object.assign({}, DEFAULTS, res.config||{});
    document.getElementById('numTeams').value = cfg.numTeams;
    document.getElementById('rosterSlots').value = cfg.rosterSlots;
    document.getElementById('budget').value = cfg.budget;
    document.getElementById('myTeamName').value = cfg.myTeamName;
    const n = (res.picks||[]).length;
    document.getElementById('status').textContent = n
      ? `${n} pick${n===1?'':'s'} logged this draft. Reopen the draft tab to see the overlay.`
      : `No picks logged yet. Open a live Yahoo draft room to start.`;
  });
}

document.getElementById('save').addEventListener('click', ()=>{
  const config = {
    numTeams: parseInt(document.getElementById('numTeams').value,10) || DEFAULTS.numTeams,
    rosterSlots: parseInt(document.getElementById('rosterSlots').value,10) || DEFAULTS.rosterSlots,
    budget: parseInt(document.getElementById('budget').value,10) || DEFAULTS.budget,
    myTeamName: document.getElementById('myTeamName').value.trim(),
  };
  chrome.storage.local.set({ config }, ()=>{
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
