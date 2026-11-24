(function () {
  const CATS = [['fgPct', 'FG%'], ['ftPct', 'FT%'], ['tpm', '3PM'], ['pts', 'PTS'], ['treb', 'REB'], ['ast', 'AST'], ['stl', 'STL'], ['blk', 'BLK']];
  const CL = Object.fromEntries(CATS);
  const pd = d3.utcParse('%Y-%m-%d');
  const fd = d3.utcFormat('%b %-d');
  const MUTED = 'var(--cds-chart-muted)';
  const GRID = 'var(--cds-chart-grid)';
  const AXIS = 'var(--cds-chart-axis)';
  const NEG = '#d4622b';
  const POS = '#2b7fc4';
  const DEFAULTS = { team: 'Shut Up and Jam Gaiden', compare: 'Finn will turn Bert into bacon', period: '2026-11-17', metric: 'topThird', view: 'rank' };

  const rows = (id) => {
    const g = dash.data(id);
    return g.status === 'ok' && Array.isArray(g.data) && g.data.length ? g.data : null;
  };
  const P = () => {
    const p = dash.params() || {};
    return { team: p.team || DEFAULTS.team, compare: p.compare == null ? DEFAULTS.compare : p.compare, period: p.period || DEFAULTS.period, metric: p.metric || DEFAULTS.metric, view: p.view || DEFAULTS.view };
  };
  const col = (i) => (dash.colors && dash.colors.length ? dash.colors[i % dash.colors.length] : '#2b7fc4');
  const trunc = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s);
  const ord = (n) => { const r = Math.round(n); const s = ['th', 'st', 'nd', 'rd']; const v = r % 100; return r + (s[(v - 20) % 10] || s[v] || s[0]); };
  const num = (v, d = 1) => (v == null ? '–' : (Math.round(v * 10 ** d) / 10 ** d).toString());
  const sgn = (v, d = 1) => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v * 10 ** d) / 10 ** d));
  const pct = (v) => Math.round(v * 100) + '%';
  const latestOf = (rs) => { const d = d3.max(rs, (r) => r.date); return rs.filter((r) => r.date === d); };
  const placeholder = (el) => { el.classList.remove('cv-frame'); el.textContent = '—'; };
  const teamColor = (t, p) => (t === p.team ? col(0) : t && t === p.compare ? col(1) : MUTED);
  const isHi = (t, p) => t === p.team || (t && t === p.compare);
  const valFmt = (c, v) => (v == null ? '–' : c === 'fgPct' || c === 'ftPct' ? (v * 100).toFixed(1) + '%' : String(Math.round(v)));

  function frame(el) {
    el.classList.add('cv-frame');
    el.replaceChildren();
    const tip = document.createElement('div');
    tip.className = 'cv-tip';
    tip.hidden = true;
    el.appendChild(tip);
    return {
      show(lines, ev) {
        tip.replaceChildren(...lines.map((l, i) => { const d = document.createElement('div'); if (i === 0) d.className = 'cv-tip-h'; d.textContent = l; return d; }));
        tip.hidden = false;
        const r = el.getBoundingClientRect();
        let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        if (x + tw > el.clientWidth) x = Math.max(0, ev.clientX - r.left - tw - 14);
        if (y + th > el.clientHeight) y = Math.max(0, ev.clientY - r.top - th - 14);
        tip.style.left = x + 'px';
        tip.style.top = y + 'px';
      },
      hide() { tip.hidden = true; },
    };
  }
  const mkSvg = (el, w, h, aria) => d3.select(el).insert('svg', '.cv-tip').attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h).attr('role', 'img').attr('aria-label', aria);
  function legend(el, items) {
    const d = document.createElement('div');
    d.className = 'cv-legend';
    items.forEach((it) => {
      const s = document.createElement('span');
      const sw = document.createElement('i');
      sw.className = 'cv-sw' + (it.dash ? ' dash' : '');
      sw.style.background = it.dash ? 'transparent' : it.color;
      if (it.dash) sw.style.borderColor = it.color;
      s.append(sw, document.createTextNode(' ' + it.label));
      d.appendChild(s);
    });
    el.insertBefore(d, el.firstChild);
  }
  const teamLegend = (el, p, extra) => legend(el, [{ color: col(0), label: p.team }].concat(p.compare ? [{ color: col(1), label: p.compare }] : [], [{ color: MUTED, label: 'Other teams' }], extra || []));
  const thin = (dates, x) => { const out = []; let last = -1e9; dates.forEach((d) => { if (x(d) - last >= 56) { out.push(d); last = x(d); } }); return out; };
  function tradeMarkers(p) {
    const T = rows('trades');
    if (!T) return [];
    return T.filter((t) => t.team === p.team || (p.compare && t.team === p.compare)).map((t) => ({ date: pd(t.date), label: t.team + ' trade: got ' + t.received }));
  }
  function drawMarkers(g, x, ms, y0, y1) {
    const dom = x.domain();
    ms.filter((m) => m.date >= dom[0] && m.date <= dom[1]).forEach((m) => {
      g.append('line').attr('x1', x(m.date)).attr('x2', x(m.date)).attr('y1', y0).attr('y2', y1).attr('stroke', AXIS).attr('stroke-dasharray', '3 3').style('pointer-events', 'none');
    });
  }
  const nearTrade = (ms, x, px) => ms.find((m) => Math.abs(x(m.date) - px) < 6);

  // ---------- selects
  const optionsFor = (sel, list, value) => { sel.replaceChildren(...list.map(([v, t]) => new Option(t, v))); sel.value = value; };
  function teamList() {
    const S = rows('standings');
    if (!S) return null;
    return latestOf(S).sort((a, b) => b.rotoTotal - a.rotoTotal).map((r) => [r.team, r.team]);
  }
  dash.draw('team', (sel) => {
    const l = teamList(); if (!l) return;
    optionsFor(sel, l, P().team);
    sel.onchange = () => dash.setParams({ team: sel.value });
  });
  dash.draw('compare', (sel) => {
    const l = teamList(); if (!l) return;
    optionsFor(sel, [['', 'None']].concat(l), P().compare);
    sel.onchange = () => dash.setParams({ compare: sel.value });
  });
  dash.draw('period', (sel) => {
    const R = rows('periods'); if (!R) return;
    const seen = new Map();
    R.forEach((r) => { if (!seen.has(r.periodEnd)) seen.set(r.periodEnd, r.periodStart); });
    const list = [...seen.entries()].map(([end, st]) => [end, (st === 'start' ? 'Season start' : fd(pd(st))) + ' → ' + fd(pd(end))]);
    optionsFor(sel, list.reverse(), P().period);
    sel.onchange = () => dash.setParams({ period: sel.value });
  });
  dash.draw('metric', (sel) => {
    optionsFor(sel, [['topThird', 'Top five finish'], ['top3', 'Top three finish'], ['first', 'First place']], P().metric);
    sel.onchange = () => dash.setParams({ metric: sel.value });
  });

  dash.draw('view', (sel) => {
    optionsFor(sel, [['rank', 'Rank'], ['raw', 'Raw total']], P().view);
    sel.onchange = () => dash.setParams({ view: sel.value });
  });

  // ---------- headline
  dash.draw('headline', (el) => {
    const S = rows('standings'); if (!S) { el.textContent = '—'; return; }
    const p = P();
    const last = latestOf(S).find((r) => r.team === p.team);
    if (!last) { el.textContent = '—'; return; }
    const dates = [...new Set(S.map((r) => r.date))].sort();
    const ref = dates.filter((d) => d <= '2026-11-12').pop() || dates[0];
    const before = S.find((r) => r.date === ref && r.team === p.team);
    const best = CATS.map(([c, l]) => [l, last['rp_' + c]]).sort((a, b) => b[1] - a[1]);
    const O = rows('odds');
    const od = O ? latestOf(O).find((r) => r.team === p.team) : null;
    let t = `${p.team} is ${ord(last.rotoRank)} in roto with ${num(last.rotoTotal)} points`;
    if (before && ref !== last.date) t += ` (${sgn(last.rotoTotal - before.rotoTotal)} since ${fd(pd(ref))})`;
    t += `. Best category: ${best[0][0]} (${num(best[0][1])} pts). Weakest: ${best[best.length - 1][0]} (${num(best[best.length - 1][1])} pts).`;
    if (od) t += ` Season sim: ${pct(od.topThird)} top five, ${pct(od.first)} to finish first.`;
    el.textContent = t;
  });

  // ---------- heatmap (velocity, consistency, vs projection)
  function heatmap(el, spec) {
    const f = frame(el);
    const p = P();
    const w = Math.max(300, el.clientWidth), lab = Math.min(150, Math.round(w * 0.3)), ext = spec.extra ? 44 : 0, rowH = 24, hd = 26;
    const cw = (w - lab - ext) / 8, h = hd + spec.teams.length * rowH + 4;
    const svg = mkSvg(el, w, h, spec.aria);
    CATS.forEach(([, l], i) => svg.append('text').attr('x', lab + cw * (i + 0.5)).attr('y', 16).attr('text-anchor', 'middle').attr('class', 'cv-h').text(l));
    if (spec.extra) svg.append('text').attr('x', w - ext / 2).attr('y', 16).attr('text-anchor', 'middle').attr('class', 'cv-h').text(spec.extraHead);
    spec.teams.forEach((t, r) => {
      const y0 = hd + r * rowH;
      svg.append('text').attr('x', lab - 8).attr('y', y0 + 15).attr('text-anchor', 'end').attr('class', isHi(t, p) ? 'cv-lab hi' : 'cv-lab').text(trunc(t, Math.floor(lab / 6.4)));
      CATS.forEach(([c], i) => {
        const v = spec.val(t, c);
        const g = svg.append('g');
        const rect = g.append('rect').attr('x', lab + i * cw + 1).attr('y', y0).attr('width', Math.max(2, cw - 2)).attr('height', rowH - 2).attr('rx', 3);
        if (!v || v.z == null) {
          rect.attr('fill', 'none').attr('stroke', GRID);
          g.append('text').attr('x', lab + cw * (i + 0.5)).attr('y', y0 + 15).attr('text-anchor', 'middle').attr('class', 'cv-cell').text('–');
        } else {
          const o = spec.seq ? 0.1 + 0.6 * Math.min(1, v.z / spec.seqMax) : 0.1 + 0.6 * Math.min(Math.abs(v.z), 2) / 2;
          rect.attr('fill', spec.seq ? POS : v.z >= 0 ? POS : NEG).attr('fill-opacity', o);
          g.append('text').attr('x', lab + cw * (i + 0.5)).attr('y', y0 + 15).attr('text-anchor', 'middle').attr('class', 'cv-cell').text(v.text);
        }
        g.on('pointermove', (ev) => f.show(v && v.lines ? v.lines : [t, CL[c], 'no data'], ev)).on('pointerleave', f.hide);
      });
      if (spec.extra) svg.append('text').attr('x', w - ext / 2).attr('y', y0 + 15).attr('text-anchor', 'middle').attr('class', 'cv-cell').text(spec.extra(t));
      if (isHi(t, p)) svg.append('rect').attr('x', 0.5).attr('y', y0 - 1).attr('width', w - 1).attr('height', rowH).attr('rx', 4).attr('fill', 'none').attr('stroke', teamColor(t, p)).attr('stroke-width', 1.5).style('pointer-events', 'none');
    });
  }

  dash.draw('velocity', (el) => {
    const R = rows('periods'); if (!R) return placeholder(el);
    const p = P();
    let end = p.period; if (!R.some((r) => r.periodEnd === end)) end = d3.max(R, (r) => r.periodEnd);
    const rs = R.filter((r) => r.periodEnd === end).sort((a, b) => b.rotoEnd - a.rotoEnd);
    const by = new Map(rs.map((r) => [r.team, r]));
    heatmap(el, {
      aria: 'Heatmap of each team\'s category production in the selected period, in standard deviations above or below the league average',
      teams: rs.map((r) => r.team), extraHead: 'Δ pts',
      extra: (t) => { const r = by.get(t); return r.rotoStart == null ? '' : sgn(r.rotoEnd - r.rotoStart); },
      val: (t, c) => {
        const r = by.get(t); const z = r['z_' + c]; if (z == null) return null;
        const raw = r['v_' + c];
        const rawTxt = c === 'fgPct' || c === 'ftPct' ? sgn(raw * 100, 2) + ' pts of average' : num(raw, 2) + ' per team-game';
        return { z, text: sgn(z), lines: [t + ' · ' + CL[c], (r.periodStart === 'start' ? 'Season start' : fd(pd(r.periodStart))) + ' → ' + fd(pd(r.periodEnd)) + ' · ' + r.dgp + ' games', rawTxt, sgn(z) + ' standard deviations vs league'] };
      },
    });
  });

  dash.draw('consistency', (el) => {
    const R = rows('periods'); if (!R) return placeholder(el);
    const teams = [...new Set(R.map((r) => r.team))];
    const stat = new Map();
    teams.forEach((t) => {
      const o = {};
      CATS.forEach(([c]) => { const zs = R.filter((r) => r.team === t && r['z_' + c] != null).map((r) => r['z_' + c]); o[c] = zs.length >= 3 ? { sd: d3.deviation(zs), n: zs.length, zs } : null; });
      stat.set(t, o);
    });
    const meanSd = (t) => d3.mean(CATS.map(([c]) => stat.get(t)[c]).filter(Boolean), (s) => s.sd) || 0;
    const mx = d3.max(teams, (t) => d3.max(CATS.map(([c]) => stat.get(t)[c]).filter(Boolean), (s) => s.sd)) || 1;
    heatmap(el, {
      aria: 'Heatmap of how much each team\'s weekly category production varies; darker means streakier', seq: true, seqMax: mx,
      teams: teams.sort((a, b) => meanSd(a) - meanSd(b)), extraHead: 'Avg', extra: (t) => num(meanSd(t), 2),
      val: (t, c) => { const s = stat.get(t)[c]; if (!s) return null; return { z: s.sd, text: num(s.sd, 1), lines: [t + ' · ' + CL[c], 'Spread of period scores: ' + num(s.sd, 2), 'Across ' + s.n + ' periods: ' + s.zs.map((z) => sgn(z)).join(', ')] }; },
    });
  });

  dash.draw('vsproj', (el) => {
    const D = rows('projection'); if (!D) return placeholder(el);
    const teams = [...new Set(D.map((r) => r.team))];
    const tot = {}; CATS.forEach(([c]) => { tot[c] = { p: d3.sum(D.filter((r) => r.cat === c), (r) => r.projected), a: d3.sum(D.filter((r) => r.cat === c), (r) => r.actual) }; });
    const resid = {};
    D.forEach((r) => {
      const isPct = r.cat === 'fgPct' || r.cat === 'ftPct';
      resid[r.team + '|' + r.cat] = isPct ? r.actual - r.projected : (r.actual / tot[r.cat].a) / (r.projected / tot[r.cat].p) - 1;
    });
    const sdc = {}; CATS.forEach(([c]) => { sdc[c] = d3.deviation(teams.map((t) => resid[t + '|' + c])) || 1; });
    const score = (t) => d3.sum(CATS, ([c]) => resid[t + '|' + c] / sdc[c]);
    const rec = (t, c) => D.find((r) => r.team === t && r.cat === c);
    heatmap(el, {
      aria: 'Heatmap of each team\'s category production relative to its draft-day projection',
      teams: teams.sort((a, b) => score(b) - score(a)), extraHead: 'Sum', extra: (t) => sgn(score(t)),
      val: (t, c) => {
        const r = rec(t, c); if (!r) return null; const x = resid[t + '|' + c]; const isPct = c === 'fgPct' || c === 'ftPct';
        return { z: x / sdc[c], text: isPct ? sgn(x * 100, 1) : sgn(x * 100, 0) + '%', lines: [t + ' · ' + CL[c], 'Projected full season: ' + valFmt(c, r.projected), 'Actual so far: ' + valFmt(c, r.actual), isPct ? 'Percentage points vs projection' : 'Share of league total vs projected share'] };
      },
    });
  });

  // ---------- generic line chart
  function lineChart(el, spec) {
    const f = frame(el); const p = P();
    const w = Math.max(280, el.clientWidth), h = spec.h || 300, m = { l: 44, r: 16, t: 12, b: 28 };
    const svg = mkSvg(el, w, h, spec.aria);
    const xs = spec.series.flatMap((s) => s.pts.map((q) => q[0]));
    const x = d3.scaleUtc().domain(d3.extent(xs)).range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain(spec.y).nice().range([h - m.b, m.t]);
    y.ticks(5).forEach((v) => {
      svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', GRID);
      svg.append('text').attr('x', m.l - 6).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('class', 'cv-tick').text(spec.yFmt(v));
    });
    const dates = [...new Set(xs.map((d) => +d))].sort((a, b) => a - b).map((d) => new Date(d));
    thin(dates, x).forEach((d) => svg.append('text').attr('x', x(d)).attr('y', h - 8).attr('text-anchor', 'middle').attr('class', 'cv-tick').text(fd(d)));
    const g = svg.append('g');
    drawMarkers(g, x, spec.markers || [], m.t, h - m.b);
    const line = d3.line().x((q) => x(q[0])).y((q) => y(q[1])).defined((q) => q[1] != null);
    [...spec.series].sort((a, b) => a.order - b.order).forEach((s) => {
      g.append('path').datum(s.pts).attr('d', line).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', s.hi ? 2.5 : 1.2).attr('stroke-opacity', s.hi ? 1 : 0.55).attr('stroke-linejoin', 'round');
      const last = s.pts[s.pts.length - 1];
      if (s.hi && last) g.append('circle').attr('cx', x(last[0])).attr('cy', y(last[1])).attr('r', 4).attr('fill', s.color).attr('stroke', 'var(--color-bg)').attr('stroke-width', 2);
    });
    const cross = svg.append('line').attr('y1', m.t).attr('y2', h - m.b).attr('stroke', AXIS).attr('opacity', 0);
    const dots = svg.append('g');
    svg.append('rect').attr('x', m.l).attr('y', 0).attr('width', w - m.l - m.r).attr('height', h).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px] = d3.pointer(ev);
        const dt = dates.reduce((a, b) => (Math.abs(x(b) - px) < Math.abs(x(a) - px) ? b : a));
        cross.attr('x1', x(dt)).attr('x2', x(dt)).attr('opacity', 1);
        const hi = spec.series.filter((s) => s.hi);
        dots.selectAll('circle').remove();
        const lines = [fd(dt)];
        hi.forEach((s) => { const q = s.pts.find((z) => +z[0] === +dt); if (q && q[1] != null) { dots.append('circle').attr('cx', x(dt)).attr('cy', y(q[1])).attr('r', 4).attr('fill', s.color).attr('stroke', 'var(--color-bg)').attr('stroke-width', 2); lines.push(s.label + ': ' + spec.yFmt(q[1])); } });
        const all = spec.series.map((s) => { const q = s.pts.find((z) => +z[0] === +dt); return q && q[1] != null ? [s.label, q[1]] : null; }).filter(Boolean).sort((a, b) => b[1] - a[1]);
        if (all.length) lines.push('League leader: ' + all[0][0] + ' ' + spec.yFmt(all[0][1]));
        const tr = nearTrade(spec.markers || [], x, px); if (tr) lines.push(tr.label);
        f.show(lines, ev);
      })
      .on('pointerleave', () => { cross.attr('opacity', 0); dots.selectAll('circle').remove(); f.hide(); });
    teamLegend(el, p, (spec.markers || []).length ? [{ color: AXIS, label: 'Trade involving a highlighted team', dash: true }] : []);
  }
  const seriesFrom = (R, keyFn, valFn, p) => {
    const teams = [...new Set(R.map((r) => r.team))];
    return teams.map((t) => ({ label: t, color: teamColor(t, p), hi: isHi(t, p), order: isHi(t, p) ? (t === p.team ? 3 : 2) : 0, pts: R.filter((r) => r.team === t).sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => [pd(r.date), valFn(r)]) }));
  };

  dash.draw('rototime', (el) => {
    const S = rows('standings'); if (!S) return placeholder(el);
    const p = P();
    lineChart(el, { aria: 'Roto points over time for every team', series: seriesFrom(S, null, (r) => r.rotoTotal, p), y: [0, d3.max(S, (r) => r.rotoTotal) + 5], yFmt: (v) => String(Math.round(v)), markers: tradeMarkers(p), h: 320 });
  });
  dash.draw('odds', (el) => {
    const O = rows('odds'); if (!O) return placeholder(el);
    const p = P(); const k = p.metric;
    lineChart(el, { aria: 'Season-sim odds over time for every team', series: seriesFrom(O, null, (r) => r[k], p), y: [0, 1], yFmt: (v) => Math.round(v * 100) + '%', markers: tradeMarkers(p), h: 320 });
  });

  // ---------- area (roto points by category)
  dash.draw('area', (el) => {
    const S = rows('standings'); if (!S) return placeholder(el);
    const p = P(); const f = frame(el);
    const R = S.filter((r) => r.team === p.team).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!R.length) return placeholder(el);
    const w = Math.max(280, el.clientWidth), h = 330, m = { l: 40, r: w > 520 ? 54 : 16, t: 12, b: 28 };
    const svg = mkSvg(el, w, h, 'Stacked area of roto points by category for ' + p.team);
    const x = d3.scaleUtc().domain(d3.extent(R, (r) => pd(r.date))).range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain([0, d3.max(R, (r) => r.rotoTotal) * 1.05]).nice().range([h - m.b, m.t]);
    y.ticks(5).forEach((v) => { svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', GRID); svg.append('text').attr('x', m.l - 6).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('class', 'cv-tick').text(v); });
    const dates = R.map((r) => pd(r.date));
    thin(dates, x).forEach((d) => svg.append('text').attr('x', x(d)).attr('y', h - 8).attr('text-anchor', 'middle').attr('class', 'cv-tick').text(fd(d)));
    const stack = d3.stack().keys(CATS.map(([c]) => 'rp_' + c))(R);
    const area = d3.area().x((d, i) => x(dates[i])).y0((d) => y(d[0])).y1((d) => y(d[1]));
    stack.forEach((layer, i) => {
      svg.append('path').datum(layer).attr('d', area).attr('fill', col(i)).attr('fill-opacity', 0.9).attr('stroke', 'var(--color-bg)').attr('stroke-width', 1.5);
      if (w > 520) { const lst = layer[layer.length - 1]; const hh = y(lst[0]) - y(lst[1]); if (hh > 11) svg.append('text').attr('x', w - m.r + 6).attr('y', (y(lst[0]) + y(lst[1])) / 2 + 4).attr('class', 'cv-tick').text(CATS[i][1]); }
    });
    const g = svg.append('g'); const ms = tradeMarkers({ team: p.team, compare: '' });
    drawMarkers(g, x, ms, m.t, h - m.b);
    const cross = svg.append('line').attr('y1', m.t).attr('y2', h - m.b).attr('stroke', 'var(--color-fg)').attr('opacity', 0);
    svg.append('rect').attr('x', m.l).attr('width', w - m.l - m.r).attr('height', h).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px] = d3.pointer(ev);
        const i = d3.leastIndex(dates, (d) => Math.abs(x(d) - px)); const r = R[i];
        cross.attr('x1', x(dates[i])).attr('x2', x(dates[i])).attr('opacity', 0.6);
        const lines = [fd(dates[i]) + ' · ' + num(r.rotoTotal) + ' pts · ' + ord(r.rotoRank)].concat(CATS.map(([c, l]) => l + ' ' + num(r['rp_' + c])));
        const tr = nearTrade(ms, x, px); if (tr) lines.push(tr.label);
        f.show(lines, ev);
      }).on('pointerleave', () => { cross.attr('opacity', 0); f.hide(); });
    legend(el, CATS.map(([, l], i) => ({ color: col(i), label: l })).concat(ms.length ? [{ color: AXIS, label: 'Trade', dash: true }] : []));
  });

  // ---------- small multiples
  function panels(el, f, build) {
    const w = el.clientWidth || 600; const cols = w >= 900 ? 4 : w >= 560 ? 2 : 1; const gap = 12;
    const pw = Math.floor((w - gap * (cols - 1)) / cols);
    const grid = document.createElement('div'); grid.className = 'cv-grid'; grid.style.gridTemplateColumns = `repeat(${cols}, ${pw}px)`;
    el.insertBefore(grid, el.querySelector('.cv-tip'));
    CATS.forEach(([c, l]) => {
      const box = document.createElement('div'); box.className = 'cv-panel';
      const t = document.createElement('div'); t.className = 'cv-ptitle'; t.textContent = l; box.appendChild(t); grid.appendChild(box);
      const h = 150; const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${pw} ${h}`).attr('width', pw).attr('height', h).attr('role', 'img').attr('aria-label', l);
      build(svg, pw, h, c, l);
    });
  }

  dash.draw('bump', (el) => {
    const S = rows('standings'); if (!S) return placeholder(el);
    const p = P(); const raw = p.view === 'raw'; const f = frame(el); const ms = tradeMarkers(p);
    const teams = [...new Set(S.map((r) => r.team))]; const dates = [...new Set(S.map((r) => r.date))].sort();
    panels(el, f, (svg, w, h, c, l) => {
      const m = { l: raw ? 36 : 26, r: 8, t: 6, b: 18 };
      const x = d3.scaleUtc().domain([pd(dates[0]), pd(dates[dates.length - 1])]).range([m.l, w - m.r]);
      const isPct = c === 'fgPct' || c === 'ftPct';
      const tf = (v) => (isPct ? (v * 100).toFixed(1) : String(Math.round(v)));
      const ext = d3.extent(S, (r) => r[c]); const pad = (ext[1] - ext[0]) * 0.05 || 1;
      const y = raw ? d3.scaleLinear().domain([ext[0] - pad, ext[1] + pad]).range([h - m.b, m.t]) : d3.scaleLinear().domain([0.5, 15.5]).range([m.t, h - m.b]);
      const yv = (r) => y(raw ? r[c] : r['rk_' + c]);
      const ticks = raw ? y.ticks(3) : [1, 5, 10, 15];
      ticks.forEach((v) => { svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', GRID); svg.append('text').attr('x', m.l - 5).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('class', 'cv-tick').text(raw ? tf(v) : v); });
      [dates[0], dates[dates.length - 1]].forEach((d, i) => svg.append('text').attr('x', x(pd(d))).attr('y', h - 4).attr('text-anchor', i ? 'end' : 'start').attr('class', 'cv-tick').text(fd(pd(d))));
      const g = svg.append('g'); drawMarkers(g, x, ms, m.t, h - m.b);
      const line = d3.line().x((r) => x(pd(r.date))).y(yv);
      [...teams].sort((a, b) => isHi(a, p) - isHi(b, p) || (a === p.team) - (b === p.team)).forEach((t) => {
        const R = S.filter((r) => r.team === t).sort((a, b) => (a.date < b.date ? -1 : 1));
        g.append('path').datum(R).attr('d', line).attr('fill', 'none').attr('stroke', teamColor(t, p)).attr('stroke-width', isHi(t, p) ? 2.4 : 1).attr('stroke-opacity', isHi(t, p) ? 1 : 0.5).attr('stroke-linejoin', 'round');
        if (isHi(t, p)) { const q = R[R.length - 1]; g.append('circle').attr('cx', x(pd(q.date))).attr('cy', yv(q)).attr('r', 3.5).attr('fill', teamColor(t, p)).attr('stroke', 'var(--color-bg)').attr('stroke-width', 1.5); }
      });
      const cross = svg.append('line').attr('y1', m.t).attr('y2', h - m.b).attr('stroke', AXIS).attr('opacity', 0);
      svg.append('rect').attr('x', m.l).attr('width', w - m.l - m.r).attr('height', h).attr('fill', 'transparent')
        .on('pointermove', (ev) => {
          const [px] = d3.pointer(ev); const dt = dates.reduce((a, b) => (Math.abs(x(pd(b)) - px) < Math.abs(x(pd(a)) - px) ? b : a));
          cross.attr('x1', x(pd(dt))).attr('x2', x(pd(dt))).attr('opacity', 1);
          const lines = [l + (raw ? ' total · ' : ' rank · ') + fd(pd(dt))];
          [p.team, p.compare].filter(Boolean).forEach((t) => { const r = S.find((q) => q.date === dt && q.team === t); if (r) lines.push(t + ': ' + (raw ? valFmt(c, r[c]) + ' (rank ' + num(r['rk_' + c]) + ')' : num(r['rk_' + c]) + ' (' + valFmt(c, r[c]) + ')')); });
          const tr = nearTrade(ms, x, px); if (tr) lines.push(tr.label);
          f.show(lines, ev);
        }).on('pointerleave', () => { cross.attr('opacity', 0); f.hide(); });
    });
    teamLegend(el, p, ms.length ? [{ color: AXIS, label: 'Trade', dash: true }] : []);
  });

  function neighbors(S, team, c, sigma) {
    const dates = [...new Set(S.map((r) => r.date))].sort();
    return dates.map((d) => {
      const rs = S.filter((r) => r.date === d); const me = rs.find((r) => r.team === team); if (!me) return null;
      const abv = d3.min(rs.filter((r) => r[c] > me[c]), (r) => r[c]); const blw = d3.max(rs.filter((r) => r[c] < me[c]), (r) => r[c]);
      return { date: d, up: abv == null ? null : (abv - me[c]) / sigma, down: blw == null ? null : (me[c] - blw) / sigma, rawUp: abv == null ? null : abv - me[c], rawDown: blw == null ? null : me[c] - blw };
    }).filter(Boolean);
  }
  const sigmaOf = (S, c) => d3.deviation(latestOf(S), (r) => r[c]) || 1;

  dash.draw('gaps', (el) => {
    const S = rows('standings'); if (!S) return placeholder(el);
    const p = P(); const f = frame(el); const ms = tradeMarkers({ team: p.team, compare: '' });
    const data = {}; let ymax = 0;
    CATS.forEach(([c]) => { data[c] = neighbors(S, p.team, c, sigmaOf(S, c)); ymax = Math.max(ymax, d3.max(data[c], (d) => Math.max(d.up || 0, d.down || 0)) || 0); });
    const dates = [...new Set(S.map((r) => r.date))].sort();
    panels(el, f, (svg, w, h, c, l) => {
      const m = { l: 26, r: 8, t: 6, b: 18 };
      const x = d3.scaleUtc().domain([pd(dates[0]), pd(dates[dates.length - 1])]).range([m.l, w - m.r]);
      const y = d3.scaleLinear().domain([0, Math.ceil(ymax * 2) / 2]).range([h - m.b, m.t]);
      y.ticks(3).forEach((v) => { svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', GRID); svg.append('text').attr('x', m.l - 5).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('class', 'cv-tick').text(v); });
      [dates[0], dates[dates.length - 1]].forEach((d, i) => svg.append('text').attr('x', x(pd(d))).attr('y', h - 4).attr('text-anchor', i ? 'end' : 'start').attr('class', 'cv-tick').text(fd(pd(d))));
      const g = svg.append('g'); drawMarkers(g, x, ms, m.t, h - m.b);
      [['up', col(2)], ['down', col(3)]].forEach(([k, cl]) => {
        g.append('path').datum(data[c]).attr('d', d3.line().x((d) => x(pd(d.date))).y((d) => y(d[k])).defined((d) => d[k] != null)).attr('fill', 'none').attr('stroke', cl).attr('stroke-width', 2.2).attr('stroke-linejoin', 'round');
        const q = [...data[c]].reverse().find((d) => d[k] != null); if (q && q === data[c][data[c].length - 1]) g.append('circle').attr('cx', x(pd(q.date))).attr('cy', y(q[k])).attr('r', 3.5).attr('fill', cl).attr('stroke', 'var(--color-bg)').attr('stroke-width', 1.5);
      });
      const cross = svg.append('line').attr('y1', m.t).attr('y2', h - m.b).attr('stroke', AXIS).attr('opacity', 0);
      svg.append('rect').attr('x', m.l).attr('width', w - m.l - m.r).attr('height', h).attr('fill', 'transparent')
        .on('pointermove', (ev) => {
          const [px] = d3.pointer(ev); const d = data[c].reduce((a, b) => (Math.abs(x(pd(b.date)) - px) < Math.abs(x(pd(a.date)) - px) ? b : a));
          cross.attr('x1', x(pd(d.date))).attr('x2', x(pd(d.date))).attr('opacity', 1);
          const raw = (v) => (v == null ? '' : ' (' + (c === 'fgPct' || c === 'ftPct' ? (v * 100).toFixed(2) + ' pts' : Math.round(v)) + ')');
          const lines = [l + ' · ' + fd(pd(d.date)), 'To the team ahead: ' + (d.up == null ? 'none, you lead' : num(d.up, 2) + 'σ' + raw(d.rawUp)), 'Lead over the team behind: ' + (d.down == null ? 'none, you trail' : num(d.down, 2) + 'σ' + raw(d.rawDown))];
          const tr = nearTrade(ms, x, px); if (tr) lines.push(tr.label);
          f.show(lines, ev);
        }).on('pointerleave', () => { cross.attr('opacity', 0); f.hide(); });
    });
    legend(el, [{ color: col(2), label: 'Gap to the team ahead' }, { color: col(3), label: 'Cushion over the team behind' }].concat(ms.length ? [{ color: AXIS, label: 'Trade', dash: true }] : []));
  });

  // ---------- odds vs velocity scatter
  dash.draw('oddsvel', (el) => {
    const O = rows('odds'), R = rows('periods'); if (!O || !R) return placeholder(el);
    const p = P(); const f = frame(el);
    const end = d3.max(R, (r) => r.periodEnd); const rs = R.filter((r) => r.periodEnd === end && r.rotoStart != null);
    const od = [...new Set(O.map((r) => r.date))].sort();
    const start = rs.length ? rs[0].periodStart : null; const oStart = od.filter((d) => d <= start).pop() || od[0]; const oEnd = od[od.length - 1];
    const pts = rs.map((r) => { const a = O.find((o) => o.date === oStart && o.team === r.team), b = O.find((o) => o.date === oEnd && o.team === r.team); return a && b ? { team: r.team, dx: r.rotoEnd - r.rotoStart, dy: (b.topThird - a.topThird) * 100, from: a.topThird, to: b.topThird } : null; }).filter(Boolean);
    if (!pts.length) return placeholder(el);
    const w = Math.max(280, el.clientWidth), h = Math.min(380, Math.max(300, w * 0.6)), m = { l: 46, r: 16, t: 12, b: 36 };
    const svg = mkSvg(el, w, h, 'Scatter of roto point change against change in top-five odds');
    const ex = d3.extent(pts, (d) => d.dx), ey = d3.extent(pts, (d) => d.dy);
    const x = d3.scaleLinear().domain([Math.min(-1, ex[0]), Math.max(1, ex[1])]).nice().range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain([Math.min(-1, ey[0]), Math.max(1, ey[1])]).nice().range([h - m.b, m.t]);
    y.ticks(5).forEach((v) => { svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', v === 0 ? AXIS : GRID); svg.append('text').attr('x', m.l - 6).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('class', 'cv-tick').text(sgn(v, 0)); });
    x.ticks(6).forEach((v) => { svg.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', m.t).attr('y2', h - m.b).attr('stroke', v === 0 ? AXIS : GRID); svg.append('text').attr('x', x(v)).attr('y', h - 18).attr('text-anchor', 'middle').attr('class', 'cv-tick').text(sgn(v, 0)); });
    svg.append('text').attr('x', (m.l + w - m.r) / 2).attr('y', h - 3).attr('text-anchor', 'middle').attr('class', 'cv-tick').text('Roto points gained, ' + fd(pd(start)) + ' → ' + fd(pd(end)));
    svg.append('text').attr('transform', `translate(11 ${(m.t + h - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('class', 'cv-tick').text('Top-five odds change (pts)');
    [...pts].sort((a, b) => isHi(a.team, p) - isHi(b.team, p)).forEach((d) => {
      svg.append('circle').attr('cx', x(d.dx)).attr('cy', y(d.dy)).attr('r', isHi(d.team, p) ? 7 : 5).attr('fill', teamColor(d.team, p)).attr('fill-opacity', isHi(d.team, p) ? 1 : 0.7).attr('stroke', 'var(--color-bg)').attr('stroke-width', 2)
        .on('pointermove', (ev) => f.show([d.team, 'Roto points: ' + sgn(d.dx), 'Top-five odds: ' + pct(d.from) + ' → ' + pct(d.to)], ev)).on('pointerleave', f.hide);
      if (isHi(d.team, p)) svg.append('text').attr('x', x(d.dx) + 10).attr('y', y(d.dy) + 4).attr('class', 'cv-lab hi').text(trunc(d.team, 18)).style('pointer-events', 'none');
    });
    teamLegend(el, p);
  });

  // ---------- target map
  dash.draw('targets', (el) => {
    const S = rows('standings'); if (!S) return placeholder(el);
    const p = P(); const f = frame(el);
    const pts = CATS.map(([c, l]) => { const nb = neighbors(S, p.team, c, sigmaOf(S, c)); const d = nb[nb.length - 1]; const me = latestOf(S).find((r) => r.team === p.team); return d ? { c, l, up: d.up == null ? 0 : d.up, down: d.down == null ? null : d.down, lead: d.up == null, rp: me['rp_' + c], d } : null; }).filter(Boolean);
    const w = Math.max(280, el.clientWidth), h = Math.min(420, Math.max(320, w * 0.7)), m = { l: 46, r: 16, t: 14, b: 40 };
    const svg = mkSvg(el, w, h, 'Target map: gap to the team ahead against cushion over the team behind, by category');
    const xm = Math.max(1, d3.max(pts, (d) => d.up)) * 1.1; const ym = Math.max(1, d3.max(pts, (d) => d.down || 0)) * 1.1;
    const x = d3.scaleLinear().domain([0, xm]).range([m.l, w - m.r]); const y = d3.scaleLinear().domain([0, ym]).range([h - m.b, m.t]);
    const mx = d3.median(pts, (d) => d.up), my = d3.median(pts, (d) => d.down || 0);
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', w - m.l - m.r).attr('height', h - m.t - m.b).attr('fill', 'none').attr('stroke', GRID);
    svg.append('line').attr('x1', x(mx)).attr('x2', x(mx)).attr('y1', m.t).attr('y2', h - m.b).attr('stroke', AXIS).attr('stroke-dasharray', '3 3');
    svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(my)).attr('y2', y(my)).attr('stroke', AXIS).attr('stroke-dasharray', '3 3');
    [['Gain a spot, safe', m.l + 6, m.t + 14, 'start'], ['Contested both ways', m.l + 6, h - m.b - 8, 'start'], ['Stuck but safe', w - m.r - 6, m.t + 14, 'end'], ['Hard to climb, easy to lose', w - m.r - 6, h - m.b - 8, 'end']].forEach(([t, qx, qy, a]) => svg.append('text').attr('x', qx).attr('y', qy).attr('text-anchor', a).attr('class', 'cv-quad').text(t));
    x.ticks(5).forEach((v) => svg.append('text').attr('x', x(v)).attr('y', h - m.b + 14).attr('text-anchor', 'middle').attr('class', 'cv-tick').text(v));
    y.ticks(5).forEach((v) => svg.append('text').attr('x', m.l - 6).attr('y', y(v) + 4).attr('text-anchor', 'end').attr('class', 'cv-tick').text(v));
    svg.append('text').attr('x', (m.l + w - m.r) / 2).attr('y', h - 4).attr('text-anchor', 'middle').attr('class', 'cv-tick').text('Gap to the team ahead (σ of league spread)');
    svg.append('text').attr('transform', `translate(11 ${(m.t + h - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('class', 'cv-tick').text('Cushion over team behind (σ)');
    pts.forEach((d) => {
      const cy = d.down == null ? h - m.b : y(d.down);
      svg.append('circle').attr('cx', x(d.up)).attr('cy', cy).attr('r', 8).attr('fill', col(0)).attr('fill-opacity', 0.85).attr('stroke', 'var(--color-bg)').attr('stroke-width', 2)
        .on('pointermove', (ev) => f.show([d.l + ' · ' + num(d.rp) + ' roto pts', d.lead ? 'You lead the league' : 'Gap to team ahead: ' + num(d.up, 2) + 'σ', d.down == null ? 'Last in the league' : 'Cushion over team behind: ' + num(d.down, 2) + 'σ'], ev)).on('pointerleave', f.hide);
      svg.append('text').attr('x', x(d.up) + 11).attr('y', cy + 4).attr('class', 'cv-lab hi').text(d.l).style('pointer-events', 'none');
    });
    legend(el, [{ color: col(0), label: p.team + ', latest standings' }]);
  });

  // ---------- player contribution
  dash.draw('contrib', (el) => {
    const D = rows('players'); if (!D) return placeholder(el);
    const p = P(); const f = frame(el);
    const T = D.filter((r) => r.team === p.team); if (!T.length) return placeholder(el);
    const wcol = (c) => (c === 'fgPct' ? 't_fga' : c === 'ftPct' ? 't_fta' : 't_' + c);
    const tot = {}; CATS.forEach(([c]) => { tot[c] = d3.sum(T, (r) => r[wcol(c)]) || 1; });
    const overall = new Map(T.map((r) => [r.player, d3.sum(CATS, ([c]) => r[wcol(c)] / tot[c])]));
    const order = [...T].sort((a, b) => overall.get(b.player) - overall.get(a.player));
    const colorOf = new Map(order.map((r, i) => [r.player, i < 4 ? col(i) : MUTED]));
    const w = Math.max(300, el.clientWidth), lab = 44, rowH = 30, h = CATS.length * rowH + 22, m = { l: lab, r: 8 };
    const svg = mkSvg(el, w, h, 'Share of each category total contributed by each player on ' + p.team);
    const x = d3.scaleLinear().domain([0, 1]).range([m.l, w - m.r]);
    [0, 0.25, 0.5, 0.75, 1].forEach((v) => svg.append('text').attr('x', x(v)).attr('y', h - 4).attr('text-anchor', v === 0 ? 'start' : v === 1 ? 'end' : 'middle').attr('class', 'cv-tick').text(Math.round(v * 100) + '%'));
    CATS.forEach(([c, l], i) => {
      const y0 = i * rowH + 2; svg.append('text').attr('x', lab - 8).attr('y', y0 + 17).attr('text-anchor', 'end').attr('class', 'cv-lab').text(l);
      let acc = 0;
      order.forEach((r, k) => {
        const v = r[wcol(c)]; if (!v) return; const s = v / tot[c]; const x0 = x(acc), x1 = x(acc + s); acc += s;
        const g = svg.append('g');
        g.append('rect').attr('x', x0).attr('y', y0).attr('width', Math.max(0, x1 - x0 - 2)).attr('height', rowH - 8).attr('rx', 3).attr('fill', colorOf.get(r.player)).attr('fill-opacity', colorOf.get(r.player) === MUTED ? (k % 2 ? 0.45 : 0.7) : 0.95);
        const wid = x1 - x0 - 2;
        if (wid > 44) g.append('text').attr('x', x0 + 6).attr('y', y0 + 15).attr('class', 'cv-seg').text(trunc(r.player.split(' ').slice(-1)[0], Math.floor(wid / 6.5)));
        g.on('pointermove', (ev) => f.show([r.player + ' · ' + l, 'Share of team total: ' + Math.round(s * 100) + '%', c === 'fgPct' ? 'Share of field-goal attempts' : c === 'ftPct' ? 'Share of free-throw attempts' : 'Total: ' + Math.round(r['t_' + c]), r.gp + ' games, ' + r.acquired], ev)).on('pointerleave', f.hide);
      });
    });
    legend(el, order.slice(0, 4).map((r, i) => ({ color: col(i), label: r.player })).concat([{ color: MUTED, label: 'Everyone else' }]));
  });

  // ---------- radar
  dash.draw('radar', (el) => {
    const S = rows('standings'); if (!S) return placeholder(el);
    const p = P(); const f = frame(el); const L = latestOf(S);
    const size = Math.min(440, Math.max(280, el.clientWidth)); const cx = size / 2, cy = size / 2, R = size / 2 - 40;
    const svg = mkSvg(el, size, size, 'Radar of roto points by category'); svg.style('display', 'block').style('margin', '0 auto');
    const ang = (i) => (i / CATS.length) * 2 * Math.PI - Math.PI / 2;
    const rr = d3.scaleLinear().domain([0, 15]).range([0, R]);
    [3, 6, 9, 12, 15].forEach((v) => svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', rr(v)).attr('fill', 'none').attr('stroke', GRID));
    CATS.forEach(([c, l], i) => {
      svg.append('line').attr('x1', cx).attr('y1', cy).attr('x2', cx + R * Math.cos(ang(i))).attr('y2', cy + R * Math.sin(ang(i))).attr('stroke', GRID);
      svg.append('text').attr('x', cx + (R + 16) * Math.cos(ang(i))).attr('y', cy + (R + 16) * Math.sin(ang(i)) + 4).attr('text-anchor', 'middle').attr('class', 'cv-lab').text(l);
    });
    const poly = (vals) => d3.line().x((v, i) => cx + rr(v) * Math.cos(ang(i))).y((v, i) => cy + rr(v) * Math.sin(ang(i))).curve(d3.curveLinearClosed)(vals);
    const avg = CATS.map(([c]) => d3.mean(L, (r) => r['rp_' + c]));
    const mine = L.find((r) => r.team === p.team), cmp = p.compare ? L.find((r) => r.team === p.compare) : null;
    svg.append('path').attr('d', poly(avg)).attr('fill', 'none').attr('stroke', AXIS).attr('stroke-dasharray', '4 3').attr('stroke-width', 1.5);
    [[cmp, col(1)], [mine, col(0)]].forEach(([r, cl]) => {
      if (!r) return; const vals = CATS.map(([c]) => r['rp_' + c]);
      svg.append('path').attr('d', poly(vals)).attr('fill', cl).attr('fill-opacity', 0.14).attr('stroke', cl).attr('stroke-width', 2.4).attr('stroke-linejoin', 'round');
      vals.forEach((v, i) => svg.append('circle').attr('cx', cx + rr(v) * Math.cos(ang(i))).attr('cy', cy + rr(v) * Math.sin(ang(i))).attr('r', 5).attr('fill', cl).attr('stroke', 'var(--color-bg)').attr('stroke-width', 2)
        .on('pointermove', (ev) => f.show([r.team + ' · ' + CATS[i][1], num(v) + ' roto pts (rank ' + num(r['rk_' + CATS[i][0]]) + ')', valFmt(CATS[i][0], r[CATS[i][0]]) + ' · league average ' + num(avg[i]) + ' pts'], ev)).on('pointerleave', f.hide));
    });
    legend(el, [{ color: col(0), label: p.team }].concat(cmp ? [{ color: col(1), label: p.compare }] : [], [{ color: AXIS, label: 'League average', dash: true }]));
  });
})();
