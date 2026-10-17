/**
 * server/game.js — PURE game logic. The rules of Punchline Duel live here.
 *
 * "Pure" means:
 *   - No Socket.IO, no timers, no Date.now(), no console.log.
 *   - Everything this file needs (the current time, a random-number function,
 *     the prompt bank) is passed in through a `ctx` ("context") object.
 *   - applyAction() never modifies the state you give it. It makes a deep
 *     copy, changes the copy, and returns it.
 *
 * Because of that, the unit tests can feed in fake times and a predictable
 * random function and check exactly what happens.
 *
 * The main entry points:
 *   createGameState()            → a fresh lobby
 *   applyAction(state, action, ctx) → { ok, state, error }
 *   viewFor(state, viewer)       → what ONE client is allowed to see
 */

import {
  PHASES as P,
  DURATIONS,
  LIMITS,
  SCORING,
  AVATARS,
  COLORS,
  ROOM_TIMEOUTS,
} from '../public/shared/constants.js';

// ---------------------------------------------------------------------------
// State machine: which phase may follow which.
// ---------------------------------------------------------------------------

export const TRANSITIONS = Object.freeze({
  [P.LOBBY]: [P.INTRO],
  [P.INTRO]: [P.ROUND1_ANSWER],
  [P.ROUND1_ANSWER]: [P.ROUND1_VOTE],
  [P.ROUND1_VOTE]: [P.ROUND1_SCORES],
  [P.ROUND1_SCORES]: [P.ROUND2_ANSWER],
  [P.ROUND2_ANSWER]: [P.ROUND2_VOTE],
  [P.ROUND2_VOTE]: [P.ROUND2_SCORES],
  [P.ROUND2_SCORES]: [P.FINAL_ANSWER],
  [P.FINAL_ANSWER]: [P.FINAL_VOTE],
  [P.FINAL_VOTE]: [P.FINAL_RESULTS],
  [P.FINAL_RESULTS]: [P.GAME_OVER],
  // Play Again (same players) → INTRO; New Game → back to LOBBY.
  [P.GAME_OVER]: [P.INTRO, P.LOBBY],
});

export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// Creating state
// ---------------------------------------------------------------------------

/**
 * @param {{ speed?: number }} options  speed > 1 shortens every timer (fast mode).
 */
export function createGameState({ speed = 1 } = {}) {
  return {
    phase: P.LOBBY,
    phaseEndsAt: null, // timestamp (ms) when the current phase/step ends, or null
    phaseStartedAt: null, // when it began (lets clients draw progress bars)
    stepId: 0, // bumps on every phase or step change; lets timers detect staleness
    speed,
    gameNumber: 0,
    players: [], // { id, name, color, avatar, score, roundStartScore, connected, disconnectedAt }
    vipId: null,
    customPrompts: [], // { id, text }
    nextCustomId: 1,
    usedPromptIds: [], // across every game in this room
    gamePromptIds: [], // just this game (never reused within one game)
    pairHistory: [], // "a|b" pairs who faced off already this game
    round: null, // rounds 1 and 2 (see startRound)
    final: null, // final round (see startFinal)
  };
}

// ---------------------------------------------------------------------------
// The one way to change state
// ---------------------------------------------------------------------------

/**
 * Applies one action and returns the result.
 *
 * @param state  current game state (NOT modified)
 * @param action an object like { type: 'answer', playerId, promptId, text }
 * @param ctx    { now: number, rng: () => number, prompts: PromptBank[] }
 * @returns {{ ok: true, state } | { ok: false, error: string, state }}
 *          On failure, `state` is the original, unchanged state.
 */
export function applyAction(state, action, ctx = {}) {
  const handler = HANDLERS[action?.type];
  if (!handler) return { ok: false, error: 'Unknown action.', state };

  const c = {
    now: ctx.now ?? 0,
    rng: ctx.rng ?? Math.random,
    prompts: ctx.prompts ?? [],
  };

  // structuredClone makes a deep copy, so changes below can't leak into the
  // caller's `state` if we end up rejecting the action.
  const next = structuredClone(state);
  try {
    const error = handler(next, action, c);
    if (error) return { ok: false, error, state };

    // If everyone who's connected has finished, skip ahead instead of
    // waiting out the clock.
    settle(next, c);
  } catch (bug) {
    // A thrown error means a bug in this file. Reject the action (keeping the
    // old state) instead of crashing the whole server; `bug` gets logged.
    return { ok: false, error: 'Something went wrong on the server.', state, bug };
  }
  return { ok: true, state: next };
}

// Each handler modifies `state` (a copy) and returns an error string to
// reject the action, or nothing to accept it.
const HANDLERS = {
  join(state, { playerId, name }, ctx) {
    if (state.phase !== P.LOBBY) return 'Game already in progress.';
    if (state.players.length >= LIMITS.MAX_PLAYERS) {
      return `This room is full (${LIMITS.MAX_PLAYERS} players max).`;
    }
    const clean = cleanText(name);
    if (!clean) return 'Please enter a name.';
    if (clean.length > LIMITS.NAME_MAX) return `Names can be at most ${LIMITS.NAME_MAX} characters.`;
    if (state.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      return 'Someone in this room already has that name.';
    }
    if (!playerId || findPlayer(state, playerId)) return 'Could not join. Please try again.';

    const usedColors = new Set(state.players.map((p) => p.color));
    const usedAvatars = new Set(state.players.map((p) => p.avatar));
    state.players.push({
      id: playerId,
      name: clean,
      color: pick(COLORS.filter((c) => !usedColors.has(c)), ctx.rng),
      avatar: pick(AVATARS.filter((a) => !usedAvatars.has(a)), ctx.rng),
      score: 0,
      roundStartScore: 0,
      connected: true,
      disconnectedAt: null,
    });
    if (!state.vipId) state.vipId = playerId;
  },

  kick(state, { playerId }) {
    if (state.phase !== P.LOBBY) return 'Players can only be removed in the lobby.';
    if (!findPlayer(state, playerId)) return 'That player is not in the room.';
    removePlayer(state, playerId);
  },

  leave(state, { playerId }) {
    if (state.phase !== P.LOBBY) return 'You can only leave from the lobby.';
    if (!findPlayer(state, playerId)) return 'You are not in this room.';
    removePlayer(state, playerId);
  },

  setConnected(state, { playerId, connected }, ctx) {
    const player = findPlayer(state, playerId);
    if (!player) return 'Unknown player.';
    player.connected = Boolean(connected);
    player.disconnectedAt = player.connected ? null : ctx.now;
  },

  /**
   * Does nothing except re-check "is everyone done?" (applyAction always
   * does that). The server sends this when a reconnect grace period ends.
   */
  tick() {},

  setAvatar(state, { playerId, avatar }) {
    if (state.phase !== P.LOBBY) return 'You can only change your avatar in the lobby.';
    const player = findPlayer(state, playerId);
    if (!player) return 'You are not in this room.';
    if (!AVATARS.includes(avatar)) return 'That avatar is not available.';
    player.avatar = avatar;
  },

  addPrompt(state, { text }) {
    if (state.phase !== P.LOBBY) return 'Custom prompts can only be added in the lobby.';
    const clean = cleanText(text);
    if (clean.length < LIMITS.CUSTOM_PROMPT_MIN) return 'That prompt is too short.';
    if (clean.length > LIMITS.CUSTOM_PROMPT_MAX) {
      return `Prompts can be at most ${LIMITS.CUSTOM_PROMPT_MAX} characters.`;
    }
    if (state.customPrompts.length >= LIMITS.MAX_CUSTOM_PROMPTS) {
      return `That's the limit of ${LIMITS.MAX_CUSTOM_PROMPTS} custom prompts.`;
    }
    if (state.customPrompts.some((p) => p.text.toLowerCase() === clean.toLowerCase())) {
      return 'You already added that prompt.';
    }
    state.customPrompts.push({ id: `c${state.nextCustomId}`, text: clean });
    state.nextCustomId += 1;
  },

  removePrompt(state, { promptId }) {
    if (state.phase !== P.LOBBY) return 'Custom prompts can only be changed in the lobby.';
    const before = state.customPrompts.length;
    state.customPrompts = state.customPrompts.filter((p) => p.id !== promptId);
    if (state.customPrompts.length === before) return 'That prompt does not exist.';
  },

  /** byPlayerId is set when a phone (the VIP) starts; omitted when the host does. */
  start(state, { byPlayerId }, ctx) {
    if (state.phase !== P.LOBBY) return 'The game has already started.';
    if (byPlayerId !== undefined && byPlayerId !== state.vipId) {
      return 'Only the VIP can start the game.';
    }
    if (state.players.length < LIMITS.MIN_PLAYERS) {
      return `Need at least ${LIMITS.MIN_PLAYERS} players to start (you have ${state.players.length}).`;
    }
    startNewGame(state, ctx);
  },

  playAgain(state, { samePlayers }, ctx) {
    if (state.phase !== P.GAME_OVER) return 'You can only do that after a game ends.';
    if (samePlayers) {
      if (state.players.length < LIMITS.MIN_PLAYERS) return 'Not enough players for another game.';
      startNewGame(state, ctx);
      return;
    }
    // New Game: back to the lobby. People who left are dropped so the
    // lobby only shows who's actually here; new people can join again.
    for (const p of state.players.filter((pl) => !pl.connected)) removePlayer(state, p.id);
    resetForNewGame(state);
    goTo(state, P.LOBBY, null, ctx);
  },

  answer(state, { playerId, promptId, text }) {
    if (!findPlayer(state, playerId)) return 'You are not in this game.';
    const clean = cleanText(text);

    if (state.phase === P.ROUND1_ANSWER || state.phase === P.ROUND2_ANSWER) {
      const prompt = state.round.prompts.find((p) => p.id === promptId);
      if (!prompt || !prompt.playerIds.includes(playerId)) return "That prompt isn't one of yours.";
      const answers = (state.round.answers[promptId] ??= {});
      if (playerId in answers) return 'You already answered that one.';
      const lengthError = checkAnswerLength(clean);
      if (lengthError) return lengthError;
      answers[playerId] = clean;
      return;
    }

    if (state.phase === P.FINAL_ANSWER) {
      if (promptId !== state.final.prompt.id) return "That's not the final prompt.";
      if (playerId in state.final.answers) return 'You already answered.';
      const lengthError = checkAnswerLength(clean);
      if (lengthError) return lengthError;
      state.final.answers[playerId] = clean;
      return;
    }

    return 'Answering is closed right now.';
  },

  vote(state, { playerId, matchupId, choice }) {
    if (!isRoundVotePhase(state.phase) || state.round.step !== 'vote') {
      return 'Voting is closed right now.';
    }
    if (!findPlayer(state, playerId)) return 'You are not in this game.';
    const matchup = currentMatchup(state);
    if (matchup.id !== matchupId) return 'That matchup is already over.';
    if (matchup.authorIds.includes(playerId)) return "You can't vote on your own answer.";
    if (playerId in matchup.votes) return 'You already voted.';
    if (choice !== 0 && choice !== 1) return 'Pick one of the two answers.';
    matchup.votes[playerId] = choice;
  },

  finalVote(state, { playerId, answerIds }) {
    if (state.phase !== P.FINAL_VOTE) return 'Final voting is closed right now.';
    if (!findPlayer(state, playerId)) return 'You are not in this game.';
    if (playerId in state.final.votes) return 'You already voted.';
    const error = validateFinalVote(state.final.ballot, playerId, answerIds);
    if (error) return error;
    state.final.votes[playerId] = [...answerIds];
  },

  /**
   * Sent by the server's timer when phaseEndsAt is reached. stepId guards
   * against an old timer firing after the game already moved on.
   */
  advance(state, { stepId }, ctx) {
    if (stepId !== undefined && stepId !== state.stepId) return 'That timer is out of date.';
    if (state.phaseEndsAt === null) return `The ${state.phase} phase has no timer.`;
    advanceStep(state, ctx);
  },
};

// ---------------------------------------------------------------------------
// Phase changes
// ---------------------------------------------------------------------------

/** Moves to a new phase. Throws on an illegal transition (that's a bug). */
function goTo(state, phase, duration, ctx) {
  if (!canTransition(state.phase, phase)) {
    throw new Error(`Illegal phase transition: ${state.phase} → ${phase}`);
  }
  state.phase = phase;
  setStep(state, duration, ctx);
}

/** Starts a new timed step (a new phase, or e.g. the next matchup). */
function setStep(state, duration, ctx) {
  state.stepId += 1;
  state.phaseStartedAt = ctx.now;
  state.phaseEndsAt = duration == null ? null : ctx.now + Math.round(duration / state.speed);
}

/** What happens when the current phase's timer runs out (or everyone's done). */
function advanceStep(state, ctx) {
  switch (state.phase) {
    case P.INTRO:
      return startRound(state, 1, ctx);
    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER:
      return enterVote(state, ctx);
    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE:
      return state.round.step === 'vote' ? revealMatchup(state, ctx) : nextMatchup(state, ctx);
    case P.ROUND1_SCORES:
      return startRound(state, 2, ctx);
    case P.ROUND2_SCORES:
      return startFinal(state, ctx);
    case P.FINAL_ANSWER:
      return enterFinalVote(state, ctx);
    case P.FINAL_VOTE:
      return enterFinalResults(state, ctx);
    case P.FINAL_RESULTS:
      return nextFinalReveal(state, ctx);
    default:
      throw new Error(`Nothing to advance in ${state.phase}`);
  }
}

function resetForNewGame(state) {
  for (const p of state.players) {
    p.score = 0;
    p.roundStartScore = 0;
  }
  state.round = null;
  state.final = null;
  state.pairHistory = [];
  state.gamePromptIds = [];
}

function startNewGame(state, ctx) {
  resetForNewGame(state);
  state.gameNumber += 1;
  goTo(state, P.INTRO, DURATIONS.INTRO, ctx);
}

// ---------------------------------------------------------------------------
// Rounds 1 and 2
// ---------------------------------------------------------------------------

function startRound(state, number, ctx) {
  const playerIds = state.players.map((p) => p.id);
  const prompts = drawPrompts(state, ctx, playerIds.length);
  const assigned = assignPrompts(playerIds, prompts, ctx.rng, new Set(state.pairHistory));
  for (const prompt of assigned) state.pairHistory.push(pairKey(...prompt.playerIds));

  state.round = {
    number,
    prompts: assigned, // { id, text, playerIds: [a, b] }
    answers: {}, // promptId → { playerId: text }
    matchups: [],
    matchupIndex: 0,
    step: null, // during voting: 'vote' or 'reveal'
  };
  for (const p of state.players) p.roundStartScore = p.score;
  goTo(state, number === 1 ? P.ROUND1_ANSWER : P.ROUND2_ANSWER, DURATIONS.ANSWER, ctx);
}

/**
 * Gives each prompt to exactly 2 players and each player exactly 2 prompts.
 *
 * Shuffle the players into a circle, then prompt i goes to the players in
 * seats i and i+1 (wrapping around). Each player sits in two neighboring
 * pairs, so they get 2 prompts. Their two opponents are their left and right
 * neighbors, which are different people whenever there are 3+ players, so
 * nobody faces the same opponent twice in one round.
 *
 * `avoidPairs` holds pairs that already faced off (in round 1). We try a few
 * shuffles and keep the one that repeats the fewest of them.
 *
 * @returns prompts with a `playerIds: [a, b]` field added
 */
export function assignPrompts(playerIds, prompts, rng = Math.random, avoidPairs = new Set()) {
  const n = playerIds.length;
  if (n < 2) throw new Error('Need at least 2 players to assign prompts.');
  if (prompts.length !== n) throw new Error('Need exactly one prompt per player.');

  let best = null;
  let bestRepeats = Infinity;
  for (let attempt = 0; attempt < 25 && bestRepeats > 0; attempt++) {
    const seats = shuffle(playerIds, rng);
    const repeats = seats.filter((id, i) => avoidPairs.has(pairKey(id, seats[(i + 1) % n]))).length;
    if (repeats < bestRepeats) {
      best = seats;
      bestRepeats = repeats;
    }
  }
  return prompts.map((prompt, i) => ({ ...prompt, playerIds: [best[i], best[(i + 1) % n]] }));
}

/** Picks `count` unused prompts: custom ones first, then the bank. */
function drawPrompts(state, ctx, count) {
  const usedInGame = new Set(state.gamePromptIds);
  let used = new Set(state.usedPromptIds);
  const available = () => [
    ...shuffle(state.customPrompts.filter((p) => !used.has(p.id)), ctx.rng),
    ...shuffle(ctx.prompts.filter((p) => !p.final && !used.has(p.id)), ctx.rng),
  ];

  let pool = available();
  if (pool.length < count) {
    // After many games in one room the bank runs dry. Allow prompts from
    // earlier games again, but never repeat one within this game.
    state.usedPromptIds = [...usedInGame];
    used = usedInGame;
    pool = available();
  }
  if (pool.length < count) throw new Error('Not enough prompts left in the bank.');

  const chosen = shuffle(pool.slice(0, count), ctx.rng).map(({ id, text }) => ({ id, text }));
  markUsed(state, chosen);
  // Used custom prompts leave the lobby list, so it only shows ones still to come.
  const chosenIds = new Set(chosen.map((p) => p.id));
  state.customPrompts = state.customPrompts.filter((p) => !chosenIds.has(p.id));
  return chosen;
}

function drawFinalPrompt(state, ctx) {
  const usedInGame = new Set(state.gamePromptIds);
  const used = new Set(state.usedPromptIds);
  const finals = ctx.prompts.filter((p) => p.final);
  const candidates =
    [finals.filter((p) => !used.has(p.id)), finals.filter((p) => !usedInGame.has(p.id))].find(
      (list) => list.length > 0,
    ) ?? ctx.prompts.filter((p) => !usedInGame.has(p.id)); // no finals at all: use anything

  const prompt = pick(candidates, ctx.rng);
  if (!prompt) throw new Error('No prompt available for the final round.');
  markUsed(state, [prompt]);
  return { id: prompt.id, text: prompt.text };
}

function markUsed(state, prompts) {
  for (const { id } of prompts) {
    state.usedPromptIds.push(id);
    state.gamePromptIds.push(id);
  }
}

/** Builds the matchups from the answers and starts voting on the first one. */
function enterVote(state, ctx) {
  const round = state.round;
  round.matchups = [];
  for (const prompt of round.prompts) {
    const answers = prompt.playerIds.map((id) => round.answers[prompt.id]?.[id] ?? null);
    if (answers[0] === null && answers[1] === null) continue; // nobody answered: skip it
    round.matchups.push({
      id: `g${state.gameNumber}-r${round.number}-${prompt.id}`,
      promptText: prompt.text,
      authorIds: [...prompt.playerIds],
      answers, // [textA | null, textB | null]
      kind: matchupKind(answers),
      votes: {}, // voterId → 0 or 1
      result: null,
    });
  }
  round.matchupIndex = 0;
  goTo(state, round.number === 1 ? P.ROUND1_VOTE : P.ROUND2_VOTE, null, ctx);

  if (round.matchups.length === 0) return enterScores(state, ctx);
  startMatchup(state, ctx);
}

function startMatchup(state, ctx) {
  if (currentMatchup(state).kind === 'normal') {
    state.round.step = 'vote';
    setStep(state, DURATIONS.VOTE, ctx);
  } else {
    // Mind Meld or only one answer: nothing to vote on, go straight to the reveal.
    revealMatchup(state, ctx);
  }
}

function revealMatchup(state, ctx) {
  const matchup = currentMatchup(state);
  const voterIds = [[], []];
  for (const [voterId, choice] of Object.entries(matchup.votes)) voterIds[choice].push(voterId);

  const score = scoreMatchup({
    answers: matchup.answers,
    votes: [voterIds[0].length, voterIds[1].length],
    roundNumber: state.round.number,
  });
  matchup.result = { ...score, voterIds };
  matchup.authorIds.forEach((id, i) => {
    findPlayer(state, id).score += score.points[i];
  });

  state.round.step = 'reveal';
  setStep(state, DURATIONS.MATCHUP_REVEAL, ctx);
}

function nextMatchup(state, ctx) {
  state.round.matchupIndex += 1;
  if (state.round.matchupIndex < state.round.matchups.length) startMatchup(state, ctx);
  else enterScores(state, ctx);
}

function enterScores(state, ctx) {
  state.round.step = null;
  goTo(state, state.round.number === 1 ? P.ROUND1_SCORES : P.ROUND2_SCORES, DURATIONS.SCORES, ctx);
}

/**
 * Scores one matchup from rounds 1/2.
 *
 * @param answers     [textA | null, textB | null]   (null = no answer)
 * @param votes       [votesForA, votesForB]
 * @param roundNumber 1 or 2
 * @returns {{ kind, points: [number, number], sweep: 0 | 1 | null }}
 */
export function scoreMatchup({ answers, votes, roundNumber }) {
  const base = SCORING.BASE[roundNumber];
  const bonus = SCORING.SWEEP_BONUS[roundNumber];
  const [a, b] = answers;

  if (a === null && b === null) return { kind: 'skipped', points: [0, 0], sweep: null };
  if (a === null) return { kind: 'forfeit', points: [0, base], sweep: null };
  if (b === null) return { kind: 'forfeit', points: [base, 0], sweep: null };
  if (isMindMeld(a, b)) return { kind: 'mindmeld', points: [0, 0], sweep: null };

  const total = votes[0] + votes[1];
  if (total === 0) {
    const half = roundTo10(base / 2);
    return { kind: 'novotes', points: [half, half], sweep: null };
  }

  const points = votes.map((v) => roundTo10((base * v) / total));
  let sweep = null;
  if (votes[0] === total) sweep = 0;
  if (votes[1] === total) sweep = 1;
  if (sweep !== null) points[sweep] += bonus;
  return { kind: 'normal', points, sweep };
}

function matchupKind(answers) {
  if (answers[0] === null || answers[1] === null) return 'forfeit';
  if (isMindMeld(answers[0], answers[1])) return 'mindmeld';
  return 'normal';
}

/** Two answers are a Mind Meld if they match ignoring case and outer spaces. */
export function isMindMeld(a, b) {
  return cleanText(a).toLowerCase() === cleanText(b).toLowerCase();
}

// ---------------------------------------------------------------------------
// Final round
// ---------------------------------------------------------------------------

function startFinal(state, ctx) {
  state.round = null;
  state.final = {
    prompt: drawFinalPrompt(state, ctx),
    answers: {}, // playerId → text
    ballot: [], // { id, authorId, text } in a shuffled order (built when voting starts)
    votes: {}, // voterId → [answerId, answerId, answerId]
    results: [], // built when voting ends, sorted fewest → most votes
    revealed: 0, // how many results the host is showing so far
  };
  for (const p of state.players) p.roundStartScore = p.score;
  goTo(state, P.FINAL_ANSWER, DURATIONS.FINAL_ANSWER, ctx);
}

function enterFinalVote(state, ctx) {
  // Ballot ids (f1, f2, ...) come from the shuffled order, so they say
  // nothing about who wrote what.
  const entries = shuffle(Object.entries(state.final.answers), ctx.rng);
  state.final.ballot = entries.map(([authorId, text], i) => ({ id: `f${i + 1}`, authorId, text }));
  goTo(state, P.FINAL_VOTE, DURATIONS.FINAL_VOTE, ctx);
  if (state.final.ballot.length === 0) enterFinalResults(state, ctx);
}

/**
 * Checks one player's final-round ballot.
 * @returns an error message, or null if the vote is valid
 */
export function validateFinalVote(ballot, voterId, answerIds) {
  if (!Array.isArray(answerIds) || answerIds.length !== LIMITS.FINAL_VOTES) {
    return `Use exactly ${LIMITS.FINAL_VOTES} votes.`;
  }
  for (const id of answerIds) {
    const entry = ballot.find((b) => b.id === id);
    if (!entry) return "One of those answers doesn't exist.";
    if (entry.authorId === voterId) return "You can't vote for your own answer.";
  }
  return null;
}

function enterFinalResults(state, ctx) {
  const final = state.final;
  const voterIds = Object.fromEntries(final.ballot.map((b) => [b.id, []]));
  for (const [voterId, ids] of Object.entries(final.votes)) {
    for (const id of ids) voterIds[id].push(voterId);
  }
  final.results = final.ballot
    .map((b) => ({
      ...b,
      votes: voterIds[b.id].length,
      points: voterIds[b.id].length * SCORING.FINAL_POINTS_PER_VOTE,
      voterIds: voterIds[b.id], // one entry per vote, so stacked votes repeat
    }))
    .sort((x, y) => x.votes - y.votes); // fewest first, for drama

  goTo(state, P.FINAL_RESULTS, null, ctx);
  if (final.results.length === 0) return enterGameOver(state, ctx);
  final.revealed = 1;
  setStep(state, final.results.length === 1 ? DURATIONS.FINAL_REVEAL_LAST : DURATIONS.FINAL_REVEAL_STEP, ctx);
}

function nextFinalReveal(state, ctx) {
  const final = state.final;
  if (final.revealed >= final.results.length) return enterGameOver(state, ctx);
  final.revealed += 1;
  const isLast = final.revealed === final.results.length;
  setStep(state, isLast ? DURATIONS.FINAL_REVEAL_LAST : DURATIONS.FINAL_REVEAL_STEP, ctx);
}

function enterGameOver(state, ctx) {
  for (const result of state.final.results) {
    findPlayer(state, result.authorId).score += result.points;
  }
  goTo(state, P.GAME_OVER, null, ctx);
}

// ---------------------------------------------------------------------------
// Advancing early
// ---------------------------------------------------------------------------

/** Keeps advancing while the current step is only waiting on people who are done. */
function settle(state, ctx) {
  for (let guard = 0; guard < 100 && everyoneIsDone(state, ctx); guard++) {
    advanceStep(state, ctx);
  }
}

/**
 * True when every PRESENT player who still owes something has submitted.
 * "Present" = connected, or disconnected less than RECONNECT_GRACE_MS ago
 * (so hitting refresh doesn't make the game skip your turn). Players who
 * stay gone are never waited for; the timer handles them.
 * If nobody is present we don't rush ahead; we let the timer run so a
 * Wi-Fi blip for everyone doesn't fast-forward the whole game.
 */
function everyoneIsDone(state, ctx) {
  const present = state.players.filter(
    (p) => p.connected || (p.disconnectedAt != null && ctx.now - p.disconnectedAt < ROOM_TIMEOUTS.RECONNECT_GRACE_MS),
  );
  if (present.length === 0) return false;

  switch (state.phase) {
    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER:
      return present.every((p) => hasFinishedRound(state, p.id));
    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE: {
      if (state.round.step !== 'vote') return false;
      const matchup = currentMatchup(state);
      return present
        .filter((p) => !matchup.authorIds.includes(p.id))
        .every((p) => p.id in matchup.votes);
    }
    case P.FINAL_ANSWER:
      return present.every((p) => p.id in state.final.answers);
    case P.FINAL_VOTE:
      return present.every((p) => p.id in state.final.votes || !hasFinalChoices(state, p.id));
    default:
      return false;
  }
}

function hasFinishedRound(state, playerId) {
  return state.round.prompts
    .filter((prompt) => prompt.playerIds.includes(playerId))
    .every((prompt) => playerId in (state.round.answers[prompt.id] ?? {}));
}

/** Can this player vote in the final at all? (Not if the only answer is their own.) */
function hasFinalChoices(state, playerId) {
  return state.final.ballot.some((b) => b.authorId !== playerId);
}

// ---------------------------------------------------------------------------
// Views: what each client is allowed to see
// ---------------------------------------------------------------------------

/**
 * Builds the state for ONE client. Secrets are left out:
 *  - nobody sees who wrote an answer until it's revealed
 *  - players only see their own prompts
 *
 * @param viewer { role: 'host' } or { role: 'player', playerId }
 */
export function viewFor(state, viewer) {
  const viewerId = viewer.role === 'player' ? viewer.playerId : null;
  const view = {
    phase: state.phase,
    phaseEndsAt: state.phaseEndsAt,
    phaseStartedAt: state.phaseStartedAt,
    stepId: state.stepId,
    gameNumber: state.gameNumber,
    fast: state.speed > 1,
    vipId: state.vipId,
    players: state.players.map(({ id, name, color, avatar, score, roundStartScore, connected }) => ({
      id,
      name,
      color,
      avatar,
      score,
      roundStartScore,
      connected,
    })),
    me: viewerId ? { id: viewerId, isVip: state.vipId === viewerId } : null,
  };

  switch (state.phase) {
    case P.LOBBY:
      view.lobby = {
        customPromptCount: state.customPrompts.length,
        // Only the host screen needs the actual list (to show and remove them).
        customPrompts: viewer.role === 'host' ? state.customPrompts.map(({ id, text }) => ({ id, text })) : [],
      };
      break;

    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER: {
      const round = state.round;
      view.answer = {
        roundNumber: round.number,
        waitingOn: state.players.filter((p) => !hasFinishedRound(state, p.id)).map((p) => p.id),
        myPrompts: viewerId
          ? round.prompts
              .filter((p) => p.playerIds.includes(viewerId))
              .map((p) => ({ id: p.id, text: p.text, answered: viewerId in (round.answers[p.id] ?? {}) }))
          : [],
      };
      break;
    }

    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE:
      view.vote = viewMatchup(state, viewerId);
      break;

    case P.ROUND1_SCORES:
    case P.ROUND2_SCORES:
      view.scores = { roundNumber: state.round.number };
      break;

    case P.FINAL_ANSWER:
      view.finalAnswer = {
        prompt: state.final.prompt,
        waitingOn: state.players.filter((p) => !(p.id in state.final.answers)).map((p) => p.id),
        answered: viewerId ? viewerId in state.final.answers : false,
      };
      break;

    case P.FINAL_VOTE: {
      const final = state.final;
      const mine = final.ballot.find((b) => b.authorId === viewerId);
      view.finalVote = {
        promptText: final.prompt.text,
        ballot: final.ballot.map(({ id, text }) => ({ id, text })),
        votedCount: Object.keys(final.votes).length,
        eligibleCount: state.players.filter((p) => hasFinalChoices(state, p.id)).length,
        myAnswerId: mine?.id ?? null,
        myVotes: viewerId ? (final.votes[viewerId] ?? null) : null,
        canVote: viewerId ? hasFinalChoices(state, viewerId) : false,
      };
      break;
    }

    case P.FINAL_RESULTS:
      view.finalResults = {
        promptText: state.final.prompt.text,
        total: state.final.results.length,
        revealed: state.final.results.slice(0, state.final.revealed),
      };
      break;

    case P.GAME_OVER:
      view.gameOver = { standings: standings(state.players) };
      break;
  }
  return view;
}

function viewMatchup(state, viewerId) {
  const round = state.round;
  const matchup = currentMatchup(state);
  const out = {
    id: matchup.id,
    index: round.matchupIndex,
    total: round.matchups.length,
    roundNumber: round.number,
    promptText: matchup.promptText,
    answers: matchup.answers,
    kind: matchup.kind,
    step: round.step,
    votedCount: Object.keys(matchup.votes).length,
    // Count only (not ids): a list of eligible voters would reveal the authors.
    eligibleCount: state.players.length - 2,
  };
  if (viewerId) {
    const authorIndex = matchup.authorIds.indexOf(viewerId);
    out.isAuthor = authorIndex !== -1;
    out.myAnswerIndex = authorIndex === -1 ? null : authorIndex;
    out.myVote = matchup.votes[viewerId] ?? null;
  }
  if (round.step === 'reveal') {
    const { kind, points, sweep, voterIds } = matchup.result;
    out.result = { kind, points, sweep, voterIds, authorIds: matchup.authorIds };
  }
  return out;
}

/** Players sorted by score, with shared ranks for ties (e.g. 1, 2, 2, 4). */
export function standings(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  let rank = 0;
  return sorted.map((p, i) => {
    if (i === 0 || p.score !== sorted[i - 1].score) rank = i + 1;
    return { id: p.id, score: p.score, rank };
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Removes control characters, collapses whitespace, and trims. */
export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkAnswerLength(text) {
  if (!text) return 'Write something first!';
  if (text.length > LIMITS.ANSWER_MAX) return `Answers can be at most ${LIMITS.ANSWER_MAX} characters.`;
  return null;
}

function findPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId);
}

function removePlayer(state, playerId) {
  state.players = state.players.filter((p) => p.id !== playerId);
  if (state.vipId === playerId) {
    // Hand VIP to the earliest-joined player who's still connected.
    state.vipId = (state.players.find((p) => p.connected) ?? state.players[0])?.id ?? null;
  }
}

function isRoundVotePhase(phase) {
  return phase === P.ROUND1_VOTE || phase === P.ROUND2_VOTE;
}

function currentMatchup(state) {
  return state.round.matchups[state.round.matchupIndex];
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function roundTo10(n) {
  return Math.round(n / 10) * 10;
}

/** Fisher–Yates shuffle. Returns a NEW array; the input is untouched. */
export function shuffle(items, rng = Math.random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pick(items, rng) {
  return items[Math.floor(rng() * items.length)];
}
