/**
 * shared/connection.js — the Socket.IO connection, plus a promise helper.
 *
 * The Socket.IO server automatically serves its own browser client at
 * /socket.io/socket.io.esm.min.js, so we can `import` it like any other
 * ES module without a bundler or a CDN.
 */

import { io } from '/socket.io/socket.io.esm.min.js';

/**
 * Connects to the server and reports status changes.
 * @param {(status: 'connecting' | 'connected' | 'disconnected') => void} onStatus
 */
export function connect(onStatus) {
  // With no URL, io() connects back to whichever server served this page.
  const socket = io();

  onStatus('connecting');
  socket.on('connect', () => onStatus('connected'));
  socket.on('disconnect', () => onStatus('disconnected'));
  // Socket.IO keeps retrying on its own; we just keep the UI honest meanwhile.
  socket.on('connect_error', () => onStatus('disconnected'));

  return socket;
}

/**
 * Sends an event and waits for the server's reply (its "ack").
 * Always resolves (never throws) to { ok: true, ... } or { ok: false, error }.
 *
 *   const res = await request(socket, EVENTS.PLAYER_JOIN, { roomCode, name });
 *   if (!res.ok) showError(res.error);
 */
export function request(socket, event, payload = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ ok: false, error: 'Not connected to the server. Hang on…' });
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (err, response) => {
      if (err) resolve({ ok: false, error: 'The server took too long to answer. Try again.' });
      else resolve(response ?? { ok: false, error: 'No response from the server.' });
    });
  });
}
