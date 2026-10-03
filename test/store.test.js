'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brief-'));
}

const T0 = Date.parse('2026-10-01T05:00:00Z'); // Thu 07:00 Zurich
const H = 3600_000;

const brief = (items) => ({
  kind: 'Morning',
  date: 'Thursday 1 October',
  items: items.map(([id, lane, body]) => ({ id, lane, title: 'T ' + id, body: body || '' })),
});

test('ingest shows open items in order and counts progress', () => {
  const s = new Store(tmp());
  const v = s.ingest(brief([['a', 'need-you'], ['b', 'worth-knowing'], ['c', 'quiet']]), T0);
  assert.deepStrictEqual(v.items.map((i) => i.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(v.progress, { total: 3, cleared: 0, open: 3 });
  s.act({ action: 'do', item_id: 'a' }, T0 + H);
  const v2 = s.view(T0 + H);
  assert.deepStrictEqual(v2.items.map((i) => i.id), ['b', 'c']);
  assert.strictEqual(v2.progress.cleared, 1);
});

test('later snoozes until the preset time, then resurfaces on its own', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you']]), T0);
  const rec = s.act({ action: 'later', item_id: 'a', until: 'tomorrow' }, T0);
  assert.strictEqual(rec.snooze_until, '2026-10-02T06:00:00.000Z'); // Fri 08:00 Zurich
  assert.strictEqual(s.view(T0 + H).items.length, 0);
  assert.strictEqual(s.view(T0 + H).upcoming[0].id, 'a');
  // Next day the producer sends a brief without it: it still comes back.
  s.ingest(brief([['b', 'need-you']]), Date.parse('2026-10-02T05:00:00Z'));
  const v = s.view(Date.parse('2026-10-02T06:30:00Z'));
  assert.deepStrictEqual(v.items.map((i) => i.id), ['b', 'a']);
  assert.ok(v.items[1].resurfaced);
});

test('someday snoozes never resurface', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you']]), T0);
  s.act({ action: 'later', item_id: 'a', until: 'someday' }, T0);
  assert.strictEqual(s.view(T0 + 400 * 24 * H).items.length, 0);
});

test('done items stay hidden when re-sent unchanged, return when content changes', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you', 'v1']]), T0);
  s.act({ action: 'do', item_id: 'a' }, T0 + H);
  let v = s.ingest(brief([['a', 'need-you', 'v1']]), T0 + 24 * H);
  assert.strictEqual(v.items.length, 0);
  assert.strictEqual(v.progress.cleared, 1);
  v = s.ingest(brief([['a', 'need-you', 'v2']]), T0 + 48 * H);
  assert.strictEqual(v.items.length, 1);
  assert.ok(v.items[0].updated);
  assert.strictEqual(v.items[0].days_seen, 3);
});

test('dismissed items stay buried even if the content changes', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you', 'v1']]), T0);
  s.act({ action: 'dismiss', item_id: 'a' }, T0);
  assert.strictEqual(s.ingest(brief([['a', 'need-you', 'v2']]), T0 + 24 * H).items.length, 0);
});

test('undo restores the previous state exactly once', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you']]), T0);
  s.act({ action: 'later', item_id: 'a', until: 'week' }, T0);
  const r = s.undo('a');
  assert.strictEqual(r.reverted, 'later');
  assert.strictEqual(s.ledger.items.a.status, 'open');
  assert.strictEqual(s.ledger.items.a.snooze_until, null);
  assert.strictEqual(s.undo('a'), null);
});

test('reopened items stay on the board after the next brief replaces it', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you']]), T0);
  s.act({ action: 'do', item_id: 'a' }, T0);
  s.ingest(brief([['b', 'need-you']]), T0 + 24 * H);
  s.reopen('a');
  const v = s.view(T0 + 25 * H);
  assert.deepStrictEqual(v.items.map((i) => i.id).sort(), ['a', 'b']);
  assert.ok(v.items.find((i) => i.id === 'a').pinned);
});

test('archive keeps each day and reports outcomes', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you'], ['b', 'quiet']]), T0);
  s.act({ action: 'do', item_id: 'a' }, T0 + H);
  s.ingest(brief([['c', 'need-you']]), T0 + 24 * H);
  const list = s.briefs();
  assert.deepStrictEqual(list.map((b) => b.day), ['2026-10-02', '2026-10-01']);
  assert.deepStrictEqual(list[1].outcomes, { open: 1, done: 1, later: 0, dismissed: 0 });
  const day = s.brief('2026-10-01');
  assert.strictEqual(day.items.find((i) => i.id === 'a').status, 'done');
});

test('stats: streak, latency and per-day series', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you'], ['q', 'quiet']]), T0);
  s.act({ action: 'do', item_id: 'a' }, T0 + 2 * H);
  s.ingest(brief([['b', 'need-you']]), T0 + 24 * H);
  s.act({ action: 'dismiss', item_id: 'b' }, T0 + 25 * H);
  const st = s.stats(T0 + 26 * H);
  assert.strictEqual(st.streak, 2);
  assert.strictEqual(st.latency_h.median, 1.5);
  assert.deepStrictEqual(st.series.at(-1).handled, { do: 0, later: 0, dismiss: 1 });
  assert.deepStrictEqual(st.series.at(-2).received, { 'need-you': 1, 'worth-knowing': 0, quiet: 1 });
});

test('stats ignore undone actions', () => {
  const s = new Store(tmp());
  s.ingest(brief([['a', 'need-you']]), T0);
  s.act({ action: 'do', item_id: 'a' }, T0 + H);
  s.undo('a');
  const st = s.stats(T0 + 2 * H);
  assert.strictEqual(st.totals.done, 0);
  assert.strictEqual(st.latency_h.n, 0);
});

test('v1 data migrates into the ledger', () => {
  const dir = tmp();
  const w = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
  w('board.json', { kind: 'Morning', date: 'x', updated_at: new Date(T0).toISOString(), items: [{ id: 'open1', lane: 'need-you', title: 'O' }] });
  w('history.json', { later: [{ id: 'l1', title: 'L', acted_at: new Date(T0).toISOString() }], done: [{ id: 'd1', title: 'D' }] });
  w('dismissed.json', { dismissed: [{ id: 'x1', title: 'X', at: new Date(T0).toISOString(), item: { id: 'x1', title: 'X', lane: 'quiet' } }] });
  const s = new Store(dir);
  const st = (id) => s.ledger.items[id].status;
  assert.deepStrictEqual([st('open1'), st('l1'), st('d1'), st('x1')], ['open', 'later', 'done', 'dismissed']);
  assert.deepStrictEqual(s.view(T0).items.map((i) => i.id), ['open1']);
  assert.ok(fs.existsSync(path.join(dir, 'ledger.json')));
});
