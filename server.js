'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const ASSETS = path.join(ROOT, 'assets');
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const BOARD_PATH = path.join(DATA, 'board.json');
const DISMISSED_PATH = path.join(DATA, 'dismissed.json');
const HISTORY_PATH = path.join(DATA, 'history.json');
const FAIL_PATH = path.join(DATA, 'failed-posts.jsonl');

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
  return c;
}

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

function loadDismissed() {
  const d = readJson(DISMISSED_PATH, { dismissed: [] });
  if (!Array.isArray(d.dismissed)) d.dismissed = [];
  return d;
}

function dismissedIdSet() {
  return new Set(loadDismissed().dismissed.map((x) => x && x.id).filter(Boolean));
}

function loadHistory() {
  const h = readJson(HISTORY_PATH, { later: [], done: [] });
  if (!Array.isArray(h.later)) h.later = [];
  if (!Array.isArray(h.done)) h.done = [];
  return h;
}

function emptyBoard() {
  return { kind: 'Morning', date: '', updated_at: '', items: [] };
}

function readBoardRaw() {
  const board = readJson(BOARD_PATH, emptyBoard());
  if (!Array.isArray(board.items)) board.items = [];
  return board;
}

function visibleItems(items) {
  const ids = dismissedIdSet();
  return (items || []).filter((it) => {
    if (!it || !it.id || ids.has(it.id)) return false;
    if (it.status === 'later' || it.status === 'done') return false;
    return true;
  });
}

function loadBoard() {
  const board = readBoardRaw();
  return Object.assign({}, board, { items: visibleItems(board.items) });
}

function persistBoard(board) {
  const next = Object.assign({}, board, {
    items: visibleItems(board.items),
    updated_at: new Date().toISOString(),
  });
  writeJson(BOARD_PATH, next);
  return next;
}

function saveBoard(board) {
  const hist = loadHistory();
  const ids = dismissedIdSet();
  const open = [];
  for (const it of board.items || []) {
    if (!it || !it.id || ids.has(it.id)) continue;
    if (it.status === 'later') {
      hist.done = hist.done.filter((x) => x.id !== it.id);
      const i = hist.later.findIndex((x) => x.id === it.id);
      if (i >= 0) hist.later[i] = it;
      else hist.later.push(it);
    } else if (it.status === 'done') {
      hist.later = hist.later.filter((x) => x.id !== it.id);
      const i = hist.done.findIndex((x) => x.id === it.id);
      if (i >= 0) hist.done[i] = it;
      else hist.done.push(it);
    } else {
      open.push(it);
    }
  }
  writeJson(HISTORY_PATH, hist);
  return persistBoard(Object.assign({}, board, { items: open }));
}

function migrate() {
  const raw = readBoardRaw();
  const hist = loadHistory();
  let moved = false;
  const open = [];
  for (const it of raw.items) {
    if (!it || !it.id) continue;
    if (it.status === 'later' || it.status === 'done') {
      const bucket = it.status === 'later' ? 'later' : 'done';
      const other = bucket === 'later' ? 'done' : 'later';
      hist[other] = hist[other].filter((x) => x.id !== it.id);
      const i = hist[bucket].findIndex((x) => x.id === it.id);
      const copy = Object.assign({}, it, { acted_at: it.acted_at || new Date().toISOString() });
      if (i >= 0) hist[bucket][i] = copy;
      else hist[bucket].push(copy);
      moved = true;
    } else {
      open.push(it);
    }
  }
  if (moved) {
    writeJson(HISTORY_PATH, hist);
    writeJson(BOARD_PATH, Object.assign({}, raw, {
      items: visibleItems(open),
      updated_at: new Date().toISOString(),
    }));
  } else if (!fs.existsSync(HISTORY_PATH)) {
    writeJson(HISTORY_PATH, hist);
  }
}

function logFail(entry) {
  const safe = {
    at: new Date().toISOString(),
    action: entry.action || '',
    item_id: entry.item_id || '',
    lane: entry.lane || '',
    title: entry.title || '',
    note: entry.note || '',
    reason: entry.reason || 'unknown',
  };
  fs.appendFileSync(FAIL_PATH, JSON.stringify(safe) + '\n');
}

function postWebhook(cfg, bodyObj) {
  return new Promise((resolve) => {
    if (!cfg.url) {
      resolve({ ok: false, reason: 'url_empty' });
      return;
    }
    try {
      new URL(cfg.url);
    } catch (_) {
      resolve({ ok: false, reason: 'bad_url' });
      return;
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const req = httpRequest(cfg.url, bodyObj, cfg.key, done);
    const timer = setTimeout(() => {
      try { req.destroy(); } catch (_) {}
      done({ ok: false, reason: 'timeout' });
    }, 8000);
    req.on('close', () => clearTimeout(timer));
  });
}

function httpRequest(urlStr, bodyObj, key, done) {
  const u = new URL(urlStr);
  const payload = Buffer.from(JSON.stringify(bodyObj));
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  const req = lib.request(
    {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: 'Bearer ' + key,
        'X-Automation-Key': key,
      },
      timeout: 8000,
    },
    (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) done({ ok: true, status: res.statusCode });
        else done({ ok: false, reason: 'http_' + res.statusCode });
      });
    }
  );
  req.on('timeout', () => {
    req.destroy();
    done({ ok: false, reason: 'timeout' });
  });
  req.on('error', () => done({ ok: false, reason: 'network' }));
  req.end(payload);
  return req;
}

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

function send(res, code, obj, extraHeaders) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const headers = Object.assign(
    {
      'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    extraHeaders || {}
  );
  res.writeHead(code, headers);
  res.end(body);
}

function mime(p) {
  if (p.endsWith('.svg')) return 'image/svg+xml';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function findItem(board, hist, itemId) {
  const pools = [board.items, hist.later, hist.done];
  for (const list of pools) {
    const found = (list || []).find((x) => x && x.id === itemId);
    if (found) return Object.assign({}, found);
  }
  return null;
}

function stripEverywhere(board, hist, itemId) {
  board.items = (board.items || []).filter((x) => x && x.id !== itemId);
  hist.later = hist.later.filter((x) => x && x.id !== itemId);
  hist.done = hist.done.filter((x) => x && x.id !== itemId);
}

function applyAction(body) {
  const action = String(body.action || '');
  const itemId = String(body.item_id || '');
  const board = readBoardRaw();
  const hist = loadHistory();

  if (action === 'dismiss') {
    if (itemId) {
      const item = findItem(board, hist, itemId);
      stripEverywhere(board, hist, itemId);
      const d = loadDismissed();
      if (!d.dismissed.some((x) => x.id === itemId)) {
        const title = (item && item.title) || body.title || itemId;
        const snap = item || {
          id: itemId,
          title: String(title),
          body: '',
          lane: String(body.lane || 'need-you'),
          status: 'open',
          note: String(body.note || ''),
          image: '/assets/quiet.svg',
        };
        d.dismissed.push({
          id: itemId,
          title: String(title),
          at: new Date().toISOString(),
          item: snap,
        });
        writeJson(DISMISSED_PATH, d);
      }
      writeJson(HISTORY_PATH, hist);
    }
    return persistBoard(board);
  }

  if ((action === 'later' || action === 'do' || action === 'note') && itemId) {
    const item = findItem(board, hist, itemId);
    if (item) {
      stripEverywhere(board, hist, itemId);
      if (action === 'note') item.note = typeof body.note === 'string' ? body.note : '';
      else if (typeof body.note === 'string' && body.note) item.note = body.note;
      item.acted_at = new Date().toISOString();
      if (action === 'later') {
        item.status = 'later';
        hist.later.push(item);
      } else {
        item.status = 'done';
        hist.done.push(item);
      }
      writeJson(HISTORY_PATH, hist);
    }
    return persistBoard(board);
  }

  return loadBoard();
}

function reopenItem(itemId, from) {
  const board = readBoardRaw();
  const hist = loadHistory();
  let item = null;

  if (from === 'later' || from === 'done') {
    const list = from === 'later' ? hist.later : hist.done;
    item = list.find((x) => x && x.id === itemId) || null;
    if (!item) return { ok: false, error: 'not_found' };
    stripEverywhere(board, hist, itemId);
    writeJson(HISTORY_PATH, hist);
  } else {
    const d = loadDismissed();
    const rec = d.dismissed.find((x) => x && x.id === itemId);
    if (!rec) return { ok: false, error: 'not_found' };
    d.dismissed = d.dismissed.filter((x) => x.id !== itemId);
    writeJson(DISMISSED_PATH, d);
    item = rec.item && typeof rec.item === 'object'
      ? Object.assign({}, rec.item)
      : {
          id: itemId,
          title: rec.title || itemId,
          body: '',
          lane: 'need-you',
          image: '/assets/quiet.svg',
          note: '',
        };
    stripEverywhere(board, hist, itemId);
    writeJson(HISTORY_PATH, hist);
  }

  item.status = 'open';
  item.id = itemId;
  if (!board.items.some((x) => x && x.id === itemId)) board.items.push(item);
  const saved = persistBoard(board);
  return { ok: true, board: saved };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = u.pathname;

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && (pathname === '/history' || pathname === '/overview' || pathname === '/history.html')) {
      const html = fs.readFileSync(path.join(PUBLIC, 'history.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && pathname === '/brief.css') {
      const css = fs.readFileSync(path.join(PUBLIC, 'brief.css'));
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(css);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      const rel = pathname.slice('/assets/'.length);
      if (rel.includes('..') || rel.includes('/') || rel.includes('\\')) {
        send(res, 400, { ok: false, error: 'bad_path' });
        return;
      }
      const fp = path.join(ASSETS, rel);
      if (!fp.startsWith(ASSETS) || !fs.existsSync(fp)) {
        send(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      res.writeHead(200, { 'Content-Type': mime(fp), 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(fp).pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/board') {
      send(res, 200, loadBoard());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/history') {
      const hist = loadHistory();
      send(res, 200, {
        later: hist.later,
        done: hist.done,
        dismissed: loadDismissed().dismissed,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/dismissed') {
      send(res, 200, loadDismissed());
      return;
    }

    if (req.method === 'POST' && pathname === '/api/board') {
      const body = await readBody(req, 1_000_000);
      if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
        send(res, 400, { ok: false, error: 'bad_board' });
        return;
      }
      const saved = saveBoard(body);
      send(res, 200, { ok: true, board: saved });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/reopen') {
      const body = await readBody(req, 64_000);
      const itemId = String((body && body.item_id) || '');
      const from = String((body && (body.from || body.bucket)) || 'dismissed');
      if (!itemId) {
        send(res, 400, { ok: false, error: 'item_id_required' });
        return;
      }
      const result = reopenItem(itemId, from === 'later' || from === 'done' ? from : 'dismissed');
      send(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readBody(req, 64_000);
      const action = String((body && body.action) || '');
      const payload = {
        action,
        item_id: String((body && body.item_id) || ''),
        lane: String((body && body.lane) || ''),
        title: String((body && body.title) || ''),
        note: String((body && body.note) || ''),
      };

      if (action === 'probe') {
        const cfg = loadConfig();
        if (!cfg.url) {
          send(res, 200, { ok: true, webhook: false, reason: 'url_empty' });
          return;
        }
        const wh = await postWebhook(cfg, payload);
        if (!wh.ok) logFail(Object.assign({}, payload, { reason: wh.reason }));
        send(res, 200, { ok: true, webhook: !!wh.ok });
        return;
      }

      const known = action === 'dismiss' || action === 'do' || action === 'later' || action === 'note';
      let board = null;
      if (known) board = applyAction(payload);

      const cfg = loadConfig();
      let webhook = false;
      if (cfg.url) {
        const wh = await postWebhook(cfg, payload);
        webhook = !!wh.ok;
        if (!wh.ok) logFail(Object.assign({}, payload, { reason: wh.reason }));
      } else if (known) {
        logFail(Object.assign({}, payload, { reason: 'url_empty' }));
      }
      send(res, 200, { ok: true, webhook, board });
      return;
    }

    send(res, 404, { ok: false, error: 'not_found' });
  } catch (err) {
    const msg = err && err.message === 'bad_json' ? 'bad_json' : 'error';
    send(res, 400, { ok: false, error: msg });
  }
});

function listen(port) {
  server.listen(port, '0.0.0.0', () => {
    const disk = readJson(CONFIG_PATH, { url: '', key: '', port });
    if (Number(disk.port) !== port) {
      disk.port = port;
      if (!disk.key && process.env.key) disk.key = process.env.key;
      writeJson(CONFIG_PATH, { url: disk.url || '', key: disk.key || '', port });
    }
    fs.writeFileSync(path.join(ROOT, 'server.pid'), String(process.pid) + '\n');
    process.stdout.write('listening ' + port + '\n');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      listen(port + 1);
      return;
    }
    process.stderr.write('listen_error\n');
    process.exit(1);
  });
}

migrate();
const startPort = loadConfig().port || 8787;
listen(startPort);
