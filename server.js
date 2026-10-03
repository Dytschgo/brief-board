'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, readJson, writeJson, ACTIONS } = require('./lib/store');
const { Outbox } = require('./lib/outbox');

const ROOT = __dirname;
const DATA = path.resolve(process.env.BRIEF_DATA || path.join(ROOT, 'data'));
const ASSETS = path.join(ROOT, 'assets');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.resolve(process.env.BRIEF_CONFIG || path.join(ROOT, 'config.json'));

fs.mkdirSync(DATA, { recursive: true });

function loadConfig() {
  let c = { url: '', key: '', port: 8787 };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    c = {
      url: typeof raw.url === 'string' ? raw.url : '',
      key: typeof raw.key === 'string' ? raw.key : '',
      port: Number(raw.port) || 8787,
    };
  } catch (_) {}
  if (!c.key && process.env.key) c.key = process.env.key;
  if (process.env.PORT) c.port = Number(process.env.PORT) || c.port;
  return c;
}

const store = new Store(DATA);
const outbox = new Outbox(DATA, loadConfig);

// ---- live updates (SSE) ---------------------------------------------------

const clients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
let lastSig = '';
function boardChanged() {
  const v = store.view();
  lastSig = v.items.map((i) => i.id).join(',') + '|' + v.updated_at;
  broadcast('board', { updated_at: v.updated_at, open: v.items.length });
  return v;
}
outbox.onChange = (s) => broadcast('sync', s);
// Snoozed items come due on their own; tell open tabs when that happens.
setInterval(() => {
  const v = store.view();
  const sig = v.items.map((i) => i.id).join(',') + '|' + v.updated_at;
  if (sig !== lastSig) boardChanged();
}, 60_000).unref();

// ---- http helpers ---------------------------------------------------------

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
};

function serveFile(res, dir, rel, cache) {
  if (!rel || rel.includes('..') || rel.includes('/') || rel.includes('\\')) return send(res, 400, { ok: false, error: 'bad_path' });
  const fp = path.join(dir, rel);
  if (!fp.startsWith(dir) || !fs.existsSync(fp)) return send(res, 404, { ok: false, error: 'not_found' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
    'Cache-Control': cache || 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
}

function webhookPayload(rec, action, extra) {
  return Object.assign({
    action, item_id: rec.id, lane: rec.lane, title: rec.title, note: action === 'note' || action === 'do' ? rec.note || '' : '',
  }, extra || {});
}

const SHELL_ROUTES = new Set(['/', '/index.html', '/history', '/history.html', '/overview', '/archive']);

// ---- routes ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const GET = req.method === 'GET';
    const POST = req.method === 'POST';

    if (GET && SHELL_ROUTES.has(p)) return serveFile(res, PUBLIC, 'index.html');
    if (GET && /^\/(app\.css|app\.js|charts\.js|glyphs\.js)$/.test(p)) return serveFile(res, PUBLIC, p.slice(1));
    if (GET && p.startsWith('/assets/')) return serveFile(res, ASSETS, p.slice(8), 'public, max-age=3600');

    if (GET && p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: sync\ndata: ${JSON.stringify(outbox.status())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (GET && p === '/api/board') return send(res, 200, store.view());
    if (GET && p === '/api/history') return send(res, 200, store.history());
    if (GET && p === '/api/dismissed') return send(res, 200, { dismissed: store.history().dismissed });
    if (GET && p === '/api/stats') return send(res, 200, store.stats());
    if (GET && p === '/api/briefs') return send(res, 200, { briefs: store.briefs() });
    if (GET && p.startsWith('/api/briefs/')) {
      const b = store.brief(decodeURIComponent(p.slice(12)), u.searchParams.get('kind'));
      return b ? send(res, 200, b) : send(res, 404, { ok: false, error: 'not_found' });
    }
    if (GET && p === '/api/search') {
      return send(res, 200, { items: store.search(u.searchParams.get('q'), u.searchParams.get('status')) });
    }
    if (GET && p === '/api/status') return send(res, 200, outbox.status());

    if (POST && p === '/api/board') {
      const body = await readBody(req, 1_000_000);
      if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return send(res, 400, { ok: false, error: 'bad_board' });
      store.ingest(body);
      return send(res, 200, { ok: true, board: boardChanged() });
    }

    if (POST && p === '/api/action') {
      const body = await readBody(req, 64_000);
      const action = String(body.action || '');
      if (action === 'probe') {
        const cfg = loadConfig();
        if (!cfg.url) return send(res, 200, { ok: true, webhook: false, reason: 'url_empty' });
        const r = await outbox.probe({ action: 'probe', item_id: '', lane: '', title: '', note: '' });
        return send(res, 200, { ok: true, webhook: !!r.ok, reason: r.reason });
      }
      if (!ACTIONS.includes(action)) return send(res, 400, { ok: false, error: 'unknown_action' });
      const rec = store.act(body);
      if (!rec) return send(res, 404, { ok: false, error: 'not_found' });
      const webhook = outbox.enqueue(webhookPayload(rec, action, rec.snooze_until ? { until: rec.snooze_until } : null));
      return send(res, 200, { ok: true, webhook, item: store.public(rec, Date.now()), board: boardChanged() });
    }

    if (POST && p === '/api/bulk') {
      const body = await readBody(req, 256_000);
      const action = String(body.action || '');
      const ids = Array.isArray(body.item_ids) ? body.item_ids.map(String).slice(0, 200) : [];
      if (!ACTIONS.includes(action) || !ids.length) return send(res, 400, { ok: false, error: 'bad_bulk' });
      const done = [];
      for (const id of ids) {
        const rec = store.act({ action, item_id: id, until: body.until });
        if (!rec) continue;
        done.push(id);
        outbox.enqueue(webhookPayload(rec, action, rec.snooze_until ? { until: rec.snooze_until } : null));
      }
      return send(res, 200, { ok: true, item_ids: done, board: boardChanged() });
    }

    if (POST && p === '/api/undo') {
      const body = await readBody(req, 64_000);
      const r = store.undo(String(body.item_id || ''));
      if (!r) return send(res, 404, { ok: false, error: 'nothing_to_undo' });
      outbox.enqueue(webhookPayload(r.rec, 'undo', { reverted: r.reverted }));
      return send(res, 200, { ok: true, reverted: r.reverted, board: boardChanged() });
    }

    if (POST && p === '/api/reopen') {
      const body = await readBody(req, 64_000);
      const id = String(body.item_id || '');
      if (!id) return send(res, 400, { ok: false, error: 'item_id_required' });
      const rec = store.reopen(id);
      if (!rec) return send(res, 404, { ok: false, error: 'not_found' });
      return send(res, 200, { ok: true, board: boardChanged() });
    }

    if (POST && p === '/api/outbox/retry') {
      await outbox.retryNow();
      return send(res, 200, Object.assign({ ok: true }, outbox.status()));
    }

    send(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    const msg = err && (err.message === 'bad_json' || err.message === 'too_large') ? err.message : 'error';
    if (!res.headersSent) send(res, 400, { ok: false, error: msg });
  }
});

function listen(port) {
  server.listen(port, '0.0.0.0', () => {
    const disk = readJson(CONFIG_PATH, null);
    if (disk && Number(disk.port) !== port && !process.env.PORT) {
      writeJson(CONFIG_PATH, { url: disk.url || '', key: disk.key || '', port });
    }
    fs.writeFileSync(path.join(ROOT, 'server.pid'), String(process.pid) + '\n');
    process.stdout.write('listening ' + port + '\n');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      server.removeAllListeners('error');
      listen(port + 1);
      return;
    }
    process.stderr.write('listen_error\n');
    process.exit(1);
  });
}

outbox.start();
listen(loadConfig().port || 8787);
