/**
 * shared/clock.js — countdowns based on the SERVER's clock.
 *
 * Phone clocks are often a few seconds off. Every room:state message carries
 * `serverNow`, so we remember the difference between the server's clock and
 * ours and correct for it. Clients only DISPLAY time; the server alone
 * decides when a phase ends.
 */

let offset = 0; // serverTime - localTime, in ms

export function syncClock(serverNow) {
  if (typeof serverNow === 'number') offset = serverNow - Date.now();
}

export function serverTime() {
  return Date.now() + offset;
}

/** Whole seconds left until `endsAt` (rounded up), or null if there's no timer. */
export function secondsLeft(endsAt) {
  if (endsAt == null) return null;
  return Math.max(0, Math.ceil((endsAt - serverTime()) / 1000));
}

/** 0 → 1 progress through the current step, or null if there's no timer. */
export function progress(startedAt, endsAt) {
  if (endsAt == null || startedAt == null || endsAt <= startedAt) return null;
  return Math.min(1, Math.max(0, (serverTime() - startedAt) / (endsAt - startedAt)));
}
