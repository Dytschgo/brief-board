'use strict';

const TZ = 'Europe/Zurich';
const LANE_LABEL = { 'need-you': 'Need you', 'worth-knowing': 'Worth knowing', quiet: 'Quiet' };
const SNOOZE = [
  ['hour', 'In an hour'],
  ['tonight', 'Tonight, 18:00'],
  ['tomorrow', 'Tomorrow, 08:00'],
  ['monday', 'Monday, 08:00'],
  ['week', 'In a week'],
  ['someday', 'Someday'],
];

const state = {
  route: 'today',
  board: null,
  sel: null, // selected item id on Today
  undo: [], // recent actions, newest last
  archive: { briefs: null, day: null, kind: null, q: '', status: '' },
};

// ---- tiny helpers ---------------------------------------------------------

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || 'request_failed');
  return data;
}

const fmt = {
  time: (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TZ }),
  day: (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ }),
  when(iso) {
    if (!iso) return 'Someday';
    const d = new Date(iso);
    const key = (x) => x.toLocaleDateString('en-CA', { timeZone: TZ });
    const today = key(new Date());
    const tmr = key(new Date(Date.now() + 86400000));
    if (key(d) === today) return 'Today ' + fmt.time(iso);
    if (key(d) === tmr) return 'Tomorrow ' + fmt.time(iso);
    return fmt.day(iso) + ', ' + fmt.time(iso);
  },
  ago(iso) {
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return fmt.day(iso);
  },
  hours(h) {
    if (h == null) return '–';
    if (h < 1) return Math.round(h * 60) + ' min';
    if (h < 48) return (Math.round(h * 10) / 10) + ' h';
    return Math.round(h / 24) + ' days';
  },
  longDate(day) {
    const d = day ? new Date(day + 'T12:00:00Z') : new Date();
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: day ? 'UTC' : TZ });
  },
};

function toast(msg, undoFn) {
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', { text: msg }));
  if (undoFn) {
    t.append(h('button', {
      type: 'button',
      onclick: () => { t.classList.remove('on'); undoFn(); },
    }, 'Undo'));
  }
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), undoFn ? 6000 : 2400);
}

// ---- routing --------------------------------------------------------------

const ROUTES = { '/': 'today', '/overview': 'overview', '/archive': 'archive', '/history': 'archive' };

function go(path, push) {
  const route = ROUTES[path] || 'today';
  state.route = route;
  if (push) history.pushState({}, '', path === '/history' ? '/archive' : path);
  document.querySelectorAll('.rail-links a').forEach((a) => {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = { today: 'Major', overview: 'Overview · Major', archive: 'Archive · Major' }[route];
  const view = document.getElementById('view');
  view.dataset.route = route;
  ({ today: renderToday, overview: renderOverview, archive: renderArchive })[route]();
}

document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[href^="/"]');
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || a.target) return;
  ev.preventDefault();
  go(a.getAttribute('href'), true);
});
window.addEventListener('popstate', () => go(location.pathname, false));

// ---- today ----------------------------------------------------------------

async function renderToday() {
  const view = document.getElementById('view');
  if (!state.board) view.replaceChildren(h('div', { class: 'loading' }, 'Loading today’s brief'));
  try {
    state.board = await api('/api/board');
  } catch (_) {
    view.replaceChildren(errorBlock('Couldn’t reach the board server. Check that it’s running, then reload.'));
    return;
  }
  if (state.route !== 'today') return;
  paintToday();
}

function paintToday() {
  const b = state.board;
  const view = document.getElementById('view');
  const items = b.items;
  const need = items.filter((i) => i.lane === 'need-you');
  const know = items.filter((i) => i.lane === 'worth-knowing');
  const quiet = items.filter((i) => i.lane === 'quiet');
  const actionable = [...need, ...know];
  if (!actionable.some((i) => i.id === state.sel)) state.sel = actionable[0] ? actionable[0].id : null;
  paintCount(items.length);

  const p = b.progress;
  const pct = p.total ? Math.round((p.cleared / p.total) * 100) : 0;
  const head = h('header', { class: 'page-head' },
    h('p', { class: 'kicker', text: fmt.longDate(b.day) }),
    h('div', { class: 'title-row' },
      h('h1', { text: (b.kind || 'Morning') + ' Brief' }),
      h('button', { type: 'button', class: 'text-btn', onclick: () => document.getElementById('keys').showModal() }, 'Shortcuts'),
    ),
    h('div', { class: 'progress' },
      h('div', { class: 'track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': p.total, 'aria-valuenow': p.cleared, 'aria-label': 'Cleared' },
        h('i', { style: `width:${pct}%` })),
      h('p', { class: 'progress-note' },
        h('span', { text: items.length ? `${p.cleared} of ${p.total} done` : 'All done' }),
        b.updated_at ? h('span', { class: 'muted', text: 'Arrived ' + fmt.time(b.updated_at) }) : null),
    ),
  );

  const main = h('div', { class: 'stack' });
  main.append(section('Need you', need.length, need.length
    ? group(need.map(itemRow))
    : h('div', { class: 'group' }, h('p', { class: 'empty-row', text: p.total ? 'You’ve handled everything that needed you.' : 'Nothing yet. Major posts the next brief in the morning.' }))));

  if (know.length) main.append(section('Worth knowing', know.length, group(know.map(itemRow))));

  if (quiet.length) {
    main.append(section('Quiet', quiet.length, group(quiet.map(quietRow)),
      h('button', { type: 'button', class: 'text-btn', onclick: () => bulk('dismiss', quiet) }, 'Clear all')));
  }

  if (b.upcoming.length) {
    main.append(section('Coming back', b.upcoming.length,
      group(b.upcoming.slice(0, 8).map((it) => h('li', { class: 'mini' },
        glyph(it),
        h('span', { class: 'mini-title', text: it.title }),
        h('time', { datetime: it.snooze_until || '', text: fmt.when(it.snooze_until) }),
        h('button', { type: 'button', class: 'text-btn', onclick: () => reopen(it) }, 'Show now'),
      ))),
      b.upcoming.length > 8 ? h('a', { href: '/archive', class: 'text-btn' }, 'See all') : null));
  }

  view.replaceChildren(head, main);
  highlight();
}

function paintCount(n) {
  const el = document.getElementById('todayCount');
  if (el) el.textContent = n ? String(n) : '';
}

function section(title, count, body, action) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' },
      h('h2', {}, title, count ? h('span', { class: 'count', text: count }) : null),
      action || null),
    body);
}

function group(rows) {
  return h('ul', { class: 'group' }, rows);
}

function empty(msg) {
  return h('p', { class: 'empty', text: msg });
}

function errorBlock(msg) {
  return h('div', { class: 'error' }, h('p', { text: msg }), h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, 'Reload'));
}

function badges(it) {
  const out = [];
  if (it.resurfaced) out.push(h('span', { class: 'tag', text: 'Snoozed' }));
  if (it.updated) out.push(h('span', { class: 'tag', text: 'Updated' }));
  if (it.days_seen > 1) out.push(h('span', { class: 'tag warn', text: `Day ${it.days_seen}` }));
  if (it.pinned) out.push(h('span', { class: 'tag', text: 'Brought back' }));
  return out;
}

function itemRow(it) {
  const noteInput = h('input', {
    type: 'text', maxlength: 500, placeholder: 'Reply to Major…', 'aria-label': 'Reply to Major about ' + it.title,
  });
  return h('li', {
    class: 'card ' + it.lane, 'data-id': it.id, tabindex: -1,
    onclick: (ev) => { if (!ev.target.closest('button, input, a, form')) select(it.id); },
  },
  glyph(it),
  h('div', { class: 'card-main' },
    h('div', { class: 'card-top' },
      h('h3', {}, it.url ? h('a', { href: it.url, target: '_blank', rel: 'noopener' }, it.title) : it.title),
      h('div', { class: 'tags' }, badges(it)),
    ),
    it.body ? h('p', { class: 'body', text: it.body }) : null,
    it.note ? h('p', { class: 'saved-note', text: '“' + it.note + '”' }) : null,
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => act('do', it) }, 'Done'),
      h('button', { type: 'button', class: 'btn later', 'aria-haspopup': 'menu', onclick: (ev) => laterMenu(it, ev.currentTarget) }, 'Later'),
      h('button', { type: 'button', class: 'btn', onclick: () => act('dismiss', it) }, 'Dismiss'),
      h('form', {
        class: 'reply',
        onsubmit: (ev) => {
          ev.preventDefault();
          const text = noteInput.value.trim();
          if (!text) { noteInput.focus(); toast('Write a reply first'); return; }
          act('note', it, { note: text });
        },
      }, noteInput, h('button', { type: 'submit', class: 'text-btn send' }, 'Send')),
    ),
  ));
}

function quietRow(it) {
  return h('li', { class: 'mini pill', 'data-id': it.id },
    glyph(it),
    h('span', { class: 'mini-title', text: it.title }),
    h('button', { type: 'button', class: 'text-btn', 'aria-label': 'Dismiss ' + it.title, onclick: () => act('dismiss', it) }, 'Dismiss'));
}

function select(id, scroll) {
  state.sel = id;
  highlight();
  const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (el && scroll) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function highlight() {
  document.querySelectorAll('.card.sel').forEach((e) => e.classList.remove('sel'));
  if (!state.sel) return;
  const q = CSS.escape(state.sel);
  document.querySelectorAll(`.card[data-id="${q}"]`).forEach((e) => e.classList.add('sel'));
}

function moveSel(dir) {
  const ids = [...document.querySelectorAll('.card')].map((c) => c.dataset.id);
  if (!ids.length) return;
  const i = ids.indexOf(state.sel);
  select(ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + dir))], true);
}

function laterMenu(it, anchor) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu', id: 'menu' },
    SNOOZE.map(([k, label], i) => h('button', {
      type: 'button', role: 'menuitem', 'data-k': k,
      onclick: () => { closeMenu(); act('later', it, { until: k }); },
    }, label, h('kbd', {}, String(i + 1)))));
  menu.dataset.id = it.id;
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  const top = r.bottom + 6 + mh > window.innerHeight ? r.top - mh - 6 : r.bottom + 6;
  menu.style.transform = `translate(${Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px, ${Math.round(top)}px)`;
  menu.querySelector('button').focus();
  setTimeout(() => document.addEventListener('pointerdown', outside), 0);
}
function outside(ev) {
  if (!ev.target.closest('#menu')) closeMenu();
}
function closeMenu() {
  const m = document.getElementById('menu');
  if (m) m.remove();
  document.removeEventListener('pointerdown', outside);
}

const DONE_MSG = { do: 'Marked done', note: 'Reply sent to Major', dismiss: 'Dismissed' };

// Optimistic: the card leaves immediately; if the save fails it comes back.
async function act(action, it, extra) {
  const els = document.querySelectorAll(`[data-id="${CSS.escape(it.id)}"]`);
  if ([...els].some((e) => e.dataset.busy)) return;
  const ids = [...document.querySelectorAll('.card')].map((c) => c.dataset.id);
  const nextSel = ids[ids.indexOf(it.id) + 1] || ids[ids.indexOf(it.id) - 1] || null;
  els.forEach((e) => { e.dataset.busy = '1'; e.classList.add('leaving'); });
  try {
    const res = await api('/api/action', Object.assign({ action, item_id: it.id, lane: it.lane, title: it.title }, extra || {}));
    state.board = res.board;
    state.undo.push({ id: it.id, title: it.title, action });
    if (state.undo.length > 20) state.undo.shift();
    if (state.sel === it.id) state.sel = nextSel;
    await wait(220);
    if (state.route === 'today') paintToday();
    const msg = action === 'later'
      ? (res.item.snooze_until ? 'Snoozed until ' + fmt.when(res.item.snooze_until) : 'Moved to someday')
      : DONE_MSG[action];
    toast(msg, () => undo(it.id));
  } catch (_) {
    els.forEach((e) => { delete e.dataset.busy; e.classList.remove('leaving'); });
    toast('Couldn’t save that. Check the board server and try again.');
  }
}

async function bulk(action, items) {
  try {
    const res = await api('/api/bulk', { action, item_ids: items.map((i) => i.id) });
    state.board = res.board;
    for (const it of items) state.undo.push({ id: it.id, title: it.title, action });
    paintToday();
    toast(`Dismissed ${res.item_ids.length} quiet items`, async () => {
      for (const id of res.item_ids) await api('/api/undo', { item_id: id }).catch(() => {});
      renderToday();
    });
  } catch (_) {
    toast('Couldn’t dismiss those. Try again.');
  }
}

async function undo(id) {
  const target = id || (state.undo.length ? state.undo[state.undo.length - 1].id : null);
  if (!target) { toast('Nothing to undo'); return; }
  try {
    const res = await api('/api/undo', { item_id: target });
    state.undo = state.undo.filter((u) => u.id !== target);
    state.board = res.board;
    state.sel = target;
    if (state.route === 'today') paintToday();
    else go(location.pathname);
    toast('Undone');
  } catch (_) {
    toast('Nothing to undo');
  }
}

async function reopen(it) {
  try {
    const res = await api('/api/reopen', { item_id: it.id });
    state.board = res.board;
    if (state.route === 'today') { state.sel = it.id; paintToday(); select(it.id, true); }
    toast('Back on today’s board', () => undoReopen(it));
    return true;
  } catch (_) {
    toast('Couldn’t bring that back. Try again.');
    return false;
  }
}
async function undoReopen(it) {
  // Reopen is reversed by re-applying the item's previous status.
  const action = { done: 'do', later: 'later', dismissed: 'dismiss' }[it.status];
  if (action) await act(action, it, it.status === 'later' ? { until: it.snooze_until || 'someday' } : null);
}

const wait = (ms) => new Promise((r) => setTimeout(r, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms));

// ---- overview -------------------------------------------------------------

async function renderOverview() {
  const view = document.getElementById('view');
  view.replaceChildren(h('div', { class: 'loading' }, 'Loading the last 30 days'));
  let s;
  try {
    s = await api('/api/stats');
  } catch (_) {
    view.replaceChildren(errorBlock('Couldn’t load your stats. Check the board server, then reload.'));
    return;
  }
  if (state.route !== 'overview') return;

  const handled = s.totals.done + s.totals.later + s.totals.dismissed;
  const rate = s.totals.received ? Math.round((handled / s.totals.received) * 100) : 0;

  const tiles = h('div', { class: 'tiles' },
    tile('t-green', 'Cleared in a row', s.streak, s.streak === 1 ? 'brief' : 'briefs', `Every need-you item handled the day it arrived. ${s.cleared_days} of ${s.brief_days} briefs overall.`),
    tile('t-blue', 'Time to act', fmt.hours(s.latency_h.median), null, s.latency_h.p75 != null ? `Median from arrival to first action. Slowest quarter: over ${fmt.hours(s.latency_h.p75)}.` : 'Shows up after your first few actions.'),
    tile('t-purple', 'Handled', rate + '%', null, `${handled} of ${s.totals.received} items Major sent in 30 days.`),
    tile('t-orange', 'Snoozed', s.queue, s.queue === 1 ? 'item' : 'items', 'Waiting to come back to today’s board.'),
  );

  const recvHost = h('div');
  const actHost = h('div');
  const heatHost = h('div');

  const linger = s.lingering.length
    ? h('ol', { class: 'linger' }, s.lingering.map((it) => h('li', {},
      glyph(it), h('span', { class: 'l-title', text: it.title }), h('span', { class: 'l-days', text: `Day ${it.days_seen}` }))))
    : empty('Nothing has been sitting around. Items that stay open for more than a day show up here.');

  view.replaceChildren(
    h('header', { class: 'page-head' }, h('p', { class: 'kicker', text: 'Last 30 days' }), h('h1', { text: 'Overview' })),
    tiles,
    h('div', { class: 'panels' },
      h('section', { class: 'panel wide' }, h('h2', { text: 'What Major sent' }), recvHost),
      h('section', { class: 'panel wide' }, h('h2', { text: 'What you did with it' }), actHost),
      h('section', { class: 'panel' }, h('h2', { text: 'When you work through it' }), heatHost),
      h('section', { class: 'panel' }, h('h2', { text: 'Still open after a day' }), linger),
    ),
  );

  const draw = () => {
    stackedBars(recvHost, {
      label: 'Items received per day by lane',
      series: [
        { key: 'need-you', label: 'Need you', cls: 'c-need' },
        { key: 'worth-knowing', label: 'Worth knowing', cls: 'c-know' },
        { key: 'quiet', label: 'Quiet', cls: 'c-quiet' },
      ],
      rows: s.series.map((r) => ({ day: r.day, values: r.received })),
    });
    stackedBars(actHost, {
      label: 'Actions per day by outcome',
      series: [
        { key: 'do', label: 'Done', cls: 'c-done' },
        { key: 'later', label: 'Later', cls: 'c-later' },
        { key: 'dismiss', label: 'Dismissed', cls: 'c-dismiss' },
      ],
      rows: s.series.map((r) => ({ day: r.day, values: r.handled })),
    });
    heatmap(heatHost, s.heat);
  };
  draw();
  clearTimeout(renderOverview.rt);
  window.onresize = () => {
    clearTimeout(renderOverview.rt);
    renderOverview.rt = setTimeout(() => state.route === 'overview' && draw(), 150);
  };
}

function tile(tint, label, value, unit, note) {
  return h('div', { class: 'tile ' + tint },
    h('p', { class: 't-label', text: label }),
    h('p', { class: 't-value' }, String(value), unit ? h('span', { text: ' ' + unit }) : null),
    h('p', { class: 't-note', text: note }));
}

// ---- archive --------------------------------------------------------------

async function renderArchive() {
  const view = document.getElementById('view');
  const a = state.archive;
  const search = h('input', {
    type: 'search', id: 'search', placeholder: 'Search everything Major has sent', value: a.q, 'aria-label': 'Search items',
  });
  const filters = h('div', { class: 'seg-ctl', role: 'group', 'aria-label': 'Filter by status' },
    [['', 'By brief'], ['later', 'Snoozed'], ['done', 'Done'], ['dismissed', 'Dismissed']].map(([k, label]) =>
      h('button', {
        type: 'button', 'aria-pressed': String(a.status === k),
        onclick: () => { a.status = k; renderArchive(); },
      }, label)));
  const list = h('nav', { class: 'brief-list', 'aria-label': 'Past briefs' });
  const detail = h('div', { class: 'detail' });

  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { a.q = search.value; paintDetail(detail); }, 160);
  });

  view.replaceChildren(
    h('header', { class: 'page-head' }, h('p', { class: 'kicker', text: 'Every brief and what happened to it' }), h('h1', { text: 'Archive' })),
    h('div', { class: 'toolbar' }, search, filters),
    h('div', { class: 'archive' }, list, detail),
  );

  try {
    const res = await api('/api/briefs');
    a.briefs = res.briefs;
  } catch (_) {
    detail.replaceChildren(errorBlock('Couldn’t load the archive. Check the board server, then reload.'));
    return;
  }
  if (state.route !== 'archive') return;
  if (!a.day && a.briefs[0]) { a.day = a.briefs[0].day; a.kind = a.briefs[0].kind; }

  if (!a.briefs.length) list.append(empty('No briefs yet. They’ll collect here as Major sends them.'));
  let lastMonth = '';
  for (const b of a.briefs) {
    const month = new Date(b.day + 'T12:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    if (month !== lastMonth) { list.append(h('h3', { class: 'month', text: month })); lastMonth = month; }
    const d = new Date(b.day + 'T12:00:00Z');
    list.append(h('button', {
      type: 'button', class: 'brief-row', 'aria-current': String(!a.status && !a.q && a.day === b.day && a.kind === b.kind),
      onclick: () => { a.day = b.day; a.kind = b.kind; a.status = ''; a.q = ''; renderArchive(); },
    },
    h('span', { class: 'b-date' },
      h('b', { text: d.getUTCDate() }),
      h('span', { text: d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) })),
    h('span', { class: 'b-main' },
      h('span', { class: 'b-kind' }, b.kind, h('span', { class: 'muted', text: String(b.count) })),
      outcomeBar(b.outcomes, b.count)),
    ));
  }
  paintDetail(detail);
}

async function paintDetail(detail) {
  const a = state.archive;
  if (a.q || a.status) {
    const qs = new URLSearchParams({ q: a.q, status: a.status });
    const res = await api('/api/search?' + qs).catch(() => ({ items: [] }));
    const title = a.q ? `Results for “${a.q}”` : { later: 'Snoozed', done: 'Done', dismissed: 'Dismissed' }[a.status];
    detail.replaceChildren(
      h('h2', { class: 'detail-h' }, title, h('span', { class: 'count', text: res.items.length })),
      res.items.length ? h('ul', { class: 'rows' }, res.items.map(archiveRow)) : empty(a.q ? 'Nothing matches. Try a shorter word.' : 'Nothing here.'),
    );
    return;
  }
  if (!a.day) { detail.replaceChildren(); return; }
  try {
    const b = await api(`/api/briefs/${encodeURIComponent(a.day)}?kind=${encodeURIComponent(a.kind || '')}`);
    detail.replaceChildren(
      h('h2', { class: 'detail-h' }, fmt.longDate(b.day), h('span', { class: 'count', text: b.items.length })),
      h('p', { class: 'sub', text: `${b.kind} brief, arrived ${fmt.time(b.received_at)}` }),
      h('ul', { class: 'rows' }, b.items.map(archiveRow)),
    );
  } catch (_) {
    detail.replaceChildren(empty('That brief isn’t in the archive anymore.'));
  }
}

const OUTCOME = { done: 'Done', later: 'Snoozed', dismissed: 'Dismissed', open: 'Open' };

function archiveRow(it) {
  const status = it.status || 'open';
  let when = '';
  if (status === 'later') when = 'until ' + fmt.when(it.snooze_until);
  else if (it.acted_at && status !== 'open') when = fmt.day(it.acted_at) + ', ' + fmt.time(it.acted_at);
  const li = h('li', { class: 'r ' + (it.lane || '') },
    glyph(it),
    h('div', { class: 'r-main' },
      h('h3', { text: it.title }),
      it.body ? h('p', { class: 'body', text: it.body }) : null,
      it.note ? h('p', { class: 'saved-note' }, h('span', { text: 'Your note' }), it.note) : null,
    ),
    h('div', { class: 'r-side' },
      h('span', { class: 'status s-' + status }, h('i'), OUTCOME[status]),
      when ? h('span', { class: 'r-when', text: when }) : null,
      status !== 'open'
        ? h('button', {
          type: 'button', class: 'text-btn',
          onclick: async (ev) => {
            ev.currentTarget.disabled = true;
            if (await reopen(Object.assign({ status }, it))) renderArchive();
          },
        }, 'Bring back')
        : null,
    ));
  return li;
}

// ---- sync indicator -------------------------------------------------------

function paintSync(s) {
  const btn = document.getElementById('sync');
  let cls = 'ok';
  let short = 'Up to date';
  let label = 'Major is up to date';
  if (!s.configured) {
    cls = 'off'; short = 'Not connected';
    label = 'Not connected to Major. Add a webhook URL in config.json to send your actions.';
  } else if (s.pending) {
    cls = s.last_error ? 'warn' : 'busy';
    short = s.last_error ? 'Retry sending' : 'Sending…';
    label = `${s.pending} ${s.pending === 1 ? 'update' : 'updates'} waiting to send` + (s.last_error ? ` (last try: ${s.last_error.reason}). Click to retry.` : '');
  } else if (s.last_ok_at) label += ', last sent ' + fmt.ago(s.last_ok_at);
  btn.className = 'sync ' + cls;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.querySelector('.sync-label').textContent = short;
  btn.onclick = s.pending ? () => api('/api/outbox/retry', {}).then(paintSync).catch(() => {}) : null;
}

function connect() {
  if (!window.EventSource) return;
  const es = new EventSource('/api/stream');
  es.addEventListener('sync', (e) => paintSync(JSON.parse(e.data)));
  es.addEventListener('board', (e) => {
    const d = JSON.parse(e.data);
    if (state.route !== 'today' || !state.board) return;
    if (d.updated_at !== state.board.updated_at || d.open !== state.board.items.length) renderToday();
  });
}

// ---- keyboard -------------------------------------------------------------

document.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const menu = document.getElementById('menu');
  if (menu) {
    if (ev.key === 'Escape') { closeMenu(); return; }
    const n = Number(ev.key);
    if (n >= 1 && n <= SNOOZE.length) { ev.preventDefault(); menu.querySelectorAll('button')[n - 1].click(); return; }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const bs = [...menu.querySelectorAll('button')];
      const i = bs.indexOf(document.activeElement);
      bs[(i + (ev.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
    }
    return;
  }
  const typing = ev.target.matches && (ev.target.matches('input, textarea, select') || ev.target.isContentEditable);
  if (typing) {
    if (ev.key === 'Escape') ev.target.blur();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  const k = ev.key.toLowerCase();
  if (k === '1') return go('/', true);
  if (k === '2') return go('/overview', true);
  if (k === '3') return go('/archive', true);
  if (k === '?') return document.getElementById('keys').showModal();
  if (k === '/') {
    ev.preventDefault();
    if (state.route !== 'archive') go('/archive', true);
    setTimeout(() => { const s = document.getElementById('search'); if (s) s.focus(); }, 50);
    return;
  }
  if (k === 'u' || k === 'z') return undo();
  if (state.route !== 'today' || !state.board) return;
  const it = state.board.items.find((i) => i.id === state.sel);
  if (k === 'j' || ev.key === 'ArrowDown') { ev.preventDefault(); return moveSel(1); }
  if (k === 'k' || ev.key === 'ArrowUp') { ev.preventDefault(); return moveSel(-1); }
  if (!it) return;
  if (k === 'd' || k === 'e') return act('do', it);
  if (k === 'x' || k === '#') return act('dismiss', it);
  if (k === 'l' || k === 's') {
    const btn = document.querySelector(`.card[data-id="${CSS.escape(it.id)}"] .later`);
    if (btn) { ev.preventDefault(); laterMenu(it, btn); }
    return;
  }
  if (k === 'r' || k === 'n') {
    const input = document.querySelector(`.card[data-id="${CSS.escape(it.id)}"] input`);
    if (input) { ev.preventDefault(); input.focus(); }
  }
});

// ---- theme ----------------------------------------------------------------

document.getElementById('theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch (_) {}
  paintThemeBtn();
  if (state.route === 'overview') renderOverview();
});
function paintThemeBtn() {
  const dark = document.documentElement.dataset.theme !== 'light';
  document.getElementById('theme').setAttribute('aria-label', dark ? 'Switch to light appearance' : 'Switch to dark appearance');
}
paintThemeBtn();

// Refresh relative times and due snoozes when the tab comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.route === 'today') renderToday();
});

api('/api/status').then(paintSync).catch(() => {});
api('/api/board').then((b) => paintCount(b.items.length)).catch(() => {});
connect();
go(location.pathname, false);
