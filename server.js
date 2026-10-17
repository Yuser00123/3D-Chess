#!/usr/bin/env node
/* ============================================================
   Blade Chess 3D — server
   Zero-dependency Node server:
   - serves the static site from /public
   - room-code multiplayer API (in-memory rooms, chess.js validated)
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Chess } = require(path.join(__dirname, 'public', 'vendor', 'chess.min.js'));

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/* ---------------- rooms ---------------- */
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(c)) return c;
  }
}

function sanitizeName(n) {
  return (typeof n === 'string' ? n.trim().slice(0, 24) : '');
}

function makeRoom(name) {
  const room = {
    code: newCode(),
    chess: new Chess(),
    full: false,
    resigned: null,       // seat that resigned
    version: 1,
    gameId: 1,            // bumped on rematch (colors swap)
    lastMove: null,       // {from,to,promotion,san}
    lastActivity: Date.now(),
    players: { w: null, b: null }
  };
  room.players.w = {
    id: crypto.randomBytes(16).toString('hex'),
    name: sanitizeName(name) || 'White Knight',
    lastSeen: Date.now(),
    rematch: false
  };
  rooms.set(room.code, room);
  return room;
}

function findSeat(room, pid) {
  if (pid && room.players.w && room.players.w.id === pid) return 'w';
  if (pid && room.players.b && room.players.b.id === pid) return 'b';
  return null;
}

function statusOf(room) {
  const c = room.chess;
  if (room.resigned) return { status: 'resigned', winner: room.resigned === 'w' ? 'b' : 'w' };
  if (c.in_checkmate()) return { status: 'checkmate', winner: c.turn() === 'w' ? 'b' : 'w' };
  if (c.in_stalemate()) return { status: 'stalemate', winner: null };
  if (c.in_draw()) return { status: 'draw', winner: null };
  if (!room.full) return { status: 'waiting', winner: null };
  return { status: 'active', winner: null };
}

function stateOf(room, pid) {
  const s = statusOf(room);
  const now = Date.now();
  return {
    ok: true,
    code: room.code,
    version: room.version,
    gameId: room.gameId,
    fen: room.chess.fen(),
    turn: room.chess.turn(),
    history: room.chess.history(),
    lastMove: room.lastMove,
    inCheck: room.chess.in_check(),
    ...s,
    players: ['w', 'b'].map(col => {
      const p = room.players[col];
      if (!p) return null;
      return { seat: col, name: p.name, connected: (now - p.lastSeen) < 12000, rematch: p.rematch };
    }),
    you: findSeat(room, pid)
  };
}

function touch(room) { room.lastActivity = Date.now(); }

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => {
      b += d;
      if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/* ---------------- API ---------------- */
async function handleApi(req, res, pathname, query) {
  const route = `${req.method} ${pathname}`;

  if (route === 'POST /api/create') {
    const body = await readBody(req);
    const room = makeRoom(body.name);
    touch(room);
    return json(res, 200, { ok: true, code: room.code, pid: room.players.w.id, seat: 'w', state: stateOf(room, room.players.w.id) });
  }

  if (route === 'POST /api/join') {
    const body = await readBody(req);
    const room = rooms.get(('' + (body.code || '')).toUpperCase());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found. Check the code.' });
    touch(room);
    const seat = findSeat(room, body.pid);
    if (seat) { // idempotent rejoin (refresh)
      room.players[seat].lastSeen = Date.now();
      return json(res, 200, { ok: true, pid: body.pid, seat, state: stateOf(room, body.pid) });
    }
    if (room.full) return json(res, 409, { ok: false, error: 'Room is already full.' });
    room.players.b = {
      id: (typeof body.pid === 'string' && body.pid.length === 32) ? body.pid : crypto.randomBytes(16).toString('hex'),
      name: sanitizeName(body.name) || 'Black Knight',
      lastSeen: Date.now(),
      rematch: false
    };
    room.full = true;
    room.version++;
    return json(res, 200, { ok: true, pid: room.players.b.id, seat: 'b', state: stateOf(room, room.players.b.id) });
  }

  if (route === 'GET /api/state') {
    const room = rooms.get(('' + (query.code || '')).toUpperCase());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found' });
    const seat = findSeat(room, query.pid);
    if (seat) { room.players[seat].lastSeen = Date.now(); touch(room); }
    return json(res, 200, stateOf(room, query.pid));
  }

  if (route === 'POST /api/move') {
    const body = await readBody(req);
    const room = rooms.get(('' + (body.code || '')).toUpperCase());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found' });
    const seat = findSeat(room, body.pid);
    if (!seat) return json(res, 403, { ok: false, error: 'You are not a player in this room.' });
    room.players[seat].lastSeen = Date.now();
    touch(room);
    if (!room.full) return json(res, 400, { ok: false, error: 'Waiting for opponent to join.' });
    const st = statusOf(room);
    if (st.status !== 'active') return json(res, 400, { ok: false, error: 'Game is over.' });
    if (room.chess.turn() !== seat) return json(res, 400, { ok: false, error: 'Not your turn.' });
    const mv = room.chess.move({ from: body.from, to: body.to, promotion: body.promotion });
    if (!mv) return json(res, 400, { ok: false, error: 'Illegal move.' });
    room.lastMove = { from: mv.from, to: mv.to, promotion: mv.promotion || undefined, san: mv.san };
    room.version++;
    return json(res, 200, { ok: true, state: stateOf(room, body.pid) });
  }

  if (route === 'POST /api/resign') {
    const body = await readBody(req);
    const room = rooms.get(('' + (body.code || '')).toUpperCase());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found' });
    const seat = findSeat(room, body.pid);
    if (!seat) return json(res, 403, { ok: false, error: 'Not a player here.' });
    if (!room.resigned) { room.resigned = seat; room.version++; }
    touch(room);
    return json(res, 200, { ok: true, state: stateOf(room, body.pid) });
  }

  if (route === 'POST /api/rematch') {
    const body = await readBody(req);
    const room = rooms.get(('' + (body.code || '')).toUpperCase());
    if (!room) return json(res, 404, { ok: false, error: 'Room not found' });
    const seat = findSeat(room, body.pid);
    if (!seat) return json(res, 403, { ok: false, error: 'Not a player here.' });
    room.players[seat].rematch = true;
    room.players[seat].lastSeen = Date.now();
    touch(room);
    if (room.players.w && room.players.b && room.players.w.rematch && room.players.b.rematch) {
      // swap seats, reset game
      const pw = room.players.w, pb = room.players.b;
      room.players.w = pb; room.players.b = pw;
      room.players.w.rematch = false; room.players.b.rematch = false;
      room.chess = new Chess();
      room.resigned = null;
      room.lastMove = null;
      room.gameId++;
      room.version++;
    }
    return json(res, 200, { ok: true, state: stateOf(room, body.pid) });
  }

  if (route === 'POST /api/leave') {
    const body = await readBody(req);
    const room = rooms.get(('' + (body.code || '')).toUpperCase());
    if (room) {
      const seat = findSeat(room, body.pid);
      if (seat) room.players[seat] = null;
      if (!room.players.w && !room.players.b) rooms.delete(room.code);
      else room.version++;
      touch(room);
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { ok: false, error: 'Unknown API route' });
}

/* ---------------- static ---------------- */
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUB, pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------------- server ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, Object.fromEntries(u.searchParams));
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    try { json(res, 500, { ok: false, error: 'Server error' }); } catch (_) { /* noop */ }
  }
});

// cleanup stale rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 20 * 60 * 1000) rooms.delete(code);
  }
}, 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚔  Blade Chess 3D running on http://0.0.0.0:${PORT}`);
});
