const fs = require('fs');
const path = require('path');
const { normName } = require('../engine.js');

/**
 * FOMO watch: tracks how completed trades are working out over time.
 *
 * season/trade_watch.json lists the trades to follow (by their `date` in transactions.json and
 * the team whose point of view to take). For each one this compares the players you got with
 * the players you gave up, using only what they've done SINCE the trade:
 *   value = games played since the trade x (per-game 8-cat z-score - replacement per-game z)
 * The z-score is the same scale as the morning report's top performers table. Replacement is the
 * median per-game z of the 10 best-ranked free agents, so a 2-for-1 trade is charged for the
 * extra roster spot it fills. net = value of what you got - value of what you gave up;
 * negative means FOMO (the players you gave up are out-producing what you got).
 * Everything is rebuilt from the daily stats snapshots, so the day-by-day trend needs no extra storage.
 */

const COUNT = ['tpm', 'pts', 'treb', 'ast', 'stl', 'blk'];
const KEYS = ['fgm', 'fga', 'ftm', 'fta', ...COUNT];

const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };

// Box-score line for games between a baseline snapshot player and a later one (season totals differenced)
function sinceLine(cur, base) {
  const games = cur.gp - (base ? base.gp : 0);
  if (games <= 0) return null;
  const line = { games };
  for (const k of KEYS) line[k] = Math.max(0, Math.round(cur[k] * cur.gp - (base ? base[k] * base.gp : 0)));
  return line;
}
const perGame = l => Object.fromEntries(KEYS.map(k => [k, l[k] / l.games]));

// Median per-game z of the best unowned players: what a free agent fills a roster spot with
function replacementLevel(snap, ownedKeys, score) {
  const free = snap.players.filter(p => !ownedKeys.has(normName(p.name)) && p.gp >= 5).sort((a, b) => a.rank - b.rank).slice(0, 10);
  return median(free.map(p => score(p)));
}

// One player's contribution since the trade, against a baseline snapshot
function playerSince(name, curSnap, baseSnap, score, repl) {
  const key = normName(name);
  const cur = curSnap.players.find(p => normName(p.name) === key);
  const base = baseSnap.players.find(p => normName(p.name) === key);
  if (!cur) return { name, games: 0, z: 0, value: 0, rankNow: null, rankThen: base ? base.rank : null };
  const line = sinceLine(cur, base);
  if (!line) return { name, nbaTeam: cur.nbaTeam, games: 0, z: 0, value: 0, rankNow: cur.rank, rankThen: base ? base.rank : null };
  const z = score(perGame(line));
  return { name: cur.name, nbaTeam: cur.nbaTeam, games: line.games, line, z, value: line.games * (z - repl), rankNow: cur.rank, rankThen: base ? base.rank : null };
}

/**
 * @param {object} o
 * @param {object[]} o.watches entries of trade_watch.json
 * @param {object[]} o.transactions transactions.json `transactions`
 * @param {object[]} o.snapshots stats snapshots, oldest first ({asOf, players})
 * @param {Function} o.score per-game z scorer (morning_report buildScorer)
 * @param {Function} o.findTeam name -> team (current or previous name)
 * @param {Set<string>} o.ownedKeys normalised names of every rostered player (to find free agents)
 */
function buildTradeWatch({ watches, transactions, snapshots, score, findTeam, ownedKeys }) {
  if (!snapshots.length) return [];
  const latest = snapshots[snapshots.length - 1];
  const repl = replacementLevel(latest, ownedKeys, score);
  const out = [];
  for (const w of watches) {
    const me = findTeam(w.team);
    // A watch can follow a trade or an add/drop (the added players are "got", the dropped players "gave")
    const tx = (w.txIndex != null ? transactions[w.txIndex] : null) || transactions.find(t => t.date === w.tradeDate && (t.type === 'trade' || (t.type === 'add_drop' && (findTeam(t.team) || {}).name === (me || {}).name)));
    if (!tx) { out.push({ ...w, error: `No trade or add/drop dated ${w.tradeDate} in transactions.json` }); continue; }
    const isMove = tx.type === 'add_drop';
    const mine = isMove ? (tx.add || []) : tx.moves.filter(m => (findTeam(m.to) || {}).name === (me || {}).name);
    const theirs = isMove ? (tx.drop || []) : tx.moves.filter(m => (findTeam(m.to) || {}).name !== (me || {}).name);
    // Morning snapshots hold games through the day before, so the snapshot dated the trade day is the baseline
    const day = w.tradeDate.slice(0, 10);
    const idx = snapshots.findIndex(s => s.asOf >= day);
    const baseIdx = idx === -1 ? snapshots.length - 1 : idx;
    const approx = snapshots[baseIdx].asOf !== day;
    // An added player stops counting once the same team drops him again
    const endIdx = m => {
      if (!isMove) return snapshots.length - 1;
      const later = transactions.find(t => t.type === 'add_drop' && t.date > w.tradeDate && (findTeam(t.team) || {}).name === (me || {}).name && (t.drop || []).some(d => normName(d.name) === normName(m.name)));
      if (!later) return snapshots.length - 1;
      const i = snapshots.findIndex(sn => sn.asOf >= later.date.slice(0, 10));
      return i === -1 ? snapshots.length - 1 : i;
    };
    const side = (moves, snap) => moves.map(m => {
      const cap = isMove && mine.includes(m) ? snapshots[Math.min(snapshots.indexOf(snap), endIdx(m))] : snap;
      const r = playerSince(m.name, cap, snapshots[baseIdx], score, repl);
      if (isMove && mine.includes(m) && endIdx(m) < snapshots.length - 1) r.droppedOn = cap.asOf;
      return r;
    });
    const got = side(mine, latest), gave = side(theirs, latest);
    const sum = rows => rows.reduce((s, r) => s + r.value, 0);
    const series = snapshots.slice(baseIdx + 1).map(s => ({
      date: s.asOf,
      net: sum(side(mine, s)) - sum(side(theirs, s))
    }));
    out.push({
      id: w.id, label: w.label, kind: isMove ? 'move' : 'trade', team: me ? me.name : w.team, tradeDate: w.tradeDate, baselineDate: snapshots[baseIdx].asOf, baselineApprox: approx,
      asOf: latest.asOf, note: tx.note || '', got, gave, gotValue: sum(got), gaveValue: sum(gave), net: sum(got) - sum(gave), series, replacement: repl
    });
  }
  return out;
}

const sgn = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
const BLOCKS = '▁▂▃▄▅▆▇█';
function spark(vals) {
  if (vals.length < 2) return '';
  const lo = Math.min(...vals), hi = Math.max(...vals);
  return vals.map(v => BLOCKS[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
}

function tradeWatchMarkdown(results, statusOf = () => '') {
  const md = ['## FOMO watch (trade tracker)', ''];
  const ok = results.filter(r => !r.error);
  if (ok.length) {
    md.push(`Value = games since the trade x (per-game 8-cat z-score - replacement z of ${sgn(ok[0].replacement, 2)}, the median of the top 10 free agents). Net = what you got - what you gave up, counting only play since the trade. Negative = FOMO: the players you gave up are out-producing what you got.`, '');
  }
  for (const r of results) {
    if (r.error) { md.push(`**${r.label}** — ${r.error}`, ''); continue; }
    const days = r.series.length;
    md.push(`**${r.label}** — traded ${r.tradeDate.slice(0, 10)}, through stats ${r.asOf}${r.baselineApprox ? ` (baseline is the ${r.baselineDate} snapshot; the trade predates it)` : ''}`, '');
    md.push('| Side | Player | GP | Per game | Value | Rank then → now |', '|---|---|---|---|---|---|');
    const row = (tag, p) => {
      const pg = p.line ? `${(p.line.pts / p.games).toFixed(1)}p ${(p.line.treb / p.games).toFixed(1)}r ${(p.line.ast / p.games).toFixed(1)}a ${(p.line.stl / p.games).toFixed(1)}s ${(p.line.blk / p.games).toFixed(1)}b ${(p.line.tpm / p.games).toFixed(1)} 3s` : 'no games';
      const st = statusOf(p.name);
      return `| ${tag} | ${p.name}${st ? ` (${st})` : ''} | ${p.games} | ${pg} | ${sgn(p.value)} | ${p.rankThen ?? '-'} → ${p.rankNow ?? '-'} |`;
    };
    for (const p of r.got) md.push(row('Got', p));
    for (const p of r.gave) md.push(row('Gave', p));
    const recent = r.series.slice(-7).map(s => sgn(s.net)).join(', ');
    const verdict = r.net >= 0 ? `ahead by ${r.net.toFixed(1)}` : `FOMO, the other side is ahead by ${(-r.net).toFixed(1)}`;
    md.push('', `Net **${sgn(r.net)}** (${verdict}). Got ${sgn(r.gotValue)}, gave ${sgn(r.gaveValue)}.${days > 1 ? ` Net by day, last ${Math.min(7, days)}: ${recent} ${spark(r.series.slice(-7).map(s => s.net))}` : ''}`, '');
  }
  return md;
}


// Watches for every add/drop a team has made, for teams that have no trades in trade_watch.json
function moveWatchesFor(teamName, transactions, findTeam) {
  const me = findTeam(teamName);
  return transactions.map((t, txIndex) => ({ t, txIndex })).filter(({ t }) => t.type === 'add_drop' && (findTeam(t.team) || {}).name === (me || {}).name && (t.add || []).length)
    .map(({ t, txIndex }) => ({
      id: `${t.date}`, txIndex,
      label: `${(t.add || []).map(a => a.name).join(', ') || 'no add'} (dropped ${(t.drop || []).map(d => d.name).join(', ') || 'nobody'})`,
      tradeDate: t.date, team: me.name
    }));
}

// One row per add/drop: what the added players have produced since, against what the dropped players have
function moveWatchMarkdown(results, statusOf = () => '') {
  const ok = results.filter(r => !r.error);
  const md = ['## Move watch (were the pickups worth it?)', ''];
  if (!ok.length) return [...md, 'No add/drop moves to track.', ''];
  md.push(`Each row follows one add/drop using only play since the move: value = games x (per-game 8-cat z-score - replacement z of ${sgn(ok[0].replacement, 2)}, the median of the top 10 free agents). Net = added player(s) - dropped player(s). Negative means the dropped player(s) out-produced the pickup. An added player stops counting once the team drops him; a dropped player counts through today.`, '');
  md.push('| Move | Added (GP, value) | Dropped (GP, value) | Net |', '|---|---|---|---|');
  let total = 0;
  for (const r of ok) {
    const f = rows => rows.length ? rows.map(p => `${p.name}${statusOf(p.name) ? ` (${statusOf(p.name)})` : ''} (${p.games} GP, ${sgn(p.value)}${p.droppedOn ? `, cut ${p.droppedOn.slice(5)}` : ''})`).join('; ') : '-';
    total += r.net;
    md.push(`| ${r.tradeDate.slice(5, 10)} | ${f(r.got)} | ${f(r.gave)} | **${sgn(r.net)}** |`);
  }
  md.push('', `Net across ${ok.length} moves: **${sgn(total)}**.`, '');
  return md;
}

const WATCH_FILE = path.join(__dirname, 'trade_watch.json');
function loadWatches(file = WATCH_FILE) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).watches || [] : [];
}

module.exports = { sinceLine, replacementLevel, playerSince, buildTradeWatch, tradeWatchMarkdown, moveWatchesFor, moveWatchMarkdown, loadWatches };
