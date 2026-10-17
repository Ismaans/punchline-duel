/**
 * scripts/bots.js — fake players so you can test a whole game alone.
 *
 *   npm run bots -- CODE 4             4 bots join room CODE
 *   npm run bots -- CODE 4 --lazy      bots sometimes "forget" to answer/vote
 *   npm run bots -- NEW 5              no host screen needed: the script creates
 *                                      a fast-mode room, starts it, and prints
 *                                      the standings at the end (a full smoke test)
 *   --url http://192.168.1.20:3000     connect to a different server
 *
 * Each bot is a real Socket.IO client that sees exactly what a phone sees,
 * so this exercises the same code paths as real players.
 */

import { io } from 'socket.io-client';

import { EVENTS } from '../public/shared/events.js';
import { PHASES as P, AVATARS, LIMITS } from '../public/shared/constants.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--url'));

const URL = option('--url', `http://localhost:${process.env.PORT || 3000}`);
const LAZY = flag('--lazy');
const roomArg = (positional[0] ?? '').toUpperCase();
const count = Math.min(LIMITS.MAX_PLAYERS, Math.max(1, Number(positional[1]) || 3));

if (!roomArg) {
  console.log('Usage: npm run bots -- <ROOM CODE | NEW> [count] [--lazy] [--url http://host:port]');
  process.exit(1);
}

const BOT_NAMES = ['BeepBoop', 'Sprocket', 'Clanky', 'Widget', 'Toaster', 'Gearhead', 'Noodle', 'Doohickey'];

const SILLY_ANSWERS = [
  'a suspiciously damp sock',
  'three raccoons in a trench coat',
  'my dad\'s karaoke voice',
  'a haunted spork',
  'an emotional support potato',
  'the loudest sneeze ever recorded',
  'free samples of air',
  'a llama with a law degree',
  'glitter. So much glitter.',
  'expired yogurt',
  'a strongly worded letter',
  'my grandma\'s secret dance moves',
  'interpretive dance',
  'a confused penguin',
  'way too much mayonnaise',
  'a motivational poster about naps',
  'a sandwich that knows too much',
  'the left shoe only',
  'a pigeon wearing a tiny hat',
  'one (1) slightly used banana',
  'a dramatic slow clap',
  'yelling "PLOT TWIST!"',
  'socks with sandals',
  'a pet rock named Kevin',
  'unlimited breadsticks',
  'a wizard who only does taxes',
  'a mysterious humming noise',
  'cheese',
  'cheese', // duplicate on purpose: two bots sometimes Mind Meld
  'a nap',
];

const random = (items) => items[Math.floor(Math.random() * items.length)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...parts) => console.log(`[bots]`, ...parts);

/** Emits an event and waits for the server's ack reply. */
function request(socket, event, payload) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: 'timeout' } : res));
  });
}

// ---------------------------------------------------------------------------
// One bot
// ---------------------------------------------------------------------------

function createBot(index, roomCode) {
  const socket = io(URL, { transports: ['websocket'] });
  let session = null; // { roomCode, playerToken }
  let name = BOT_NAMES[index % BOT_NAMES.length];
  const started = new Set(); // actions already scheduled, so we never double-submit

  socket.on('connect', async () => {
    // Reconnect support, just like a phone: rejoin with our token.
    if (session) {
      await request(socket, EVENTS.PLAYER_REJOIN, session);
      return;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await request(socket, EVENTS.PLAYER_JOIN, { roomCode, name });
      if (res.ok) {
        session = { roomCode: res.roomCode, playerToken: res.playerToken };
        log(`${name} joined ${res.roomCode}`);
        // Show off the avatar picker once.
        request(socket, EVENTS.PLAYER_SET_AVATAR, { avatar: random(AVATARS) });
        return;
      }
      if (/name/i.test(res.error)) {
        name = `${BOT_NAMES[index % BOT_NAMES.length].slice(0, 9)}${attempt + 2}`;
        continue;
      }
      log(`${name} could not join: ${res.error}`);
      socket.close();
      return;
    }
  });

  socket.on(EVENTS.ERROR, ({ message, code }) => {
    log(`${name} got error: ${message}`);
    if (code === 'ROOM_CLOSED' || code === 'REMOVED') socket.close();
  });

  socket.on(EVENTS.ROOM_STATE, (state) => act(state));

  /** Schedules `fn` once per key, after a human-ish delay. */
  function later(key, fn, state) {
    if (started.has(key)) return;
    started.add(key);
    if (LAZY && Math.random() < 0.15) return; // "forgot"
    // Fast mode has 5x shorter timers, so bots hurry up too.
    const delay = (800 + Math.random() * 4500) / (state.fast ? 4 : 1);
    sleep(delay).then(fn);
  }

  function act(state) {
    switch (state.phase) {
      case P.ROUND1_ANSWER:
      case P.ROUND2_ANSWER:
        for (const prompt of state.answer.myPrompts.filter((p) => !p.answered)) {
          later(`${state.gameNumber}-${prompt.id}`, () => {
            request(socket, EVENTS.PLAYER_ANSWER, { promptId: prompt.id, text: random(SILLY_ANSWERS) });
          }, state);
        }
        break;

      case P.ROUND1_VOTE:
      case P.ROUND2_VOTE: {
        const v = state.vote;
        if (v.step === 'vote' && !v.isAuthor && v.myVote === null) {
          later(v.id, () => request(socket, EVENTS.PLAYER_VOTE, { matchupId: v.id, choice: Math.round(Math.random()) }), state);
        }
        break;
      }

      case P.FINAL_ANSWER:
        if (!state.finalAnswer.answered) {
          later(`${state.gameNumber}-final-answer`, () => {
            request(socket, EVENTS.PLAYER_ANSWER, {
              promptId: state.finalAnswer.prompt.id,
              text: random(SILLY_ANSWERS),
            });
          }, state);
        }
        break;

      case P.FINAL_VOTE: {
        const fv = state.finalVote;
        if (fv.canVote && !fv.myVotes) {
          const choices = fv.ballot.filter((b) => b.id !== fv.myAnswerId).map((b) => b.id);
          const answerIds = Array.from({ length: LIMITS.FINAL_VOTES }, () => random(choices));
          later(`${state.gameNumber}-final-vote`, () => request(socket, EVENTS.PLAYER_FINAL_VOTE, { answerIds }), state);
        }
        break;
      }
    }
  }

  return socket;
}

// ---------------------------------------------------------------------------
// "NEW" mode: a headless host that runs a whole fast game by itself
// ---------------------------------------------------------------------------

async function runHeadlessGame() {
  const host = io(URL, { transports: ['websocket'] });
  await new Promise((resolve) => host.once('connect', resolve));
  const res = await request(host, EVENTS.HOST_CREATE, { fast: true });
  if (!res.ok) throw new Error(res.error);
  log(`created fast-mode room ${res.roomCode}`);

  let lastPhase = null;
  let startedGame = false;
  host.on(EVENTS.ROOM_STATE, async (state) => {
    if (state.phase !== lastPhase) {
      log(`phase: ${state.phase}`);
      lastPhase = state.phase;
    }
    if (state.phase === P.LOBBY && !startedGame && state.players.length === count) {
      startedGame = true;
      const start = await request(host, EVENTS.HOST_START, {});
      if (!start.ok) log(`start failed: ${start.error}`);
    }
    if (state.phase === P.GAME_OVER) {
      log('final standings:');
      for (const s of state.gameOver.standings) {
        const p = state.players.find((pl) => pl.id === s.id);
        log(`  #${s.rank} ${p.avatar} ${p.name}: ${s.score}`);
      }
      process.exit(0);
    }
  });

  for (let i = 0; i < count; i++) {
    createBot(i, res.roomCode);
    await sleep(150);
  }
}

if (roomArg === 'NEW') {
  if (count < LIMITS.MIN_PLAYERS) {
    console.log(`NEW mode needs at least ${LIMITS.MIN_PLAYERS} bots.`);
    process.exit(1);
  }
  runHeadlessGame().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  log(`connecting ${count} bot(s) to room ${roomArg} at ${URL}`);
  for (let i = 0; i < count; i++) {
    createBot(i, roomArg);
    await sleep(200);
  }
}
