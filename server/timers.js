/**
 * server/timers.js — server-authoritative phase timers.
 *
 * The game state stores `phaseEndsAt` (a timestamp). This module turns that
 * into a real setTimeout that fires when the time is up. Clients only use
 * phaseEndsAt to draw a countdown; they never decide when a phase ends.
 *
 * One timer per room. Scheduling a new one replaces the old one.
 */

/** room code → { handle, stepId } */
const timers = new Map();

/**
 * Makes sure exactly one timer is pending for this room's current step.
 *
 * @param {string} code             room code
 * @param {number | null} endsAt    when the step ends (ms timestamp), or null for no timer
 * @param {number} stepId           identifies the step, so we don't reschedule needlessly
 * @param {(stepId: number) => void} onExpire  called when the time is up
 */
export function scheduleTimer(code, endsAt, stepId, onExpire) {
  const existing = timers.get(code);
  if (existing && existing.stepId === stepId) return; // already scheduled for this step
  clearTimer(code);
  if (endsAt === null) return;

  // setTimeout can't take a negative delay; clamp to "right away".
  const delay = Math.max(0, endsAt - Date.now());
  const handle = setTimeout(() => {
    timers.delete(code);
    onExpire(stepId);
  }, delay);
  timers.set(code, { handle, stepId });
}

export function clearTimer(code) {
  const existing = timers.get(code);
  if (existing) clearTimeout(existing.handle);
  timers.delete(code);
}
