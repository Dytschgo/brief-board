'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson } = require('./store');

const MAX_ATTEMPTS = 12;
const TIMEOUT_MS = 8000;

/**
 * Webhook delivery runs off the request path: actions are saved locally and
 * answered instantly, then posted to Major in the background with retries.
 */
class Outbox {
  constructor(dir, getConfig) {
    this.file = path.join(dir, 'outbox.json');
    this.failFile = path.join(dir, 'failed-posts.jsonl');
    this.getConfig = getConfig;
    this.state = readJson(this.file, { queue: [], last_ok_at: null, last_error: null });
    if (!Array.isArray(this.state.queue)) this.state.queue = [];
    this.running = false;
    this.onChange = () => {};
  }

  save() {
    writeJson(this.file, this.state);
    this.onChange(this.status());
  }

  status() {
    const cfg = this.getConfig();
    return {
      configured: !!cfg.url,
      pending: this.state.queue.length,
      last_ok_at: this.state.last_ok_at,
      last_error: this.state.last_error,
    };
  }

  logFail(payload, reason) {
    const safe = {
      at: new Date().toISOString(),
      action: payload.action || '', item_id: payload.item_id || '', lane: payload.lane || '',
      title: payload.title || '', note: payload.note || '', reason,
    };
    fs.appendFileSync(this.failFile, JSON.stringify(safe) + '\n');
  }

  enqueue(payload) {
    if (!this.getConfig().url) {
      this.logFail(payload, 'url_empty');
      return 'off';
    }
    this.state.queue.push({
      key: crypto.randomUUID(), payload, attempts: 0, next_at: Date.now(), created_at: new Date().toISOString(),
    });
    this.save();
    setImmediate(() => this.flush());
    return 'queued';
  }

  retryNow() {
    for (const e of this.state.queue) e.next_at = Date.now();
    this.save();
    return this.flush();
  }

  async flush() {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = this.getConfig();
      const now = Date.now();
      for (const entry of [...this.state.queue]) {
        if (entry.next_at > now) continue;
        const r = await post(cfg, entry.payload);
        if (r.ok) {
          this.state.queue = this.state.queue.filter((e) => e.key !== entry.key);
          this.state.last_ok_at = new Date().toISOString();
          this.state.last_error = null;
        } else {
          entry.attempts++;
          entry.last_reason = r.reason;
          entry.next_at = Date.now() + Math.min(15_000 * 2 ** entry.attempts, 30 * 60_000);
          this.state.last_error = { at: new Date().toISOString(), reason: r.reason };
          if (entry.attempts >= MAX_ATTEMPTS) {
            this.logFail(entry.payload, r.reason);
            this.state.queue = this.state.queue.filter((e) => e.key !== entry.key);
          }
          // Endpoint is down; don't hammer it with the rest of the queue.
          if (r.reason === 'network' || r.reason === 'timeout') break;
        }
      }
      this.save();
    } finally {
      this.running = false;
    }
  }

  start(intervalMs) {
    this.timer = setInterval(() => this.flush(), intervalMs || 15_000);
    this.timer.unref();
    this.flush();
  }

  probe(payload) {
    return post(this.getConfig(), payload);
  }
}

function post(cfg, body) {
  return new Promise((resolve) => {
    if (!cfg.url) return resolve({ ok: false, reason: 'url_empty' });
    let u;
    try { u = new URL(cfg.url); } catch (_) { return resolve({ ok: false, reason: 'bad_url' }); }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const payload = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + cfg.key,
        'X-Automation-Key': cfg.key,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) done({ ok: true, status: res.statusCode });
        else done({ ok: false, reason: 'http_' + res.statusCode });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timeout' }); });
    req.on('error', () => done({ ok: false, reason: 'network' }));
    req.end(payload);
  });
}

module.exports = { Outbox };
