'use strict';

// All day boundaries live in Zurich time, regardless of where the server runs.
const TZ = process.env.BRIEF_TZ || 'Europe/Zurich';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
});

function dayKey(d) {
  return dayFmt.format(d instanceof Date ? d : new Date(d || Date.now()));
}

function localParts(d) {
  const out = {};
  for (const p of partsFmt.formatToParts(d)) out[p.type] = p.value;
  return {
    y: +out.year, m: +out.month, d: +out.day,
    h: +out.hour, min: +out.minute, s: +out.second,
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

// Offset (ms) between local wall time and UTC at instant t.
function offsetAt(t) {
  const p = localParts(new Date(t));
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000;
}

// Wall-clock time in TZ -> Date. Two passes handle DST edges.
function zoned(y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h || 0, min || 0);
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return new Date(t);
}

function addDays(y, m, d, n) {
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()];
}

// Named snooze presets resolve to the next matching wall-clock moment.
function snoozeUntil(preset, now) {
  const at = now ? new Date(now) : new Date();
  if (preset && !Number.isNaN(Date.parse(preset)) && /\d{4}-\d{2}-\d{2}/.test(preset)) {
    return new Date(preset).toISOString();
  }
  const p = localParts(at);
  let target;
  switch (preset) {
    case 'hour':
      target = new Date(at.getTime() + 3600_000);
      break;
    case 'tonight': {
      target = zoned(p.y, p.m, p.d, 18, 0);
      if (target <= at) target = zoned(...addDays(p.y, p.m, p.d, 1), 18, 0);
      break;
    }
    case 'monday': {
      const ahead = ((8 - p.wd) % 7) || 7;
      target = zoned(...addDays(p.y, p.m, p.d, ahead), 8, 0);
      break;
    }
    case 'week':
      target = zoned(...addDays(p.y, p.m, p.d, 7), 8, 0);
      break;
    case 'someday':
      return null;
    case 'tomorrow':
    default:
      target = zoned(...addDays(p.y, p.m, p.d, 1), 8, 0);
  }
  return target.toISOString();
}

function lastNDays(n, now) {
  const p = localParts(now ? new Date(now) : new Date());
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const [y, m, d] = addDays(p.y, p.m, p.d, -i);
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return out;
}

module.exports = { TZ, dayKey, localParts, zoned, snoozeUntil, lastNDays };
