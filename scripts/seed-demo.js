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
  ['github-workflow-token', 'need-you', 'Rotate the GitHub workflow token', 'The deploy token for credra-platform expires Friday. Two workflows will fail on the next push.', '/assets/key.svg'],
  ['prs-ufpump-ainexus', 'need-you', 'Two PRs waiting on your review', 'ufpump #41 (sensor retry) and ainexus #12 (prompt cache). Both green, both small.', '/assets/github.svg'],
  ['gremaud-belegung', 'need-you', 'Confirm the Gremaud room booking', 'Saturday 14:00–18:00 is held but not confirmed. They release it tomorrow at noon.', '/assets/calendar.svg'],
  ['allianz-duden', 'need-you', 'Allianz wants the signed form back', 'Claim 2291 is paused until the Duden declaration is signed and returned.', '/assets/mail.svg'],
  ['wa-drafts', 'need-you', 'Three WhatsApp replies drafted', 'Replies to Laura, Marlon and the Beizlifest group are ready to send or edit.', '/assets/chat.svg'],
  ['birthday-rsvp', 'need-you', 'RSVP for Nina’s birthday', 'Dinner on the 18th at Frau Gerolds. She asked for numbers by Wednesday.', '/assets/calendar.svg'],
  ['invoice-kova', 'need-you', 'Send the Kova September invoice', '42 hours logged. Draft is in Drive, needs the new IBAN.', '/assets/mail.svg'],
  ['dns-imnota', 'need-you', 'imnota.com DNS still points at the old host', 'TLS renews in 6 days and will fail on the old IP.', '/assets/rocket.svg'],
  ['tailscale-plan', 'worth-knowing', 'Tailscale moved you to the new plan', 'Same price, 3 more devices. Nothing to do unless you want the ACL editor.', '/assets/rocket.svg'],
  ['platz-milano', 'worth-knowing', 'Milano trip: seats are open again', 'The 07:33 EC has window seats in 1st class back at the normal fare.', '/assets/calendar.svg'],
  ['coding-credra-koma', 'worth-knowing', 'Overnight agents finished 4 tasks', 'credra: auth refactor merged. koma-motion: 3 easing presets ready for review.', '/assets/code.svg'],
  ['elias-girlfriend', 'worth-knowing', 'Elias is bringing Mara on Saturday', 'He mentioned it in the group chat. Might matter for the table count.', '/assets/chat.svg'],
  ['powerplant-alert', 'worth-knowing', 'Powerplant usage dipped 18% this week', 'Mostly the Sunday outage. Weekday load is flat.', '/assets/rocket.svg'],
  ['diplom-feedback', 'worth-knowing', 'Supervisor left comments on chapter 3', 'Eleven comments, mostly wording. One question about the sample size.', '/assets/mail.svg'],
  ['margana-build', 'worth-knowing', 'Margana nightly build is green again', 'The flaky e2e test was quarantined. Coverage unchanged.', '/assets/code.svg'],
  ['news-sbb', 'quiet', 'SBB timetable change on the 14th', '', '/assets/quiet.svg'],
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
