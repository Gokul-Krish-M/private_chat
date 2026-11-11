import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { openDb, MAX_ROOMS, MESSAGE_TTL_MS } from './db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4545;
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.CHAT_DB || path.join(ROOT, 'data', 'chat.db');
const MAX_CIPHERTEXT = 16 * 1024;
const TOKEN = process.env.CHAT_TOKEN || '';
const TLS_CERT = process.env.TLS_CERT;
const TLS_KEY = process.env.TLS_KEY;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const db = openDb(DB_FILE);

/** ws -> { name, roomId, alive } */
const clients = new Map();

const send = (ws, obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
const emit = (ws, event, data) => send(ws, { event, data });

function each(fn, filter = () => true) {
  for (const [ws, c] of clients) if (filter(c)) fn(ws, c);
}

function roomsWithPresence() {
  return db.listRooms().map((r) => {
    let online = 0;
    each(() => online++, (c) => c.roomId === r.id);
    return { ...r, online };
  });
}

const roomsPayload = () => ({ rooms: roomsWithPresence(), maxRooms: MAX_ROOMS });

function broadcastRooms() {
  const data = roomsPayload();
  each((ws) => emit(ws, 'rooms', data), (c) => c.name);
}

function toRoom(roomId, event, data) {
  each((ws) => emit(ws, event, data), (c) => c.roomId === roomId);
}

function leaveRoom(client) {
  if (client.roomId == null) return;
  const roomId = client.roomId;
  client.roomId = null;
  toRoom(roomId, 'presence', { roomId, name: client.name, action: 'left' });
}

function requireRoom(roomId) {
  const room = db.getRoom(Number(roomId));
  if (!room) throw new Error('Room not found.');
  return room;
}

function checkToken(given) {
  if (!TOKEN) return;
  const hash = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
  if (!crypto.timingSafeEqual(hash(given), hash(TOKEN))) throw new Error('Invalid access token.');
}

function cleanBase64(value, label, max) {
  if (typeof value !== 'string' || !value || value.length > max || !BASE64.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function cleanText(value, label, max) {
  const s = String(value ?? '').trim();
  if (!s) throw new Error(`${label} cannot be empty.`);
  if (s.length > max) throw new Error(`${label} must be at most ${max} characters.`);
  return s;
}

const handlers = {
  hello(client, { name, token }) {
    checkToken(token);
    client.name = cleanText(name, 'Name', 24);
    return { name: client.name, ttlMs: MESSAGE_TTL_MS, ...roomsPayload() };
  },

  list_rooms: () => roomsPayload(),

  create_room(client, { name, salt, verifier }) {
    const room = db.createRoom({
      name: cleanText(name, 'Room name', 32),
      salt: cleanBase64(salt, 'salt', 64),
      verifier: cleanBase64(verifier, 'verifier', 256),
    });
    broadcastRooms();
    return room;
  },

  delete_room(client, { roomId }) {
    const room = requireRoom(roomId);
    each(
      (ws, c) => {
        c.roomId = null;
        emit(ws, 'room_deleted', { roomId: room.id, name: room.name, by: client.name });
      },
      (c) => c.roomId === room.id,
    );
    db.deleteRoom(room.id);
    broadcastRooms();
    return roomsPayload();
  },

  join(client, { roomId }) {
    const room = requireRoom(roomId);
    leaveRoom(client);
    client.roomId = room.id;
    toRoom(room.id, 'presence', { roomId: room.id, name: client.name, action: 'joined' });
    broadcastRooms();
    return { room, history: db.history(room.id) };
  },

  leave(client) {
    leaveRoom(client);
    broadcastRooms();
    return {};
  },

  // `body` is end-to-end encrypted by the client; the server stores it as-is.
  message(client, { body }) {
    if (client.roomId == null) throw new Error('Join a room first.');
    const msg = db.addMessage(client.roomId, client.name, cleanBase64(body, 'message', MAX_CIPHERTEXT));
    toRoom(client.roomId, 'message', msg);
    return { id: msg.id };
  },
};

// ---------- web view (static files from ./web) ----------
const WEB_DIR = path.join(ROOT, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// Allow-list built at startup: only top-level files in web/ with a known type are ever served.
const WEB_FILES = new Map(
  (fs.existsSync(WEB_DIR) ? fs.readdirSync(WEB_DIR) : [])
    .filter((f) => MIME[path.extname(f)])
    .map((f) => [`/${f}`, path.join(WEB_DIR, f)]),
);
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cache-control': 'no-cache',
};

function onHttp(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  const file = WEB_FILES.get(pathname === '/' ? '/index.html' : pathname);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found\n');
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)], ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

// TLS is optional here: either set TLS_CERT/TLS_KEY, or (recommended) keep HOST=127.0.0.1
// and let a reverse proxy like Caddy/nginx terminate HTTPS in front of this process.
const server =
  TLS_CERT && TLS_KEY
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, onHttp)
    : http.createServer(onHttp);

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const client = { name: null, roomId: null, alive: true };
  clients.set(ws, client);
  ws.on('pong', () => (client.alive = true));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { re: null, ok: false, error: 'Invalid JSON.' });
    }
    const { id, type, ...payload } = msg;
    try {
      const handler = Object.hasOwn(handlers, type) ? handlers[type] : null;
      if (!handler) throw new Error(`Unknown request: ${type}`);
      if (type !== 'hello' && !client.name) throw new Error('Send hello first.');
      send(ws, { re: id, ok: true, data: handler(client, payload) ?? {} });
    } catch (err) {
      send(ws, { re: id, ok: false, error: err.message });
    }
  });

  ws.on('close', () => {
    leaveRoom(client);
    clients.delete(ws);
    broadcastRooms();
  });
});

// Drop dead connections so "online" counts stay accurate.
const heartbeat = setInterval(() => {
  for (const [ws, c] of clients) {
    if (!c.alive) {
      ws.terminate();
      continue;
    }
    c.alive = false;
    ws.ping();
  }
}, 30_000);

// Messages older than 24h are deleted.
function purge() {
  const cutoff = Date.now() - MESSAGE_TTL_MS;
  if (db.purgeBefore(cutoff) > 0) {
    each((ws) => emit(ws, 'expired', { cutoff }), (c) => c.roomId != null);
  }
}
purge();
const purger = setInterval(purge, 60_000);

server.listen(PORT, HOST, () => {
  console.log(`secret-chat server listening on ${TLS_CERT && TLS_KEY ? 'wss' : 'ws'}://${HOST}:${PORT}`);
  console.log(`database: ${DB_FILE}`);
  if (!TOKEN) console.log('warning: CHAT_TOKEN is not set, so anyone who can reach this server can use it.');
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(purger);
  for (const ws of clients.keys()) ws.close(1001, 'Server shutting down');
  wss.close();
  server.close();
  db.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
