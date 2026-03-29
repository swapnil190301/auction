'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const { makeInitialState, processAction } = require('./auctionLogic');
const { loadRoom, persistAllRooms } = require('./auctionPersistence');

const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const PORT_FALLBACK_RANGE = 25;
let listenPort = PREFERRED_PORT;
const ROOT = path.join(__dirname, '..');

const rooms = new Map();

function getRoom(roomId) {
  const id = String(roomId || 'default').slice(0, 64) || 'default';
  if (!rooms.has(id)) {
    const saved = loadRoom(id);
    if (saved) {
      rooms.set(id, saved);
    } else {
      rooms.set(id, {
        state: makeInitialState(),
        history: [],
      });
    }
  }
  return rooms.get(id);
}

/** roomId -> Set<WebSocket> */
const subscribers = new Map();

function subscribe(roomId, ws) {
  if (!subscribers.has(roomId)) subscribers.set(roomId, new Set());
  subscribers.get(roomId).add(ws);
  ws._roomId = roomId;
}

function unsubscribe(ws) {
  const roomId = ws._roomId;
  if (!roomId || !subscribers.has(roomId)) return;
  subscribers.get(roomId).delete(ws);
  if (subscribers.get(roomId).size === 0) subscribers.delete(roomId);
}

function broadcast(roomId, state) {
  const set = subscribers.get(roomId);
  if (!set) return;
  const msg = JSON.stringify({ type: 'state', state });
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

const app = express();
app.use(express.json({ limit: '12mb' }));

app.get('/health', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.get('/api/state', (req, res) => {
  const room = req.query.room || 'default';
  const r = getRoom(room);
  res.json({ ok: true, state: r.state });
});

app.post('/api/actions', (req, res) => {
  const room = req.body.room || 'default';
  const action = req.body.action;
  const payload = req.body.payload || {};
  if (!action) {
    return res.status(400).json({ ok: false, error: 'Missing action' });
  }
  const r = getRoom(room);
  const result = processAction(r.state, r.history, action, payload);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  r.state = result.state;
  r.history = result.history;
  persistAllRooms(rooms);
  broadcast(room, r.state);
  res.json({ ok: true, state: r.state });
});

app.use(express.static(ROOT));

const server = http.createServer(app);

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  try {
    const host = request.headers.host || 'localhost';
    const url = new URL(request.url, `http://${host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const room = url.searchParams.get('room') || 'default';
    wss.handleUpgrade(request, socket, head, (ws) => {
      const r = getRoom(room);
      subscribe(room, ws);
      ws.send(JSON.stringify({ type: 'state', state: r.state }));
      ws.on('close', () => unsubscribe(ws));
      ws.on('error', () => unsubscribe(ws));
    });
  } catch {
    socket.destroy();
  }
});

function onListen() {
  const publicHint = process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${listenPort}`;
  console.log(`Cricket auction server listening on 0.0.0.0:${listenPort} (open ${publicHint} in your browser)`);
  if (listenPort !== PREFERRED_PORT) {
    console.warn(
      `Port ${PREFERRED_PORT} was busy; using ${listenPort}.`
    );
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    listenPort++;
    const maxPort = PREFERRED_PORT + PORT_FALLBACK_RANGE - 1;
    if (listenPort > maxPort) {
      console.error(
        `No free port between ${PREFERRED_PORT} and ${maxPort}. ` +
          'Stop other servers using those ports, or set PORT to a free value.'
      );
      process.exit(1);
    }
    server.listen(listenPort, '0.0.0.0', onListen);
    return;
  }
  throw err;
});

server.listen(listenPort, '0.0.0.0', onListen);
