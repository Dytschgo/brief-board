'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dayKey, snoozeUntil, lastNDays, localParts } = require('./time');

const LANES = ['need-you', 'worth-knowing', 'quiet'];
const ACTIONS = ['do', 'note', 'later', 'dismiss'];
const TRAIL_MAX = 40;

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(p, obj) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

function fingerprint(it) {
  return crypto.createHash('sha1').update(String(it.title || '') + '\n' + String(it.body || '')).digest('hex').slice(0, 12);
}

function slug(s) {
  return String(s || 'brief').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'brief';
}

function lane(v) {
  return LANES.includes(v) ? v : 'need-you';
}

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max || 4000) : '';
}

/**
 * One ledger holds every item the producer has ever sent, keyed by id, with its
 * current status. The board, the queue and the archive are all views over it,
 * so an item can never be in two places at once.
 */
class Store {
  constructor(dir) {
    this.dir = dir;
    this.p = {
      ledger: path.join(dir, 'ledger.json'),
      events: path.join(dir, 'events.jsonl'),
      briefs: path.join(dir, 'briefs'),
      // v1 files, read once for migration
      board: path.join(dir, 'board.json'),
      history: path.join(dir, 'history.json'),
      dismissed: path.join(dir, 'dismissed.json'),
    };
    fs.mkdirSync(this.p.briefs, { recursive: true });
    this.ledger = this.loadLedger();
  }

  loadLedger() {
    const l = readJson(this.p.ledger, null);
    if (l && l.version === 2 && l.items) return l;
    const fresh = this.migrateV1();
    writeJson(this.p.ledger, fresh);
    return fresh;
  }

  migrateV1() {
    const now = new Date().toISOString();
    const led = { version: 2, current: { kind: 'Morning', date: '', day: '', updated_at: '', ids: [] }, items: {} };
    const put = (it, status, at) => {
      if (!it || !it.id) return;
      led.items[it.id] = this.newRecord(it, at || now);
      Object.assign(led.items[it.id], {
        status,
        acted_at: status === 'open' ? null : at || now,
        note: str(it.note, 2000),
      });
    };
    const board = readJson(this.p.board, null);
    const hist = readJson(this.p.history, { later: [], done: [] });
    const dis = readJson(this.p.dismissed, { dismissed: [] });
    for (const it of (hist.done || [])) put(it, 'done', it.acted_at);
    for (const it of (hist.later || [])) put(it, 'later', it.acted_at);
    for (const d of (dis.dismissed || [])) put(Object.assign({ id: d.id, title: d.title }, d.item || {}), 'dismissed', d.at);
    if (board && Array.isArray(board.items)) {
      led.current = { kind: board.kind || 'Morning', date: board.date || '', day: dayKey(board.updated_at || now), updated_at: board.updated_at || now, ids: [] };
      for (const it of board.items) {
        if (!it || !it.id || led.items[it.id]) continue;
        put(it, 'open', null);
        led.current.ids.push(it.id);
      }
    }
    return led;
  }

  newRecord(it, at) {
    return {
      id: String(it.id),
      title: str(it.title, 300) || String(it.id),
      body: str(it.body),
      lane: lane(it.lane),
      image: str(it.image, 300),
      url: str(it.url, 1000),
      note: '',
      status: 'open',
      first_seen: at,
      last_seen: at,
      seen: [dayKey(at)],
      acted_at: null,
      snooze_until: null,
      fp: fingerprint(it),
      updated: false,
      pinned: false,
      trail: [],
    };
  }

  save() {
    writeJson(this.p.ledger, this.ledger);
  }

  log(ev) {
    fs.appendFileSync(this.p.events, JSON.stringify(Object.assign({ at: new Date().toISOString() }, ev)) + '\n');
  }

  readEvents() {
    let raw = '';
    try { raw = fs.readFileSync(this.p.events, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch (_) {}
    }
    return out;
  }

  // ---- producer -----------------------------------------------------------

  ingest(board, nowArg) {
    const now = nowArg ? new Date(nowArg) : new Date();
    const iso = now.toISOString();
    const day = dayKey(now);
    const ids = [];
    const snap = [];

    for (const raw of board.items || []) {
      if (!raw || !raw.id) continue;
      const id = String(raw.id);
      if (ids.includes(id)) continue;
      let rec = this.ledger.items[id];
      const fp = fingerprint(raw);
      if (!rec) {
        rec = this.ledger.items[id] = this.newRecord(raw, iso);
      } else {
        rec.title = str(raw.title, 300) || rec.title;
        rec.body = str(raw.body);
        rec.lane = lane(raw.lane || rec.lane);
        rec.image = str(raw.image, 300) || rec.image;
        rec.url = str(raw.url, 1000) || rec.url;
        rec.last_seen = iso;
        if (!rec.seen.includes(day)) rec.seen.push(day);
        // Something you finished came back with new content: show it again.
        if (rec.status === 'done' && rec.fp !== fp) {
          this.trail(rec, 'changed', { status: rec.status });
          rec.status = 'open';
          rec.updated = true;
        }
        rec.fp = fp;
      }
      if (raw.note && !rec.note) rec.note = str(raw.note, 2000);
      // v1 producers could pre-file items.
      if ((raw.status === 'later' || raw.status === 'done') && rec.status !== raw.status) {
        this.trail(rec, 'producer', { status: rec.status });
        rec.status = raw.status;
        rec.acted_at = iso;
        if (raw.status === 'later') rec.snooze_until = snoozeUntil('someday');
      }
      ids.push(id);
      snap.push({ id, title: rec.title, body: rec.body, lane: rec.lane, image: rec.image, url: rec.url });
    }

    const kind = str(board.kind, 60) || 'Morning';
    this.ledger.current = { kind, date: str(board.date, 120), day, updated_at: iso, ids };
    this.save();

    writeJson(path.join(this.p.briefs, `${day}--${slug(kind)}.json`), {
      kind, date: this.ledger.current.date, day, received_at: iso, items: snap,
    });
    const byLane = {};
    for (const s of snap) byLane[s.lane] = (byLane[s.lane] || 0) + 1;
    this.log({ at: iso, type: 'brief', kind, count: snap.length, lanes: byLane });
    return this.view(now);
  }

  // ---- user actions -------------------------------------------------------

  trail(rec, action, prev, extra, at) {
    rec.trail.push(Object.assign({ at: at || new Date().toISOString(), action, prev }, extra || {}));
    if (rec.trail.length > TRAIL_MAX) rec.trail.splice(0, rec.trail.length - TRAIL_MAX);
  }

  act(body, nowArg) {
    const action = String(body.action || '');
    const id = String(body.item_id || '');
    if (!ACTIONS.includes(action) || !id) return null;
    const now = nowArg ? new Date(nowArg) : new Date();
    let rec = this.ledger.items[id];
    if (!rec) {
      if (action !== 'dismiss') return null;
      rec = this.ledger.items[id] = this.newRecord({ id, title: body.title || id, lane: body.lane }, now.toISOString());
    }
    const prev = {
      status: rec.status, snooze_until: rec.snooze_until, note: rec.note,
      pinned: rec.pinned, updated: rec.updated, acted_at: rec.acted_at,
    };
    const note = str(body.note, 2000).trim();
    if (note) rec.note = note;
    if (action === 'do' || action === 'note') rec.status = 'done';
    if (action === 'dismiss') rec.status = 'dismissed';
    if (action === 'later') {
      rec.status = 'later';
      rec.snooze_until = snoozeUntil(body.until || 'tomorrow', now);
    } else {
      rec.snooze_until = null;
    }
    rec.acted_at = now.toISOString();
    rec.updated = false;
    rec.pinned = false;
    this.trail(rec, action, prev, rec.snooze_until ? { until: rec.snooze_until } : null, rec.acted_at);
    this.save();
    this.log({
      at: rec.acted_at, type: 'action', action, id, lane: rec.lane, from: prev.status,
      until: rec.snooze_until || undefined, first_seen: rec.first_seen,
    });
    return rec;
  }

  undo(id) {
    const rec = this.ledger.items[id];
    if (!rec) return null;
    const last = [...rec.trail].reverse().find((t) => ACTIONS.includes(t.action) && !t.undone);
    if (!last || !last.prev) return null;
    last.undone = true;
    Object.assign(rec, last.prev);
    if (rec.status === 'open' && !this.ledger.current.ids.includes(id)) rec.pinned = true;
    this.trail(rec, 'undo', null, { reverted: last.action });
    this.save();
    this.log({ type: 'action', action: 'undo', id, lane: rec.lane, reverted: last.action });
    return { rec, reverted: last.action };
  }

  reopen(id) {
    const rec = this.ledger.items[id];
    if (!rec || rec.status === 'open') return null;
    const prev = { status: rec.status, snooze_until: rec.snooze_until, acted_at: rec.acted_at };
    rec.status = 'open';
    rec.snooze_until = null;
    rec.pinned = !this.ledger.current.ids.includes(id);
    this.trail(rec, 'reopen', prev);
    this.save();
    this.log({ type: 'action', action: 'reopen', id, lane: rec.lane, from: prev.status });
    return rec;
  }

  // ---- views --------------------------------------------------------------

  public(rec, now) {
    const due = rec.status === 'later' && rec.snooze_until && Date.parse(rec.snooze_until) <= now;
    return {
      id: rec.id, title: rec.title, body: rec.body, lane: rec.lane, image: rec.image, url: rec.url,
      note: rec.note, status: due ? 'open' : rec.status,
      first_seen: rec.first_seen, last_seen: rec.last_seen, days_seen: rec.seen.length,
      acted_at: rec.acted_at, snooze_until: rec.snooze_until,
      resurfaced: !!due, updated: !!rec.updated, pinned: !!rec.pinned,
      trail: rec.trail.slice(-8).map((t) => ({ at: t.at, action: t.action, until: t.until, reverted: t.reverted })),
    };
  }

  view(nowArg) {
    const now = nowArg ? +new Date(nowArg) : Date.now();
    const cur = this.ledger.current;
    const inCur = new Set(cur.ids);
    const items = [];
    const seen = new Set();
    const include = (rec) => {
      if (!rec || seen.has(rec.id)) return;
      const due = rec.status === 'later' && rec.snooze_until && Date.parse(rec.snooze_until) <= now;
      if ((rec.status === 'open' && (inCur.has(rec.id) || rec.pinned)) || due) {
        seen.add(rec.id);
        items.push(this.public(rec, now));
      }
    };
    for (const id of cur.ids) include(this.ledger.items[id]);
    const rest = Object.values(this.ledger.items)
      .filter((r) => !seen.has(r.id))
      .sort((a, b) => String(a.snooze_until || a.acted_at).localeCompare(String(b.snooze_until || b.acted_at)));
    for (const r of rest) include(r);

    const upcoming = Object.values(this.ledger.items)
      .filter((r) => r.status === 'later' && (!r.snooze_until || Date.parse(r.snooze_until) > now))
      .sort((a, b) => String(a.snooze_until || '9999').localeCompare(String(b.snooze_until || '9999')))
      .map((r) => this.public(r, now));

    let cleared = 0;
    for (const id of cur.ids) {
      const r = this.ledger.items[id];
      if (r && r.status !== 'open' && !(r.status === 'later' && r.snooze_until && Date.parse(r.snooze_until) <= now)) cleared++;
    }
    const extra = items.filter((i) => !inCur.has(i.id)).length;
    return {
      kind: cur.kind, date: cur.date, day: cur.day, updated_at: cur.updated_at,
      items, upcoming,
      progress: { total: cur.ids.length + extra, cleared, open: items.length },
    };
  }

  history() {
    const all = Object.values(this.ledger.items);
    const by = (s) => all.filter((r) => r.status === s);
    const now = Date.now();
    return {
      later: by('later').sort((a, b) => String(a.snooze_until || '9999').localeCompare(String(b.snooze_until || '9999'))).map((r) => this.public(r, now)),
      done: by('done').sort((a, b) => String(b.acted_at).localeCompare(String(a.acted_at))).map((r) => this.public(r, now)),
      dismissed: by('dismissed').sort((a, b) => String(b.acted_at).localeCompare(String(a.acted_at)))
        .map((r) => ({ id: r.id, title: r.title, at: r.acted_at, item: this.public(r, now) })),
    };
  }

  search(q, status) {
    const needle = String(q || '').toLowerCase().trim();
    const now = Date.now();
    return Object.values(this.ledger.items)
      .filter((r) => !status || r.status === status)
      .filter((r) => !needle || (r.title + ' ' + r.body + ' ' + r.note).toLowerCase().includes(needle))
      .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)))
      .slice(0, 200)
      .map((r) => this.public(r, now));
  }

  // ---- archive ------------------------------------------------------------

  snapshots() {
    let files = [];
    try { files = fs.readdirSync(this.p.briefs).filter((f) => f.endsWith('.json')); } catch (_) {}
    return files.map((f) => readJson(path.join(this.p.briefs, f), null)).filter(Boolean)
      .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));
  }

  outcome(id) {
    const r = this.ledger.items[id];
    return r ? { status: r.status, acted_at: r.acted_at, snooze_until: r.snooze_until, note: r.note } : { status: 'open' };
  }

  briefs() {
    return this.snapshots().map((s) => {
      const lanes = {};
      const outcomes = { open: 0, done: 0, later: 0, dismissed: 0 };
      for (const it of s.items) {
        lanes[it.lane] = (lanes[it.lane] || 0) + 1;
        outcomes[this.outcome(it.id).status]++;
      }
      return { day: s.day, kind: s.kind, date: s.date, received_at: s.received_at, count: s.items.length, lanes, outcomes };
    });
  }

  brief(day, kind) {
    const s = this.snapshots().find((x) => x.day === day && (!kind || slug(x.kind) === slug(kind)));
    if (!s) return null;
    return Object.assign({}, s, { items: s.items.map((it) => Object.assign({}, it, this.outcome(it.id))) });
  }

  // ---- overview -----------------------------------------------------------

  stats(nowArg) {
    const now = nowArg ? new Date(nowArg) : new Date();
    const days = lastNDays(30, now);
    const heatDays = lastNDays(7 * 15, now);
    const events = this.readEvents();
    const snaps = this.snapshots();
    // Undone actions don't count: each undo cancels that item's latest action.
    const actions = [];
    const stack = new Map();
    for (const e of events) {
      if (e.type !== 'action') continue;
      if (ACTIONS.includes(e.action)) {
        actions.push(e);
        if (!stack.has(e.id)) stack.set(e.id, []);
        stack.get(e.id).push(e);
      } else if (e.action === 'undo' && stack.has(e.id)) {
        const last = stack.get(e.id).pop();
        if (last) last.undone = true;
      }
    }
    for (let i = actions.length - 1; i >= 0; i--) if (actions[i].undone) actions.splice(i, 1);

    const received = Object.fromEntries(days.map((d) => [d, { 'need-you': 0, 'worth-knowing': 0, quiet: 0 }]));
    const seenDay = new Set();
    for (const s of snaps) {
      // Count each item once per day, even if the brief was posted twice.
      for (const it of s.items) {
        const k = s.day + '|' + it.id;
        if (!received[s.day] || seenDay.has(k)) continue;
        seenDay.add(k);
        received[s.day][it.lane]++;
      }
    }

    const handled = Object.fromEntries(days.map((d) => [d, { do: 0, later: 0, dismiss: 0 }]));
    const heat = Object.fromEntries(heatDays.map((d) => [d, 0]));
    const latencies = [];
    const firstAct = new Map();
    const since = Date.parse(days[0]);
    for (const e of actions) {
      const d = dayKey(e.at);
      const k = e.action === 'note' ? 'do' : e.action;
      if (handled[d]) handled[d][k]++;
      if (d in heat) heat[d]++;
      if (!firstAct.has(e.id)) firstAct.set(e.id, e.at);
      if (e.first_seen && Date.parse(e.at) >= since && e.from === 'open') {
        latencies.push((Date.parse(e.at) - Date.parse(e.first_seen)) / 3600_000);
      }
    }
    latencies.sort((a, b) => a - b);
    const q = (p) => {
      if (!latencies.length) return null;
      const i = p * (latencies.length - 1);
      const lo = Math.floor(i);
      return latencies[lo] + (latencies[Math.ceil(i)] - latencies[lo]) * (i - lo);
    };

    // A brief day counts as cleared when every need-you item got its first
    // action that same day.
    const briefDays = [...new Set(snaps.map((s) => s.day))].sort();
    const clearedDay = {};
    for (const d of briefDays) {
      const need = new Set();
      for (const s of snaps) if (s.day === d) for (const it of s.items) if (it.lane === 'need-you') need.add(it.id);
      clearedDay[d] = [...need].every((id) => firstAct.has(id) && dayKey(firstAct.get(id)) <= d);
    }
    let streak = 0;
    const today = dayKey(now);
    for (let i = briefDays.length - 1; i >= 0; i--) {
      const d = briefDays[i];
      if (clearedDay[d]) streak++;
      else if (d === today) continue; // today is still in play
      else break;
    }

    const view = this.view(now);
    const sum = (obj, f) => Object.values(obj).reduce((a, v) => a + f(v), 0);
    const totalIn = sum(received, (v) => v['need-you'] + v['worth-knowing'] + v.quiet);
    const totals = {
      received: totalIn,
      done: sum(handled, (v) => v.do),
      later: sum(handled, (v) => v.later),
      dismissed: sum(handled, (v) => v.dismiss),
    };
    const lp = localParts(now);
    const weekday = [0, 0, 0, 0, 0, 0, 0];
    for (const e of actions) weekday[new Date(dayKey(e.at) + 'T12:00:00Z').getUTCDay()]++;

    return {
      generated_at: now.toISOString(),
      today: { day: today, wd: lp.wd, open: view.items.length, need: view.items.filter((i) => i.lane === 'need-you').length, ...view.progress },
      totals,
      latency_h: { median: q(0.5), p75: q(0.75), n: latencies.length },
      streak,
      cleared_days: briefDays.filter((d) => clearedDay[d]).length,
      brief_days: briefDays.length,
      series: days.map((d) => ({ day: d, received: received[d], handled: handled[d] })),
      heat: heatDays.map((d) => ({ day: d, n: heat[d] })),
      weekday,
      lingering: view.items.filter((i) => i.days_seen > 1).sort((a, b) => b.days_seen - a.days_seen).slice(0, 6),
      queue: view.upcoming.length,
    };
  }
}

module.exports = { Store, readJson, writeJson, LANES, ACTIONS };
