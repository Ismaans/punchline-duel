/**
 * shared/constants.js — every tweakable number in the game lives here.
 *
 * Imported by the server (game rules, timers) AND the browser (UI limits like
 * the 80-character counter), so both sides always agree.
 */

/** The phases of one game, in order. The server moves between these. */
export const PHASES = Object.freeze({
  LOBBY: 'LOBBY',
  INTRO: 'INTRO',
  ROUND1_ANSWER: 'ROUND1_ANSWER',
  ROUND1_VOTE: 'ROUND1_VOTE',
  ROUND1_SCORES: 'ROUND1_SCORES',
  ROUND2_ANSWER: 'ROUND2_ANSWER',
  ROUND2_VOTE: 'ROUND2_VOTE',
  ROUND2_SCORES: 'ROUND2_SCORES',
  FINAL_ANSWER: 'FINAL_ANSWER',
  FINAL_VOTE: 'FINAL_VOTE',
  FINAL_RESULTS: 'FINAL_RESULTS',
  GAME_OVER: 'GAME_OVER',
});

/**
 * How long each phase (or step within a phase) lasts, in milliseconds.
 * Add ?fast=1 to the host URL to divide all of these by FAST_MODE_DIVISOR.
 */
export const DURATIONS = Object.freeze({
  INTRO: 9_000,
  ANSWER: 90_000, // rounds 1 and 2
  VOTE: 20_000, // per matchup
  MATCHUP_REVEAL: 7_000, // vote counts + authors on screen (~5s pause after the animation)
  SCORES: 10_000, // leaderboard between rounds
  FINAL_ANSWER: 90_000,
  FINAL_VOTE: 30_000,
  FINAL_REVEAL_STEP: 4_000, // each final-round answer reveal
  FINAL_REVEAL_LAST: 7_000, // the last (most-voted) answer gets extra time
});

export const FAST_MODE_DIVISOR = 5;

export const LIMITS = Object.freeze({
  MIN_PLAYERS: 3,
  MAX_PLAYERS: 8,
  NAME_MAX: 12,
  ANSWER_MAX: 80,
  CUSTOM_PROMPT_MIN: 5,
  CUSTOM_PROMPT_MAX: 120,
  MAX_CUSTOM_PROMPTS: 30,
  FINAL_VOTES: 3,
  ROOM_CODE_LENGTH: 4,
});

export const SCORING = Object.freeze({
  BASE: Object.freeze({ 1: 1000, 2: 2000 }),
  SWEEP_BONUS: Object.freeze({ 1: 250, 2: 500 }),
  FINAL_POINTS_PER_VOTE: 300,
});

/** Server housekeeping. */
export const ROOM_TIMEOUTS = Object.freeze({
  IDLE_MS: 30 * 60 * 1000, // delete a room after 30 minutes with no activity
  HOST_GONE_MS: 2 * 60 * 1000, // ...or 2 minutes after the host screen disconnects
  CLEANUP_INTERVAL_MS: 30 * 1000,
  // A phone that just dropped (e.g. someone hit refresh) is still waited for
  // this long before "everyone's done" lets the game skip ahead without them.
  RECONNECT_GRACE_MS: 15 * 1000,
});

export const RATE_LIMIT = Object.freeze({
  EVENTS_PER_SECOND: 10,
});

/** What the screens show in place of an answer that never arrived. */
export const NO_ANSWER_TEXT = '[no answer]';

export const AVATARS = Object.freeze([
  '🦊', '🐸', '🐙', '🦄', '🐼', '🐯', '🦁', '🐵',
  '🐧', '🦉', '🐢', '🦖', '🐝', '🦀', '🐳', '🦩',
  '🍕', '🌮', '🍩', '🥑', '👽', '🤖', '👻', '🎃',
]);

/** One color per player slot (8 max), chosen to be distinct on a dark background. */
export const COLORS = Object.freeze([
  '#ff4f6d', // red
  '#ff9f1c', // orange
  '#ffe14d', // yellow
  '#3ddc97', // green
  '#2ec4f1', // cyan
  '#8f7bff', // violet
  '#ff7ad9', // pink
  '#b8f04a', // lime
]);

/** Returns true for phases where players are writing answers. */
export function isAnswerPhase(phase) {
  return phase === PHASES.ROUND1_ANSWER || phase === PHASES.ROUND2_ANSWER || phase === PHASES.FINAL_ANSWER;
}

/** Returns 1 or 2 for round phases, 3 for the final round, 0 otherwise. */
export function roundOf(phase) {
  if (phase.startsWith('ROUND1')) return 1;
  if (phase.startsWith('ROUND2')) return 2;
  if (phase.startsWith('FINAL')) return 3;
  return 0;
}
