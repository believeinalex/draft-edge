// Builds docs/index.html: the self-contained "Category Velocity" dashboard (GitHub Pages).
// Reads season/standings, season/league.json, season/transactions.json and reports/*.json.
// Run: npm run viz   (also runs at the end of npm run morning)
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..'), V = __dirname;
const CATS = ['fgPct', 'ftPct', 'tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const L = JSON.parse(fs.readFileSync(path.join(ROOT, 'season/league.json')));
const alias = {};
for (const t of L.teams) for (const o of t.previousNames || []) alias[o] = t.name;
const norm = (n) => alias[n] || n;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))) || 1; };
const rankAvg = (vals) => vals.map((v) => { const gt = vals.filter((x) => x > v).length, eq = vals.filter((x) => x === v).length; return gt + (eq + 1) / 2; });
const fmtLong = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const days = (a, b) => (new Date(b) - new Date(a)) / 864e5;

const files = fs.readdirSync(path.join(ROOT, 'season/standings')).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
const standings = [], snaps = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'season/standings', f))), date = f.slice(0, 10);
  const teams = d.teams.map((t) => ({ ...t, team: norm(t.team) })), N = teams.length;
  const rk = {}; CATS.forEach((c) => (rk[c] = rankAvg(teams.map((t) => t[c]))));
  const rows = teams.map((t, i) => { const r = { date, team: t.team, gp: t.gp, yahooRank: t.yahooRank }; CATS.forEach((c) => { r[c] = t[c]; r['rk_' + c] = rk[c][i]; r['rp_' + c] = N + 1 - rk[c][i]; }); r.rotoTotal = CATS.reduce((s, c) => s + r['rp_' + c], 0); return r; });
  const ov = rankAvg(rows.map((r) => r.rotoTotal)); rows.forEach((r, i) => (r.rotoRank = ov[i]));
  standings.push(...rows); snaps[date] = rows;
}
const dates = Object.keys(snaps), latest = dates[dates.length - 1];
// checkpoints: first snapshot on/after Oct 26, then each snapshot 3+ days after the last; always end on the latest
let CK = [];
for (const d of dates) { if (d < '2026-10-26') continue; if (!CK.length || days(CK[CK.length - 1], d) >= 3) CK.push(d); }
if (CK[CK.length - 1] !== latest) { if (CK.length > 1 && days(CK[CK.length - 1], latest) < 3) CK.pop(); CK.push(latest); }
const periods = []; let prev = null, prevDate = 'start';
for (const date of CK) {
  const cur = snaps[date];
  const rows = cur.map((r) => { const p = prev && prev.find((x) => x.team === r.team);
    const o = { periodStart: prevDate, periodEnd: date, team: r.team, dgp: r.gp - (p ? p.gp : 0), rotoStart: p ? p.rotoTotal : null, rotoEnd: r.rotoTotal, rankStart: p ? p.rotoRank : null, rankEnd: r.rotoRank };
    CATS.forEach((c) => { o['v_' + c] = c === 'fgPct' || c === 'ftPct' ? (p ? r[c] - p[c] : null) : (r[c] - (p ? p[c] : 0)) / o.dgp; }); return o; });
  CATS.forEach((c) => { const xs = rows.map((r) => r['v_' + c]); if (xs.some((x) => x == null)) { rows.forEach((r) => (r['z_' + c] = null)); return; } const m = mean(xs), s = sd(xs); rows.forEach((r) => (r['z_' + c] = (r['v_' + c] - m) / s)); });
  periods.push(...rows); prev = cur; prevDate = date;
}
const odds = [];
for (const f of fs.readdirSync(path.join(ROOT, 'reports')).filter((f) => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort()) {
  let r; try { r = JSON.parse(fs.readFileSync(path.join(ROOT, 'reports', f))); } catch (e) { continue; }
  if (!r.seasonOdds || !r.seasonOdds.teams) continue;
  for (const t of r.seasonOdds.teams) odds.push({ date: r.seasonOdds.asOf || f.slice(0, 10), team: norm(t.name), topThird: t.topThird, top3: t.top3, first: t.first, avgRank: t.avgRank, avgPts: t.avgPts });
}
const tx = JSON.parse(fs.readFileSync(path.join(ROOT, 'season/transactions.json'))).transactions, trades = [];
for (const x of tx.filter((x) => x.type === 'trade')) { const to = {}; x.moves.forEach((m) => { (to[norm(m.to)] = to[norm(m.to)] || []).push(m.name); }); for (const [team, names] of Object.entries(to)) trades.push({ date: x.date.slice(0, 10), time: x.date, team, received: names.join(', ') }); }
const players = [], projection = [];
for (const T of L.teams) { const team = norm(T.name);
  for (const p of T.roster) { const s = p.stats || {}, gp = s.gp || 0, o = { team, player: p.name, acquired: p.acquired, gp }; ['fgm', 'fga', 'ftm', 'fta', 'tpm', 'pts', 'treb', 'ast', 'stl', 'blk'].forEach((k) => (o['t_' + k] = Math.round((s[k] || 0) * gp * 10) / 10)); players.push(o); }
  CATS.forEach((c) => projection.push({ team, cat: c, projected: T.projTotals[c], actual: T.realTotals[c] })); }
const data = { standings, periods, odds, trades, players, projection };

const sub = { ASOF: fmtLong(latest), ASOF_SHORT: fmtShort(latest), FIRST: fmtShort(dates[0]), ODDS_FIRST: odds.length ? fmtShort(odds[0].date) : 'the first run', NSNAPS: String(dates.length), CHECKPOINTS: CK.map(fmtShort).join(', ').replace(/, ([^,]*)$/, ' and $1') };
let body = fs.readFileSync(path.join(V, 'template.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => sub[k]);
const tokens = `
:root{--color-fg:#1c1f24;--color-fg-muted:#5f6670;--color-bg:#ffffff;--color-panel:#f6f7f9;--color-border-line:#dfe2e7;--cds-text-secondary:#444b55;--cds-chart-muted:#9aa1ab;--cds-chart-grid:#e8eaee;--cds-chart-axis:#a9afb8;--cds-surface-popover:#ffffff;--cds-border:#cfd3d9;--cds-shadow-popover:0 4px 14px rgba(0,0,0,.14);
--cds-gap-xl:36px;--cds-gap-lg:16px;--cds-gap-md:12px;--cds-gap-sm:8px;--cds-pad-lg:16px;--cds-pad-md:12px;--cds-pad-sm:8px;--cds-radius:10px;--cds-font-size-title:30px;--cds-font-size-heading:19px;--cds-font-size-body:14px;--cds-font-size-caption:12px;--cds-font-weight-medium:600;--font-anthropic-sans:Inter,system-ui,-apple-system,Segoe UI,sans-serif;--font-anthropic-serif:Georgia,'Times New Roman',serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--color-fg:#e8eaee;--color-fg-muted:#9aa1ab;--color-bg:#14171b;--color-panel:#1c2026;--color-border-line:#2d333b;--cds-text-secondary:#b5bbc4;--cds-chart-muted:#6b727c;--cds-chart-grid:#2a2f36;--cds-chart-axis:#4a515b;--cds-surface-popover:#242a31;--cds-border:#3a414a;--cds-shadow-popover:0 4px 14px rgba(0,0,0,.5);color-scheme:dark}}
body{margin:0;background:var(--color-bg);color:var(--color-fg);font:14px var(--font-anthropic-sans)}
.cv-wrap{max-width:1100px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-right)) 48px max(16px,env(safe-area-inset-left))}
.dash-select{font:inherit;color:var(--color-fg);background:var(--color-panel);border:1px solid var(--color-border-line);border-radius:6px;padding:6px 8px}
summary{cursor:pointer}`;
const shim = `
(function(){var draws=[],state={team:'Shut Up and Jam Gaiden',compare:'Finn will turn Bert into bacon',period:'${latest}',metric:'topThird'},D=window.__DATA;
function run(n){draws.forEach(function(d){if(n&&d[0]!==n)return;document.querySelectorAll('[data-draw="'+d[0]+'"]').forEach(function(e){try{d[1](e)}catch(x){console.error(d[0],x)}})})}
window.dash={colors:['#2b7fc4','#d4622b','#3a9d6b','#8a5cc2','#c99a1f','#1f9fa8','#c25a8a','#6b7280'],
data:function(id){return {status:'ok',data:D[id]}},params:function(){return state},setParams:function(o){Object.assign(state,o);run()},draw:function(n,f){draws.push([n,f])},__run:run};
var t;addEventListener('resize',function(){clearTimeout(t);t=setTimeout(function(){run()},150)});
addEventListener('DOMContentLoaded',function(){run()});})();`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Category Velocity</title><style>${tokens}</style></head><body><div class="cv-wrap">${body}</div>
<script>${fs.readFileSync(path.join(V, 'd3.min.js'), 'utf8')}</script>
<script>window.__DATA=${JSON.stringify(data)};</script>
<script>${shim}</script>
<script>${fs.readFileSync(path.join(V, 'app.js'), 'utf8')}</script></body></html>`;
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/index.html'), html);
console.log(`[viz] docs/index.html: ${dates.length} snapshots through ${latest}, checkpoints ${CK.join(' ')}, ${odds.length} odds rows, ${(html.length / 1024).toFixed(0)} KB`);
