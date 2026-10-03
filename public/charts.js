'use strict';

// Small hand-rolled SVG charts. Colors come from CSS custom properties so the
// light/dark steps swap without re-rendering logic.

const SVGNS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
  return el;
}

const Tip = {
  el: null,
  show(html, x, y) {
    this.el = this.el || document.getElementById('tip');
    this.el.innerHTML = html;
    this.el.classList.add('on');
    const r = this.el.getBoundingClientRect();
    let left = x + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    let top = y - r.height - 12;
    if (top < 8) top = y + 16;
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  },
  hide() {
    if (this.el) this.el.classList.remove('on');
  },
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function niceMax(v) {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return v;
}

function shortDay(day) {
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function longDay(day) {
  const d = new Date(day + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * Stacked columns, one per day. series: [{key, label, cls}] bottom → top.
 * rows: [{day, values: {key: n}}]. A legend above shows the hovered day's
 * numbers (latest day by default), so every value is readable without color.
 */
function stackedBars(host, { rows, series, label }) {
  host.replaceChildren();
  host.classList.add('chart');

  const legend = document.createElement('div');
  legend.className = 'legend';
  const legendDay = document.createElement('span');
  legendDay.className = 'legend-day';
  legend.appendChild(legendDay);
  const legendVals = series.map((s) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    item.innerHTML = `<i class="sw ${s.cls}"></i><span>${esc(s.label)}</span><b></b>`;
    legend.appendChild(item);
    return item.querySelector('b');
  });
  host.appendChild(legend);

  const paintLegend = (row) => {
    legendDay.textContent = longDay(row.day);
    series.forEach((s, i) => { legendVals[i].textContent = row.values[s.key] || 0; });
  };

  const W = Math.max(280, host.clientWidth || 600);
  const H = 190;
  const pad = { t: 8, r: 4, b: 24, l: 28 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const totals = rows.map((r) => series.reduce((a, s) => a + (r.values[s.key] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const slot = iw / rows.length;
  const bw = Math.max(3, Math.min(18, slot * 0.62));
  const y = (v) => pad.t + ih - (v / max) * ih;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label });
  for (let i = 0; i <= 2; i++) {
    const v = (max / 2) * i;
    svg.appendChild(svgEl('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: i === 0 ? 'axis' : 'grid' }));
    const t = svgEl('text', { x: pad.l - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' });
    t.textContent = v;
    svg.appendChild(t);
  }

  const hover = svgEl('rect', { class: 'col-hover', y: pad.t, height: ih, width: slot, rx: 6, opacity: 0 });
  svg.appendChild(hover);

  rows.forEach((row, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const x = cx - bw / 2;
    let acc = 0;
    const visible = series.filter((s) => row.values[s.key] > 0);
    visible.forEach((s, j) => {
      const v = row.values[s.key];
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const gap = j > 0 ? 2 : 0; // surface gap between stacked fills
      const h = Math.max(1, y0 - y1 - gap);
      const top = j === visible.length - 1;
      const r = top ? Math.min(4, bw / 2, h) : 0;
      const yt = y0 - gap - h;
      const d = `M${x},${y0 - gap} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${y0 - gap} Z`;
      svg.appendChild(svgEl('path', { d, class: 'bar ' + s.cls }));
    });
    if (i % 7 === (rows.length - 1) % 7) {
      const t = svgEl('text', { x: cx, y: H - 6, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = shortDay(row.day);
      svg.appendChild(t);
    }
    const hit = svgEl('rect', { x: pad.l + slot * i, y: 0, width: slot, height: H, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => {
      hover.setAttribute('x', pad.l + slot * i);
      hover.setAttribute('opacity', 1);
      paintLegend(row);
    });
    hit.addEventListener('pointermove', (ev) => {
      const lines = series.map((s) => `<div class="tip-row"><i class="sw ${s.cls}"></i>${esc(s.label)}<b>${row.values[s.key] || 0}</b></div>`).join('');
      Tip.show(`<div class="tip-h">${esc(longDay(row.day))}</div>${lines}<div class="tip-row tip-total">Total<b>${totals[i]}</b></div>`, ev.clientX, ev.clientY);
    });
    hit.addEventListener('pointerleave', () => {
      hover.setAttribute('opacity', 0);
      Tip.hide();
      paintLegend(rows[rows.length - 1]);
    });
    svg.appendChild(hit);
  });

  host.appendChild(svg);
  paintLegend(rows[rows.length - 1]);

  // Table view for screen readers and anyone who prefers numbers.
  const det = document.createElement('details');
  det.className = 'as-table';
  det.innerHTML = `<summary>Show as table</summary>`;
  const tbl = document.createElement('table');
  tbl.innerHTML = `<thead><tr><th>Day</th>${series.map((s) => `<th>${esc(s.label)}</th>`).join('')}<th>Total</th></tr></thead>`;
  const tb = document.createElement('tbody');
  [...rows].reverse().forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(longDay(r.day))}</td>${series.map((s) => `<td>${r.values[s.key] || 0}</td>`).join('')}<td>${totals[rows.length - 1 - i]}</td>`;
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);
  det.appendChild(tbl);
  host.appendChild(det);
}

/** Activity calendar: columns are weeks (Mon→Sun rows), one hue light→dark. */
function heatmap(host, cells) {
  host.replaceChildren();
  host.classList.add('chart');
  const max = Math.max(1, ...cells.map((c) => c.n));
  const step = (n) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const first = new Date(cells[0].day + 'T12:00:00Z').getUTCDay();
  const offset = (first + 6) % 7; // Monday-first rows
  const cols = Math.ceil((cells.length + offset) / 7);
  const gap = 3;
  const left = 30;
  // Cells grow to fill the panel, within reason.
  const size = Math.max(11, Math.min(24, Math.floor(((host.clientWidth || 300) - left) / cols) - gap));
  const top = 18;
  const W = left + cols * (size + gap);
  const H = top + 7 * (size + gap);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': 'Actions per day, last 15 weeks' });
  ['Mon', '', 'Wed', '', 'Fri', '', ''].forEach((l, r) => {
    if (!l) return;
    const t = svgEl('text', { x: 0, y: top + r * (size + gap) + size / 2 + 4, class: 'tick' });
    t.textContent = l;
    svg.appendChild(t);
  });
  let lastMonth = '';
  cells.forEach((c, i) => {
    const k = i + offset;
    const col = Math.floor(k / 7);
    const row = k % 7;
    const x = left + col * (size + gap);
    const yy = top + row * (size + gap);
    const month = new Date(c.day + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    if (row === 0 && month !== lastMonth) {
      const t = svgEl('text', { x, y: 11, class: 'tick' });
      t.textContent = month;
      svg.appendChild(t);
      lastMonth = month;
    }
    const rect = svgEl('rect', { x, y: yy, width: size, height: size, rx: Math.round(size / 5), class: 'heat s' + step(c.n) });
    rect.addEventListener('pointermove', (ev) => {
      Tip.show(`<div class="tip-h">${esc(longDay(c.day))}</div><div class="tip-row">Actions<b>${c.n}</b></div>`, ev.clientX, ev.clientY);
    });
    rect.addEventListener('pointerleave', () => Tip.hide());
    svg.appendChild(rect);
  });
  const wrap = document.createElement('div');
  wrap.className = 'heat-wrap';
  wrap.appendChild(svg);
  host.appendChild(wrap);
  const key = document.createElement('div');
  key.className = 'heat-key';
  key.innerHTML = `<span>Fewer</span>${[0, 1, 2, 3, 4].map((s) => `<i class="heat s${s}"></i>`).join('')}<span>More</span>`;
  host.appendChild(key);
}

/** One 100% bar: how a brief ended up. */
function outcomeBar(outcomes, total) {
  const el = document.createElement('span');
  el.className = 'obar';
  for (const k of ['done', 'later', 'dismissed', 'open']) {
    const n = outcomes[k] || 0;
    if (!n) continue;
    const seg = document.createElement('i');
    seg.className = 'o-' + k;
    seg.style.flexGrow = n;
    el.appendChild(seg);
  }
  el.setAttribute('aria-label', `${outcomes.done || 0} done, ${outcomes.later || 0} later, ${outcomes.dismissed || 0} dismissed, ${outcomes.open || 0} open of ${total}`);
  return el;
}
