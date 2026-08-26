'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');

const rooms = require('./rooms');
const accounts = require('./accounts');
const { signToken, verifyToken } = require('./auth');
const { defaultConfig, suggestedTeamNames, roles, tiers, ROLE_PURSE_CUT, sampleNamesFallback } = require('./auctionConfig');

const PREFERRED_PORT = Number(process.env.PORT) || 3000;
const PORT_FALLBACK_RANGE = 25;
let listenPort = PREFERRED_PORT;
const ROOT = path.join(__dirname, '..');
const BUNDLED_CSV_PATH = path.join(ROOT, 'cricket-players-my-tournament-2026-03-23.csv');

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

function broadcastState(roomId, state) {
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

/** Suggested defaults + optional bundled CSV for the "create room" form. Nothing here is auto-loaded into a room. */
app.get('/api/presets', (req, res) => {
  let bundledCsv = null;
  try {
    if (fs.existsSync(BUNDLED_CSV_PATH)) {
      bundledCsv = {
        filename: path.basename(BUNDLED_CSV_PATH),
        text: fs.readFileSync(BUNDLED_CSV_PATH, 'utf8'),
      };
    }
  } catch {
    bundledCsv = null;
  }
  res.json({
    ok: true,
    defaultConfig,
    suggestedTeamNames,
    roles,
    tiers,
    roleCuts: ROLE_PURSE_CUT,
    sampleNamesFallback,
    bundledCsv,
  });
});

app.post('/api/rooms', (req, res) => {
  try {
    const body = req.body || {};
    const { roomId, room } = rooms.createRoom(
      {
        name: body.name,
        teamNames: body.teamNames,
        purse: body.purse,
        basePrices: body.basePrices,
        increments: body.increments,
        teamSize: body.teamSize,
        roleCuts: body.roleCuts,
        playersMode: body.playersMode,
        csvText: body.csvText,
        listNames: body.listNames,
        playerRegistrationMode: body.playerRegistrationMode,
      },
      { hostPin: body.hostPin, teamPins: body.teamPins }
    );
    const hostToken = signToken({ roomId, role: 'host', pinVersion: room.access.hostPinVersion });
    res.json({
      ok: true,
      roomId,
      name: room.name,
      hostToken,
      hostPin: room.access.hostPin,
      playerPin: room.access.playerPin,
      teams: room.state.teams.map((t) => ({
        teamId: t.id,
        name: t.name,
        pin: room.access.teamPins[t.id].pin,
      })),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Could not create room.' });
  }
});

// -----------------------------------------------------------------------
// Player accounts — a self-service identity so a player's profile (name,
// age, role, photo) is filled in once and reused across every auction they
// join. Not tied to any one room.
// -----------------------------------------------------------------------
app.post('/api/accounts/signup', (req, res) => {
  try {
    const body = req.body || {};
    const account = accounts.createAccount({
      username: body.username,
      password: body.password,
      name: body.name,
      age: body.age,
      role: body.role,
      photo: body.photo,
    });
    const token = signToken({ kind: 'account', accountId: account.id });
    res.json({ ok: true, token, account });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Could not create account.' });
  }
});

app.post('/api/accounts/login', (req, res) => {
  const { username, password } = req.body || {};
  const account = accounts.login(username, password);
  if (!account) return res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
  const token = signToken({ kind: 'account', accountId: account.id });
  res.json({ ok: true, token, account });
});

/** Verifies an account bearer token, independent of any room. */
function authorizeAccount(token) {
  const payload = verifyToken(token);
  if (!payload || payload.kind !== 'account' || !payload.accountId) {
    return { error: 'Please log in again.' };
  }
  const account = accounts.getAccount(payload.accountId);
  if (!account) return { error: 'Account no longer exists.' };
  return { account };
}

app.get('/api/accounts/me', (req, res) => {
  const auth = authorizeAccount(req.query.token);
  if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
  res.json({ ok: true, account: auth.account });
});

app.get('/api/rooms/:roomId/info', (req, res) => {
  const info = rooms.publicRoomInfo(req.params.roomId);
  if (!info) return res.status(404).json({ ok: false, error: 'Room not found.' });
  res.json({ ok: true, info });
});

app.post('/api/rooms/:roomId/join', (req, res) => {
  const roomId = req.params.roomId;
  if (!rooms.roomExists(roomId)) return res.status(404).json({ ok: false, error: 'Room not found.' });
  const match = rooms.verifyPin(roomId, req.body && req.body.pin);
  if (!match) return res.status(401).json({ ok: false, error: 'Incorrect PIN.' });
  if (match.role === 'host') {
    const token = signToken({ roomId, role: 'host', pinVersion: match.pinVersion });
    return res.json({ ok: true, role: 'host', token });
  }
  const token = signToken({ roomId, role: 'team', teamId: match.teamId, pinVersion: match.pinVersion });
  res.json({ ok: true, role: 'team', teamId: match.teamId, teamName: match.teamName, token });
});

app.get('/api/rooms/:roomId/state', (req, res) => {
  const roomId = req.params.roomId;
  const state = rooms.publicState(roomId);
  if (!state) return res.status(404).json({ ok: false, error: 'Room not found.' });
  res.json({ ok: true, state });
});

// -----------------------------------------------------------------------
// Self-registration: a logged-in player submits the room's Player PIN and
// their account profile is copied into that room's pool. Tier/base price and
// everything else auction-specific stays entirely in the host's hands — see
// rooms.registerPlayer / approvePendingPlayer.
// -----------------------------------------------------------------------
app.post('/api/rooms/:roomId/register-player', (req, res) => {
  const roomId = req.params.roomId;
  const { accountToken, pin, role, age } = req.body || {};
  const auth = authorizeAccount(accountToken);
  if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
  const result = rooms.registerPlayer(roomId, pin, auth.account, { role, age });
  if (!result.ok) return res.status(400).json(result);
  if (result.state) broadcastState(roomId, result.state);
  res.json({ ok: true, status: result.status });
});

/** Lets a player's own dashboard check "am I in yet?" without exposing anyone else's pending registration. */
app.get('/api/rooms/:roomId/my-status', (req, res) => {
  const roomId = req.params.roomId;
  const auth = authorizeAccount(req.query.accountToken);
  if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
  if (!rooms.roomExists(roomId)) return res.status(404).json({ ok: false, error: 'Room not found.' });
  res.json({ ok: true, ...rooms.myRegistrationStatus(roomId, auth.account.id) });
});

/** Verifies a bearer-style token from the request body against a room, honoring PIN-regeneration invalidation. */
function authorize(roomId, token) {
  const payload = verifyToken(token);
  if (!payload || payload.roomId !== roomId) return { error: 'Invalid session — please rejoin the room.' };
  const room = rooms.getRoom(roomId);
  if (!room) return { error: 'Room not found.' };
  const current = rooms.currentPinVersion(room, payload.role, payload.teamId);
  if (current !== payload.pinVersion) {
    return { error: 'Your access PIN was changed by the host — please rejoin with the new PIN.' };
  }
  return { payload, room };
}

app.post('/api/rooms/:roomId/actions', (req, res) => {
  const roomId = req.params.roomId;
  const { token, action, payload } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'Missing action.' });

  const auth = authorize(roomId, token);
  if (auth.error) return res.status(401).json({ ok: false, error: auth.error });
  const { payload: session } = auth;

  let finalPayload = payload || {};
  if (session.role === 'team') {
    if (action !== 'bid') {
      return res.status(403).json({ ok: false, error: 'Teams can only place bids.' });
    }
    finalPayload = { ...finalPayload, teamId: session.teamId };
  } else if (session.role !== 'host') {
    return res.status(403).json({ ok: false, error: 'Not authorized.' });
  }

  const result = rooms.runAction(roomId, action, finalPayload);
  if (!result.ok) return res.status(400).json(result);
  broadcastState(roomId, result.state);
  res.json({ ok: true, state: result.state });
});

/** Requires a valid host session for the room; used by every /host/* route below. */
function requireHost(roomId, token, res) {
  const auth = authorize(roomId, token);
  if (auth.error) {
    res.status(401).json({ ok: false, error: auth.error });
    return null;
  }
  if (auth.payload.role !== 'host') {
    res.status(403).json({ ok: false, error: 'Host only.' });
    return null;
  }
  return auth;
}

app.get('/api/rooms/:roomId/host/pins', (req, res) => {
  const roomId = req.params.roomId;
  if (!requireHost(roomId, req.query.token, res)) return;
  res.json({ ok: true, ...rooms.hostPinInfo(roomId) });
});

app.post('/api/rooms/:roomId/host/regenerate-pin', (req, res) => {
  const roomId = req.params.roomId;
  const { token, target } = req.body || {};
  if (!requireHost(roomId, token, res)) return;
  const result = rooms.regeneratePin(roomId, target);
  if (!result) return res.status(400).json({ ok: false, error: 'Unknown target.' });
  res.json({ ok: true, pin: result.pin });
});

app.get('/api/rooms/:roomId/host/pending', (req, res) => {
  const roomId = req.params.roomId;
  if (!requireHost(roomId, req.query.token, res)) return;
  res.json({ ok: true, pending: rooms.pendingPlayers(roomId) });
});

app.post('/api/rooms/:roomId/host/approve-player', (req, res) => {
  const roomId = req.params.roomId;
  const { token, pendingId, tier } = req.body || {};
  if (!requireHost(roomId, token, res)) return;
  const result = rooms.approvePendingPlayer(roomId, pendingId, tier);
  if (!result.ok) return res.status(400).json(result);
  broadcastState(roomId, result.state);
  res.json({ ok: true, state: result.state });
});

app.post('/api/rooms/:roomId/host/reject-player', (req, res) => {
  const roomId = req.params.roomId;
  const { token, pendingId } = req.body || {};
  if (!requireHost(roomId, token, res)) return;
  const result = rooms.rejectPendingPlayer(roomId, pendingId);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true });
});

app.post('/api/rooms/:roomId/host/registration-mode', (req, res) => {
  const roomId = req.params.roomId;
  const { token, mode } = req.body || {};
  if (!requireHost(roomId, token, res)) return;
  const settings = rooms.setRegistrationMode(roomId, mode);
  if (!settings) return res.status(400).json({ ok: false, error: 'Invalid mode.' });
  res.json({ ok: true, settings });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});
app.use('/images', express.static(path.join(ROOT, 'images')));
// express.static ignores dotfiles by default (e.g. GET /foo/.bar -> 404), which would
// break Android's Digital Asset Links / Apple's Universal Links verification files —
// both must be served from a literal /.well-known/ path. Mounting the static handler
// AT that prefix serves everything under public/.well-known/ normally, since the
// dotfile check only looks at the path *under* the mount root, not the mount itself.
app.use('/.well-known', express.static(path.join(ROOT, 'public', '.well-known')));
app.use(express.static(path.join(ROOT, 'public')));

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
    const roomId = url.searchParams.get('roomId') || '';
    if (!rooms.roomExists(roomId)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      subscribe(roomId, ws);
      ws.send(JSON.stringify({ type: 'state', state: rooms.publicState(roomId) }));
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
    console.warn(`Port ${PREFERRED_PORT} was busy; using ${listenPort}.`);
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
