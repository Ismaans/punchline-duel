/**
 * server/index.js — Express + Socket.IO setup and wiring.
 *
 * This file stays "thin": it serves the web pages, accepts socket
 * connections, checks who is allowed to do what, and forwards actions to
 * game.js (the rules). After every change it sends each client its own
 * filtered view of the game.
 */

import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

import { EVENTS } from '../public/shared/events.js';
import { RATE_LIMIT, ROOM_TIMEOUTS } from '../public/shared/constants.js';
import { applyAction, viewFor } from './game.js';
import {
  createRoom,
  deleteRoom,
  findExpiredRooms,
  getRoom,
  newPlayerId,
  newPlayerToken,
  roomCount,
} from './rooms.js';
import { clearTimer, scheduleTimer } from './timers.js';

// In ES modules there's no built-in __dirname like in CommonJS, so we
// rebuild it from import.meta.url (the URL of *this* file).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Render (and most hosts) tell us which port to use via an env variable.
const PORT = Number(process.env.PORT) || 3000;

const PROMPTS = loadPrompts();

const app = express();

// Socket.IO needs the raw Node HTTP server (not just the Express app) so it
// can "upgrade" HTTP requests into long-lived WebSocket connections.
const httpServer = createServer(app);
const io = new Server(httpServer, {
  maxHttpBufferSize: 10_000, // no legit message is anywhere near 10 KB
  // Notice dropped phones within ~20s instead of the default ~45s.
  pingInterval: 10_000,
  pingTimeout: 10_000,
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

// Health check for the hosting platform: "is the server alive?"
app.get('/health', (req, res) => {
  res.type('text').send('ok');
});

// "/" is the phone controller; "/host" is the big shared screen.
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play.html')));
app.get('/host', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'host.html')));

// When the host screen is opened at "localhost", phones can't use that
// address. The host page asks here for this computer's Wi-Fi address instead.
app.get('/api/lan', (req, res) => {
  res.json({ urls: getLanAddresses().map((ip) => `http://${ip}:${PORT}`) });
});

// Everything else in /public (JS, CSS, shared modules) is served as-is.
// `index: false` stops Express from auto-serving an index.html for "/",
// since we handle "/" ourselves above.
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---------------------------------------------------------------------------
// Applying game actions
// ---------------------------------------------------------------------------

/** The "context" game.js needs: the time, randomness, and the prompt bank. */
function gameContext() {
  return { now: Date.now(), rng: Math.random, prompts: PROMPTS };
}

/**
 * Runs one action through game.js. On success: saves the new state, logs
 * phase changes, (re)schedules the timer, and sends everyone the update.
 *
 * @param removalMessage shown to any player this action removed (e.g. a kick)
 */
function dispatch(room, action, { removalMessage = 'You were removed from the room.' } = {}) {
  const before = room.game;
  const result = applyAction(before, action, gameContext());
  if (result.bug) logError(`[${room.code}] game.js threw on "${action.type}"`, result.bug);
  if (!result.ok) return result;

  room.game = result.state;
  room.lastActivity = Date.now();
  logPhaseChange(room, before, room.game);
  dropRemovedPlayers(room, removalMessage);
  scheduleTimer(room.code, room.game.phaseEndsAt, room.game.stepId, (stepId) => onTimer(room.code, stepId));
  broadcast(room);
  return result;
}

function onTimer(code, stepId) {
  const room = getRoom(code);
  if (!room) return;
  const result = dispatch(room, { type: 'advance', stepId });
  if (!result.ok) log(`[${code}] timer ignored: ${result.error}`);
}

/** Sends every connected client in the room ITS OWN filtered view. */
function broadcast(room) {
  const serverNow = Date.now(); // lets clients correct for a phone clock that's off
  const base = { code: room.code, serverNow };

  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit(EVENTS.ROOM_STATE, {
      ...viewFor(room.game, { role: 'host' }),
      ...base,
      role: 'host',
    });
  }
  for (const [playerId, socketId] of room.playerSockets) {
    io.to(socketId).emit(EVENTS.ROOM_STATE, {
      ...viewFor(room.game, { role: 'player', playerId }),
      ...base,
      role: 'player',
    });
  }
}

/** After a kick or "New Game", forget players who are no longer in the game. */
function dropRemovedPlayers(room, message) {
  const stillHere = new Set(room.game.players.map((p) => p.id));
  for (const [token, playerId] of room.tokens) {
    if (stillHere.has(playerId)) continue;
    room.tokens.delete(token);
    const socketId = room.playerSockets.get(playerId);
    room.playerSockets.delete(playerId);
    const socket = socketId && io.sockets.sockets.get(socketId);
    if (socket) {
      socket.data = {};
      socket.emit(EVENTS.ERROR, { message, code: 'REMOVED' });
    }
  }
}

function closeRoom(code, reason) {
  const room = getRoom(code);
  if (!room) return;
  clearTimer(code);
  const socketIds = [room.hostSocketId, ...room.playerSockets.values()].filter(Boolean);
  for (const id of socketIds) {
    const socket = io.sockets.sockets.get(id);
    if (!socket) continue;
    socket.data = {};
    socket.emit(EVENTS.ERROR, { message: 'This room has closed. Thanks for playing!', code: 'ROOM_CLOSED' });
  }
  deleteRoom(code);
  log(`[${code}] room deleted (${reason}). ${roomCount()} room(s) open.`);
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.data = {}; // filled in once this socket becomes a host or player
  socket.use(rateLimiter(socket));

  // ----- Host screen ------------------------------------------------------

  handle(socket, EVENTS.HOST_CREATE, ({ fast }) => {
    detach(socket);
    const room = createRoom({ fast: fast === true });
    attachHost(room, socket);
    log(`[${room.code}] room created${fast === true ? ' (fast mode)' : ''}. ${roomCount()} room(s) open.`);
    broadcast(room);
    return { ok: true, roomCode: room.code, hostToken: room.hostToken };
  });

  handle(socket, EVENTS.HOST_REJOIN, ({ roomCode, hostToken }) => {
    const room = getRoom(roomCode);
    if (!room || typeof hostToken !== 'string' || room.hostToken !== hostToken) {
      return { ok: false, error: 'That room has closed.', code: 'REJOIN_FAILED' };
    }
    detach(socket);
    attachHost(room, socket);
    log(`[${room.code}] host reconnected`);
    broadcast(room);
    return { ok: true, roomCode: room.code, hostToken: room.hostToken };
  });

  handle(socket, EVENTS.HOST_START, () => withHost(socket, (room) => dispatch(room, { type: 'start' })));

  handle(socket, EVENTS.HOST_KICK, ({ playerId }) =>
    withHost(socket, (room) => {
      const name = room.game.players.find((p) => p.id === playerId)?.name;
      const result = dispatch(room, { type: 'kick', playerId }, { removalMessage: 'The host removed you from the room.' });
      if (result.ok) log(`[${room.code}] host kicked ${name}`);
      return result;
    }),
  );

  handle(socket, EVENTS.HOST_PLAY_AGAIN, ({ samePlayers }) =>
    withHost(socket, (room) =>
      dispatch(
        room,
        { type: 'playAgain', samePlayers: samePlayers === true },
        { removalMessage: 'A new game started without you. Join again to play!' },
      ),
    ),
  );

  handle(socket, EVENTS.HOST_ADD_PROMPT, ({ text }) =>
    withHost(socket, (room) => dispatch(room, { type: 'addPrompt', text: asString(text) })),
  );

  handle(socket, EVENTS.HOST_REMOVE_PROMPT, ({ promptId }) =>
    withHost(socket, (room) => dispatch(room, { type: 'removePrompt', promptId })),
  );

  // ----- Phones -----------------------------------------------------------

  handle(socket, EVENTS.PLAYER_JOIN, ({ roomCode, name }) => {
    const room = getRoom(roomCode);
    if (!room) {
      return { ok: false, error: `No room found with code "${asString(roomCode).toUpperCase()}".`, code: 'ROOM_NOT_FOUND' };
    }
    detach(socket);

    // Register the socket BEFORE dispatching so the broadcast inside
    // dispatch() includes this new player. Undo it if the join fails.
    const playerId = newPlayerId();
    room.playerSockets.set(playerId, socket.id);
    const result = dispatch(room, { type: 'join', playerId, name: asString(name) });
    if (!result.ok) {
      room.playerSockets.delete(playerId);
      return result;
    }

    const playerToken = newPlayerToken();
    room.tokens.set(playerToken, playerId);
    socket.data = { role: 'player', roomCode: room.code, playerId };
    const player = room.game.players.find((p) => p.id === playerId);
    log(`[${room.code}] ${player.name} joined (${room.game.players.length} players)`);
    return { ok: true, roomCode: room.code, playerToken, playerId };
  });

  handle(socket, EVENTS.PLAYER_REJOIN, ({ roomCode, playerToken }) => {
    const room = getRoom(roomCode);
    const playerId = room?.tokens.get(asString(playerToken));
    const player = room?.game.players.find((p) => p.id === playerId);
    if (!room || !player) {
      return { ok: false, error: 'Your spot in that game is gone.', code: 'REJOIN_FAILED' };
    }
    detach(socket);

    // If this player is open in another tab, that tab gets bumped.
    const oldSocket = io.sockets.sockets.get(room.playerSockets.get(playerId));
    if (oldSocket && oldSocket.id !== socket.id) {
      oldSocket.data = {};
      oldSocket.emit(EVENTS.ERROR, { message: 'You opened the game somewhere else.', code: 'REPLACED' });
    }

    room.playerSockets.set(playerId, socket.id);
    socket.data = { role: 'player', roomCode: room.code, playerId };
    log(`[${room.code}] ${player.name} reconnected`);
    dispatch(room, { type: 'setConnected', playerId, connected: true });
    return { ok: true, roomCode: room.code, playerToken, playerId };
  });

  handle(socket, EVENTS.PLAYER_SET_AVATAR, ({ avatar }) =>
    withPlayer(socket, (room, playerId) => dispatch(room, { type: 'setAvatar', playerId, avatar })),
  );

  handle(socket, EVENTS.PLAYER_START, () =>
    withPlayer(socket, (room, playerId) => dispatch(room, { type: 'start', byPlayerId: playerId })),
  );

  handle(socket, EVENTS.PLAYER_ANSWER, ({ promptId, text }) =>
    withPlayer(socket, (room, playerId) =>
      dispatch(room, { type: 'answer', playerId, promptId: asString(promptId), text: asString(text) }),
    ),
  );

  handle(socket, EVENTS.PLAYER_VOTE, ({ matchupId, choice }) =>
    withPlayer(socket, (room, playerId) => dispatch(room, { type: 'vote', playerId, matchupId, choice })),
  );

  handle(socket, EVENTS.PLAYER_FINAL_VOTE, ({ answerIds }) =>
    withPlayer(socket, (room, playerId) => dispatch(room, { type: 'finalVote', playerId, answerIds })),
  );

  handle(socket, EVENTS.PLAYER_LEAVE, () =>
    withPlayer(socket, (room, playerId) => {
      const name = room.game.players.find((p) => p.id === playerId)?.name;
      for (const [token, id] of room.tokens) if (id === playerId) room.tokens.delete(token);
      room.playerSockets.delete(playerId);
      socket.data = {};
      // In the lobby they're removed for real; mid-game they just go idle.
      const result = dispatch(room, { type: 'leave', playerId });
      if (!result.ok) dispatch(room, { type: 'setConnected', playerId, connected: false });
      log(`[${room.code}] ${name} left`);
      return { ok: true };
    }),
  );

  // ----- Diagnostics ------------------------------------------------------

  socket.on(EVENTS.PING, (ack) => {
    if (typeof ack === 'function') ack({ ok: true, serverTime: Date.now() });
  });

  socket.on('disconnect', () => detach(socket));
});

// ---------------------------------------------------------------------------
// Socket helpers
// ---------------------------------------------------------------------------

/**
 * Registers an event handler with the boring parts done for us:
 *  - the payload is always an object (never undefined/null/garbage)
 *  - the handler's return value is sent back through the ack callback, or as
 *    a game:error event if the client didn't pass a callback
 *  - a crash in one handler can't take down the server
 */
function handle(socket, event, handler) {
  socket.on(event, (payload, ack) => {
    if (typeof payload === 'function') [payload, ack] = [{}, payload];
    if (payload === null || typeof payload !== 'object') payload = {};

    let response;
    try {
      response = handler(payload) ?? { ok: true };
    } catch (err) {
      logError(`error handling ${event}`, err);
      response = { ok: false, error: 'Something went wrong on the server.' };
    }
    // game.js results include the whole state; don't send that back.
    const reply = response.ok
      ? { ok: true, ...withoutState(response) }
      : { ok: false, error: response.error, code: response.code };

    if (typeof ack === 'function') ack(reply);
    else if (!reply.ok) socket.emit(EVENTS.ERROR, { message: reply.error, code: reply.code });
  });
}

function withoutState({ state, ok, ...rest }) {
  return rest;
}

/** Runs fn(room) only if this socket is the room's current host screen. */
function withHost(socket, fn) {
  const room = socket.data.role === 'host' ? getRoom(socket.data.roomCode) : undefined;
  if (!room || room.hostSocketId !== socket.id) {
    return { ok: false, error: 'This screen is not hosting a room. Refresh to start a new one.' };
  }
  return fn(room);
}

/** Runs fn(room, playerId) only if this socket is a current player. */
function withPlayer(socket, fn) {
  const { role, roomCode, playerId } = socket.data;
  const room = role === 'player' ? getRoom(roomCode) : undefined;
  if (!room || room.playerSockets.get(playerId) !== socket.id) {
    return { ok: false, error: "You're not in a room right now. Try refreshing." };
  }
  return fn(room, playerId);
}

function attachHost(room, socket) {
  const oldSocket = io.sockets.sockets.get(room.hostSocketId);
  if (oldSocket && oldSocket.id !== socket.id) {
    oldSocket.data = {};
    oldSocket.emit(EVENTS.ERROR, { message: 'This room was opened on another screen.', code: 'REPLACED' });
  }
  room.hostSocketId = socket.id;
  room.hostDisconnectedAt = null;
  room.lastActivity = Date.now();
  socket.data = { role: 'host', roomCode: room.code };
}

/** Unlinks a socket from whatever room it was in (on disconnect, or before re-joining). */
function detach(socket) {
  const { role, roomCode, playerId } = socket.data;
  socket.data = {};
  const room = getRoom(roomCode);
  if (!room) return;

  if (role === 'host' && room.hostSocketId === socket.id) {
    room.hostSocketId = null;
    room.hostDisconnectedAt = Date.now();
    log(`[${room.code}] host disconnected (room closes in ${ROOM_TIMEOUTS.HOST_GONE_MS / 60000} min unless it returns)`);
  }

  if (role === 'player' && room.playerSockets.get(playerId) === socket.id) {
    room.playerSockets.delete(playerId);
    const player = room.game.players.find((p) => p.id === playerId);
    if (player) {
      log(`[${room.code}] ${player.name} disconnected`);
      dispatch(room, { type: 'setConnected', playerId, connected: false });
      // game.js keeps waiting for them during a short grace period. When it
      // ends, re-check whether everyone else is done so the game can move on.
      setTimeout(() => {
        const current = getRoom(room.code);
        if (current) dispatch(current, { type: 'tick' });
      }, ROOM_TIMEOUTS.RECONNECT_GRACE_MS + 100);
    }
  }
}

/**
 * Token-bucket rate limiter: each socket gets a bucket that holds up to
 * N "tokens" and refills at N per second. Each event costs one token; with
 * an empty bucket the event is dropped.
 */
function rateLimiter(socket) {
  const capacity = RATE_LIMIT.EVENTS_PER_SECOND;
  let tokens = capacity;
  let last = Date.now();
  let warnedAt = 0;

  return (packet, next) => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * capacity);
    last = now;
    if (tokens < 1) {
      if (now - warnedAt > 2000) {
        warnedAt = now;
        socket.emit(EVENTS.ERROR, { message: 'Whoa, slow down! Too many taps at once.', code: 'RATE_LIMITED' });
      }
      return; // not calling next() drops the event
    }
    tokens -= 1;
    next();
  };
}

function asString(value) {
  return typeof value === 'string' ? value.slice(0, 500) : '';
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

setInterval(() => {
  for (const { code, reason } of findExpiredRooms()) closeRoom(code, reason);
}, ROOM_TIMEOUTS.CLEANUP_INTERVAL_MS);

function loadPrompts() {
  const file = path.join(__dirname, 'prompts.json');
  const prompts = JSON.parse(readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const p of prompts) {
    if (typeof p.id !== 'string' || typeof p.text !== 'string' || ids.has(p.id)) {
      throw new Error(`Bad or duplicate prompt in prompts.json: ${JSON.stringify(p)}`);
    }
    ids.add(p.id);
  }
  return prompts;
}

function logPhaseChange(room, before, after) {
  if (before.phase !== after.phase) {
    log(`[${room.code}] phase ${before.phase} → ${after.phase}`);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  const finals = PROMPTS.filter((p) => p.final).length;
  log(`Punchline Duel server running on port ${PORT} (${PROMPTS.length} prompts, ${finals} finals)`);
  log(`  Host screen: http://localhost:${PORT}/host   (add ?fast=1 for 5x faster timers)`);
  for (const ip of getLanAddresses()) {
    log(`  Phones (same Wi-Fi): http://${ip}:${PORT}/`);
  }
});

/** Timestamped console log so server output is easy to follow. */
function log(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
}

function logError(message, err) {
  const time = new Date().toLocaleTimeString();
  console.error(`[${time}] ERROR ${message}:`, err);
}

/** Finds this computer's local network IPv4 addresses (e.g. 192.168.1.23). */
function getLanAddresses() {
  const addresses = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}
