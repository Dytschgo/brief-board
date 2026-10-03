'use strict';

// Fills a data directory with ~6 weeks of plausible briefs and triage so the
// overview and archive have something to show.
//   node scripts/seed-demo.js [dir]   (default: ./data-demo)
// Then: BRIEF_DATA=./data-demo node server.js

const fs = require('fs');
const path = require('path');
const { Store } = require('../lib/store');
const { zoned, localParts } = require('../lib/time');

const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data-demo'));
fs.rmSync(dir, { recursive: true, force: true });
const store = new Store(dir);

const POOL = [
  ['ci-deploy-token', 'need-you', 'Rotate the CI deploy token', 'The deploy token for the example-web repo expires Friday. Two workflows will fail on the next push.', '/assets/key.svg'],
  ['prs-waiting', 'need-you', 'Two pull requests waiting on review', 'api #41 (retry logic) and web #12 (cache headers). Both green, both small.', '/assets/github.svg'],
  ['studio-booking', 'need-you', 'Confirm the studio room booking', 'Saturday 14:00–18:00 is held but not confirmed. They release it tomorrow at noon.', '/assets/calendar.svg'],
  ['insurer-form', 'need-you', 'The insurer wants the signed form back', 'The sample claim is paused until the declaration is signed and returned.', '/assets/mail.svg'],
  ['chat-drafts', 'need-you', 'Three chat replies drafted', 'Replies to Alex, Sam and the project group are ready to send or edit.', '/assets/chat.svg'],
  ['dinner-rsvp', 'need-you', 'RSVP for Saturday dinner', 'A table is held downtown. They asked for numbers by Wednesday.', '/assets/calendar.svg'],
  ['invoice-september', 'need-you', 'Send the September invoice', '42 hours logged. The draft is ready and needs a final check.', '/assets/mail.svg'],
  ['dns-example', 'need-you', 'example.com DNS still points at the old host', 'TLS renews in 6 days and will fail on the old IP.', '/assets/rocket.svg'],
  ['plan-upgrade', 'worth-knowing', 'The cloud plan now includes 3 more devices', 'Same price. Nothing to do unless you want the access editor.', '/assets/rocket.svg'],
  ['train-seats', 'worth-knowing', 'Friday train: seats are open again', 'The morning departure has window seats back at the normal fare.', '/assets/calendar.svg'],
  ['overnight-jobs', 'worth-knowing', 'Overnight jobs finished 4 tasks', 'api: auth refactor merged. web: 3 layout presets ready for review.', '/assets/code.svg'],
  ['guest-saturday', 'worth-knowing', 'An extra guest is joining Saturday', 'Mentioned in the group chat. Might matter for the table count.', '/assets/chat.svg'],
  ['usage-dip', 'worth-knowing', 'API usage dipped 18% this week', 'Mostly the Sunday outage. Weekday load is flat.', '/assets/rocket.svg'],
  ['chapter-comments', 'worth-knowing', 'Reviewer left comments on chapter 3', 'Eleven comments, mostly wording. One question about the sample size.', '/assets/mail.svg'],
  ['nightly-green', 'worth-knowing', 'Nightly build is green again', 'The flaky end-to-end test was quarantined. Coverage unchanged.', '/assets/code.svg'],
  ['timetable', 'quiet', 'Train timetable change on the 14th', '', '/assets/quiet.svg'],
  ['news-weather', 'quiet', 'Rain from Thursday afternoon', '', '/assets/quiet.svg'],
  ['newsletter-1', 'quiet', '3 newsletters archived', '', '/assets/quiet.svg'],
  ['calendar-free', 'quiet', 'Friday afternoon is free', '', '/assets/quiet.svg'],
  ['backup-ok', 'quiet', 'Backups ran on all 3 machines', '', '/assets/quiet.svg'],
  ['spam-swept', 'quiet', '14 spam mails swept', '', '/assets/quiet.svg'],
];

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr, n) => [...arr].sort(() => rnd() - 0.5).slice(0, n);

const today = localParts(new Date());
const DAYS = 42;
let carried = [];

for (let i = DAYS; i >= 0; i--) {
  const base = new Date(Date.UTC(today.y, today.m - 1, today.d - i));
  const wd = base.getUTCDay();
  if (wd === 0) continue; // Major takes Sundays off
  const [y, m, d] = [base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate()];
  const at = zoned(y, m, d, 6, 40 + Math.floor(rnd() * 15));

  const need = pick(POOL.filter((p) => p[1] === 'need-you'), 2 + Math.floor(rnd() * 3));
  const know = pick(POOL.filter((p) => p[1] === 'worth-knowing'), 1 + Math.floor(rnd() * 3));
  const quiet = pick(POOL.filter((p) => p[1] === 'quiet'), 2 + Math.floor(rnd() * 3));
  const ids = new Set();
  const items = [];
  for (const p of [...carried, ...need, ...know, ...quiet]) {
    // Day-suffix ids so each day reads as fresh work; carried items keep theirs.
    const id = carried.includes(p) ? p.id : p[0] + '-' + m + '-' + d;
    if (ids.has(id)) continue;
    ids.add(id);
    const src = carried.includes(p) ? p.src : p;
    items.push({ id, lane: src[1], title: src[2], body: src[3], image: src[4], _src: src });
  }
  const label = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(base);
  store.ingest({ kind: wd === 6 ? 'Weekend' : 'Morning', date: label, items }, at);

  if (i === 0) break; // leave today untouched for the live demo

  carried = [];
  let t = at.getTime() + (20 + rnd() * 90) * 60_000;
  const diligent = i <= 5 || rnd() < 0.72;
  // Snoozed items that came due get handled first.
  for (const it of store.view(t).items.filter((x) => !ids.has(x.id))) {
    t += (1 + rnd() * 10) * 60_000;
    store.act({ action: rnd() < 0.8 ? 'do' : 'dismiss', item_id: it.id }, t);
  }
  for (const it of items) {
    const r = rnd();
    t += (2 + rnd() * 40) * 60_000;
    if (it.lane === 'quiet') {
      if (r < 0.6) store.act({ action: 'dismiss', item_id: it.id }, t);
      continue;
    }
    if (it.lane === 'need-you' && !diligent && r < 0.35) {
      carried.push({ id: it.id, src: it._src });
      continue;
    }
    const action = it.lane === 'worth-knowing'
      ? (r < 0.55 ? 'dismiss' : r < 0.85 ? 'do' : 'later')
      : (r < 0.62 ? 'do' : r < 0.82 ? 'later' : r < 0.9 ? 'note' : 'dismiss');
    store.act({
      action, item_id: it.id,
      note: action === 'note' ? 'Go ahead, use the usual wording.' : '',
      until: ['tomorrow', 'tonight', 'week', 'monday'][Math.floor(rnd() * 4)],
    }, t);
  }
}

// Don't show a snoozed copy next to today's fresh version of the same task.
const view = store.view();
const fresh = new Set(view.items.filter((i) => !i.resurfaced).map((i) => i.title));
for (const it of view.items) {
  if (it.resurfaced && fresh.has(it.title)) store.act({ action: 'do', item_id: it.id }, Date.now() - 3600_000);
}

console.log('seeded', dir);
