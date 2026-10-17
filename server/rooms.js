/**
 * server/rooms.js — creating, finding, and cleaning up rooms.
 *
 * A "room" wraps one game state plus the connection bookkeeping that the
 * pure game logic doesn't care about: which socket belongs to whom, secret
 * reconnect tokens, and activity timestamps for cleanup.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { createGameState } from './game.js';
import { FAST_MODE_DIVISOR, LIMITS, ROOM_TIMEOUTS } from '../public/shared/constants.js';

/**
 * Room-code letters. Only consonants, with no I/O (and digits are never used),
 * so codes are easy to read across a room. Leaving out vowels means a random
 * code almost never spells a real word; BLOCKED catches a few acronyms.
 */
const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
const BLOCKED = ['WTF', 'FML', 'STFU', 'KKK', 'FCK', 'FK', 'SHT', 'DCK', 'CNT', 'FGT', 'NGR', 'PSS', 'TWT'];

/** code → room */
const rooms = new Map();

/**
 * @typedef {object} Room
 * @property {string} code
 * @property {string} hostToken           secret; lets the host screen reconnect
 * @property {string | null} hostSocketId
 * @property {number | null} hostDisconnectedAt
 * @property {number} lastActivity
 * @property {object} game                 state from game.js
 * @property {Map<string, string>} tokens        playerToken → playerId
 * @property {Map<string, string>} playerSockets playerId → socket id
 */

/** @returns {Room} */
export function createRoom({ fast = false, now = Date.now() } = {}) {
  const room = {
    code: generateRoomCode(),
    hostToken: randomUUID(),
    hostSocketId: null,
    hostDisconnectedAt: null,
    lastActivity: now,
    game: createGameState({ speed: fast ? FAST_MODE_DIVISOR : 1 }),
    tokens: new Map(),
    playerSockets: new Map(),
  };
  rooms.set(room.code, room);
  return room;
}

/** Looks up a room by code (case-insensitive, ignores spaces). */
export function getRoom(code) {
  if (typeof code !== 'string') return undefined;
  return rooms.get(code.replace(/\s/g, '').toUpperCase());
}

export function deleteRoom(code) {
  rooms.delete(code);
}

export function roomCount() {
  return rooms.size;
}

/** A short public id like "p3fa91c2e", shown to clients. Not a secret. */
export function newPlayerId() {
  return `p${randomBytes(4).toString('hex')}`;
}

/** A secret token the phone keeps so it can reconnect as the same player. */
export function newPlayerToken() {
  return randomUUID();
}

/** Returns the codes of rooms that should be deleted now. */
export function findExpiredRooms(now = Date.now()) {
  const expired = [];
  for (const room of rooms.values()) {
    const idle = now - room.lastActivity > ROOM_TIMEOUTS.IDLE_MS;
    const hostGone =
      room.hostSocketId === null &&
      room.hostDisconnectedAt !== null &&
      now - room.hostDisconnectedAt > ROOM_TIMEOUTS.HOST_GONE_MS;
    if (idle || hostGone) expired.push({ code: room.code, reason: idle ? 'idle for 30 minutes' : 'host left' });
  }
  return expired;
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    const bytes = randomBytes(LIMITS.ROOM_CODE_LENGTH);
    for (const byte of bytes) code += CODE_LETTERS[byte % CODE_LETTERS.length];
    if (rooms.has(code) || BLOCKED.some((bad) => code.includes(bad))) continue;
    return code;
  }
  throw new Error('Could not generate a unique room code.');
}
