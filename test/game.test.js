/**
 * Unit tests for server/game.js. Run with: npm test
 *
 * Because game.js is pure, we can pass in a fixed clock and a seeded random
 * number generator, so every run behaves exactly the same.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAction,
  assignPrompts,
  canTransition,
  createGameState,
  HIGHLIGHTS,
  pickHighlights,
  scoreMatchup,
  standings,
  validateFinalVote,
  viewFor,
} from '../server/game.js';
import { PHASES as P, LIMITS, ROOM_TIMEOUTS } from '../public/shared/constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A tiny seeded random generator (mulberry32) so tests are repeatable. */
function seededRng(seed = 42) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROMPTS = Array.from({ length: 60 }, (_, i) => ({
  id: `t${i}`,
  text: `Test prompt ${i}: _____`,
  final: i >= 50,
}));

function makeCtx(now = 1_000_000) {
  return { now, rng: seededRng(7), prompts: PROMPTS };
}

/** Applies an action and fails the test if it was rejected. */
function must(state, action, ctx = makeCtx()) {
  const result = applyAction(state, action, ctx);
  assert.ok(result.ok, `expected ${action.type} to succeed, got: ${result.error}`);
  return result.state;
}

/** Applies an action and fails the test if it was ACCEPTED. Returns the error. */
function mustFail(state, action, ctx = makeCtx()) {
  const result = applyAction(state, action, ctx);
  assert.equal(result.ok, false, `expected ${action.type} to be rejected`);
  assert.equal(result.state, state, 'a rejected action must return the original state');
  return result.error;
}

function lobbyWith(n) {
  let state = createGameState();
  for (let i = 0; i < n; i++) {
    state = must(state, { type: 'join', playerId: `p${i}`, name: `Player${i}` });
  }
  return state;
}

/** A game that has reached the Round 1 answer phase. */
function roundOneWith(n) {
  let state = must(lobbyWith(n), { type: 'start' });
  state = must(state, { type: 'advance', stepId: state.stepId });
  assert.equal(state.phase, P.ROUND1_ANSWER);
  return state;
}

function advance(state) {
  return must(state, { type: 'advance', stepId: state.stepId });
}

function answerAll(state, textFor = (playerId, promptId) => `${playerId} on ${promptId}`) {
  for (const prompt of state.round.prompts) {
    for (const playerId of prompt.playerIds) {
      if (state.phase !== P.ROUND1_ANSWER && state.phase !== P.ROUND2_ANSWER) return state;
      state = must(state, { type: 'answer', playerId, promptId: prompt.id, text: textFor(playerId, prompt.id) });
    }
  }
  return state;
}

function currentMatchup(state) {
  return state.round.matchups[state.round.matchupIndex];
}

// ---------------------------------------------------------------------------
// Prompt assignment
// ---------------------------------------------------------------------------

describe('prompt assignment', () => {
  for (let n = 3; n <= 8; n++) {
    test(`${n} players: 2 prompts each, 2 players per prompt, no rematches`, () => {
      const playerIds = Array.from({ length: n }, (_, i) => `p${i}`);
      const prompts = PROMPTS.slice(0, n);

      // Try many different shuffles, not just one lucky one.
      for (let seed = 1; seed <= 50; seed++) {
        const assigned = assignPrompts(playerIds, prompts, seededRng(seed));
        assert.equal(assigned.length, n);

        const promptsPerPlayer = new Map(playerIds.map((id) => [id, []]));
        for (const prompt of assigned) {
          assert.equal(prompt.playerIds.length, 2, 'each prompt has exactly 2 players');
          const [a, b] = prompt.playerIds;
          assert.notEqual(a, b, 'nobody faces themselves');
          promptsPerPlayer.get(a).push(prompt);
          promptsPerPlayer.get(b).push(prompt);
        }

        for (const [playerId, mine] of promptsPerPlayer) {
          assert.equal(mine.length, 2, `${playerId} has exactly 2 prompts`);
          const opponents = mine.map((p) => p.playerIds.find((id) => id !== playerId));
          assert.notEqual(opponents[0], opponents[1], `${playerId} faces two different opponents`);
        }
      }
    });
  }

  test('no prompt is reused within one game', () => {
    let state = roundOneWith(6);
    const seen = state.round.prompts.map((p) => p.id);

    // Fast-forward to round 2 by letting every timer expire.
    while (state.phase !== P.ROUND2_ANSWER) state = advance(state);
    seen.push(...state.round.prompts.map((p) => p.id));
    while (state.phase !== P.FINAL_ANSWER) state = advance(state);
    seen.push(state.final.prompt.id);

    assert.equal(new Set(seen).size, seen.length);
    assert.ok(PROMPTS.find((p) => p.id === state.final.prompt.id).final, 'final prompt is a "final" one');
  });
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe('scoring', () => {
  test('normal split is proportional and rounded to the nearest 10', () => {
    assert.deepEqual(scoreMatchup({ answers: ['a', 'b'], votes: [2, 1], roundNumber: 1 }), {
      kind: 'normal',
      points: [670, 330],
      sweep: null,
    });
    assert.deepEqual(scoreMatchup({ answers: ['a', 'b'], votes: [3, 4], roundNumber: 2 }).points, [860, 1140]);
  });

  test('Clean Sweep adds a bonus', () => {
    assert.deepEqual(scoreMatchup({ answers: ['a', 'b'], votes: [4, 0], roundNumber: 1 }), {
      kind: 'normal',
      points: [1250, 0],
      sweep: 0,
    });
    assert.deepEqual(scoreMatchup({ answers: ['a', 'b'], votes: [0, 3], roundNumber: 2 }).points, [0, 2500]);
  });

  test('Mind Meld (same answer, any case/spacing) gives both players 0', () => {
    assert.deepEqual(scoreMatchup({ answers: ['  Pizza Party', 'pizza party '], votes: [0, 0], roundNumber: 1 }), {
      kind: 'mindmeld',
      points: [0, 0],
      sweep: null,
    });
  });

  test('only one answer gets the full base points', () => {
    assert.deepEqual(scoreMatchup({ answers: ['a', null], votes: [0, 0], roundNumber: 1 }).points, [1000, 0]);
    assert.deepEqual(scoreMatchup({ answers: [null, 'b'], votes: [0, 0], roundNumber: 2 }).points, [0, 2000]);
  });

  test('no answers at all is skipped', () => {
    assert.equal(scoreMatchup({ answers: [null, null], votes: [0, 0], roundNumber: 1 }).kind, 'skipped');
  });

  test('zero votes splits the points evenly', () => {
    assert.deepEqual(scoreMatchup({ answers: ['a', 'b'], votes: [0, 0], roundNumber: 1 }).points, [500, 500]);
    assert.deepEqual(scoreMatchup({ answers: ['a', 'b'], votes: [0, 0], roundNumber: 2 }).points, [1000, 1000]);
  });

  test('in a real game, a Mind Meld skips voting and a missing answer is dropped', () => {
    let state = roundOneWith(4);
    const [meld, forfeit, empty] = state.round.prompts;
    for (const prompt of state.round.prompts) {
      prompt.playerIds.forEach((playerId, seat) => {
        let text = `${playerId} on ${prompt.id}`;
        if (prompt.id === meld.id) text = seat === 0 ? 'Same Answer' : '  same answer ';
        if (prompt.id === forfeit.id && seat === 1) return; // second author never answers
        if (prompt.id === empty.id) return; // neither author answers
        state = must(state, { type: 'answer', playerId, promptId: prompt.id, text });
      });
    }
    state = advance(state); // answer timer runs out
    assert.equal(state.phase, P.ROUND1_VOTE);

    const matchupPrompts = state.round.matchups.map((m) => m.promptText);
    assert.ok(!matchupPrompts.includes(empty.text), 'a prompt nobody answered is skipped');

    const meldMatchup = state.round.matchups.find((m) => m.promptText === meld.text);
    const forfeitMatchup = state.round.matchups.find((m) => m.promptText === forfeit.text);
    assert.equal(meldMatchup.kind, 'mindmeld');
    assert.equal(forfeitMatchup.kind, 'forfeit');

    // Walk through every matchup; Mind Meld and forfeit go straight to 'reveal'.
    while (state.phase === P.ROUND1_VOTE) {
      const m = currentMatchup(state);
      if (m.kind !== 'normal') assert.equal(state.round.step, 'reveal');
      state = advance(state);
    }
    assert.equal(state.phase, P.ROUND1_SCORES);
    const forfeitWinner = state.players.find((p) => p.id === forfeitMatchup.authorIds[0]);
    assert.ok(forfeitWinner.score >= 1000, 'the only answer got the full base points');
  });
});

// ---------------------------------------------------------------------------
// Final round
// ---------------------------------------------------------------------------

describe('final round voting', () => {
  const ballot = [
    { id: 'f1', authorId: 'p0', text: 'one' },
    { id: 'f2', authorId: 'p1', text: 'two' },
    { id: 'f3', authorId: 'p2', text: 'three' },
  ];

  test('exactly 3 votes are required', () => {
    assert.ok(validateFinalVote(ballot, 'p0', ['f2', 'f3']));
    assert.ok(validateFinalVote(ballot, 'p0', ['f2', 'f3', 'f2', 'f3']));
    assert.ok(validateFinalVote(ballot, 'p0', 'f2'));
    assert.equal(validateFinalVote(ballot, 'p0', ['f2', 'f3', 'f3']), null);
  });

  test('votes can be stacked on one answer', () => {
    assert.equal(validateFinalVote(ballot, 'p0', ['f2', 'f2', 'f2']), null);
  });

  test('you cannot vote for your own answer or a made-up one', () => {
    assert.match(validateFinalVote(ballot, 'p0', ['f1', 'f2', 'f3']), /own/);
    assert.match(validateFinalVote(ballot, 'p0', ['f2', 'f2', 'f9']), /exist/);
  });

  test('full final round: 300 points per vote, revealed fewest-first', () => {
    let state = roundOneWith(4);
    while (state.phase !== P.FINAL_ANSWER) state = advance(state);
    for (const p of state.players) {
      state = must(state, { type: 'answer', playerId: p.id, promptId: state.final.prompt.id, text: `final ${p.id}` });
    }
    assert.equal(state.phase, P.FINAL_VOTE, 'advanced early once everyone answered');

    const idOf = (playerId) => state.final.ballot.find((b) => b.authorId === playerId).id;
    // Everyone stacks all 3 votes on p0's answer, except p0 who picks p1.
    for (const p of state.players) {
      const target = p.id === 'p0' ? idOf('p1') : idOf('p0');
      mustFail(state, { type: 'finalVote', playerId: p.id, answerIds: [idOf(p.id), target, target] });
      state = must(state, { type: 'finalVote', playerId: p.id, answerIds: [target, target, target] });
    }
    assert.equal(state.phase, P.FINAL_RESULTS);
    const votes = state.final.results.map((r) => r.votes);
    assert.deepEqual(votes, [...votes].sort((a, b) => a - b), 'sorted fewest to most');

    const before = Object.fromEntries(state.players.map((p) => [p.id, p.score]));
    while (state.phase !== P.GAME_OVER) state = advance(state);
    const gain = (id) => state.players.find((p) => p.id === id).score - before[id];
    assert.equal(gain('p0'), 9 * 300);
    assert.equal(gain('p1'), 3 * 300);
    assert.equal(gain('p2'), 0);
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('phase transitions', () => {
  test('only the listed transitions are allowed', () => {
    assert.ok(canTransition(P.LOBBY, P.INTRO));
    assert.ok(canTransition(P.ROUND1_VOTE, P.ROUND1_SCORES));
    assert.ok(canTransition(P.GAME_OVER, P.LOBBY));
    assert.ok(!canTransition(P.LOBBY, P.ROUND1_VOTE));
    assert.ok(!canTransition(P.ROUND1_ANSWER, P.ROUND2_ANSWER));
    assert.ok(!canTransition(P.FINAL_RESULTS, P.LOBBY));
    assert.ok(!canTransition(P.GAME_OVER, P.FINAL_ANSWER));
  });

  test('actions in the wrong phase are rejected and change nothing', () => {
    const lobby = lobbyWith(3);
    mustFail(lobby, { type: 'answer', playerId: 'p0', promptId: 't1', text: 'hi' });
    mustFail(lobby, { type: 'vote', playerId: 'p0', matchupId: 'x', choice: 0 });
    mustFail(lobby, { type: 'finalVote', playerId: 'p0', answerIds: ['f1', 'f1', 'f1'] });
    mustFail(lobby, { type: 'advance' }); // the lobby has no timer
    mustFail(lobby, { type: 'playAgain', samePlayers: true });

    const answering = roundOneWith(3);
    mustFail(answering, { type: 'start' });
    mustFail(answering, { type: 'join', playerId: 'late', name: 'Late' });
    mustFail(answering, { type: 'kick', playerId: 'p1' });
    mustFail(answering, { type: 'vote', playerId: 'p0', matchupId: 'x', choice: 0 });
  });

  test('a stale timer is ignored', () => {
    const state = roundOneWith(3);
    mustFail(state, { type: 'advance', stepId: state.stepId - 1 });
  });

  test('full game reaches GAME_OVER and Play Again restarts cleanly', () => {
    let state = roundOneWith(5);
    let guard = 0;
    while (state.phase !== P.GAME_OVER && guard++ < 200) state = advance(state);
    assert.equal(state.phase, P.GAME_OVER);

    const again = must(state, { type: 'playAgain', samePlayers: true });
    assert.equal(again.phase, P.INTRO);
    assert.ok(again.players.every((p) => p.score === 0));

    const lobby = must(state, { type: 'playAgain', samePlayers: false });
    assert.equal(lobby.phase, P.LOBBY);
  });
});

// ---------------------------------------------------------------------------
// Winner screen highlights
// ---------------------------------------------------------------------------

describe('winner screen highlights', () => {
  let n = 0;
  /** One answerHistory entry; defaults to a 3-1 normal win in Round 1. */
  const entry = (over = {}) => ({
    round: 1,
    promptText: `prompt ${n}`,
    text: `answer ${n++}`,
    authorId: 'p0',
    votes: 3,
    totalVotes: 4,
    kind: 'normal',
    sweep: false,
    ...over,
  });
  /** Both sides of one Round 1/2 matchup. */
  const matchup = (round, [a, b], [va, vb], extra = {}) => [
    entry({ round, authorId: a, votes: va, totalVotes: va + vb, sweep: vb === 0, ...extra }),
    entry({ round, authorId: b, votes: vb, totalVotes: va + vb, sweep: va === 0, ...extra }),
  ];
  const PLAYERS = ['p0', 'p1', 'p2', 'p3'];

  test('an empty history gives no highlights', () => {
    assert.deepEqual(pickHighlights([], PLAYERS), []);
  });

  test('Mind Melds, forfeits and matchups with no votes are never shown', () => {
    const history = [
      ...matchup(1, ['p0', 'p1'], [0, 0], { kind: 'mindmeld' }),
      entry({ authorId: 'p2', votes: 0, totalVotes: 0, kind: 'forfeit' }),
      ...matchup(1, ['p2', 'p3'], [0, 0], { kind: 'novotes' }),
    ];
    assert.deepEqual(pickHighlights(history, PLAYERS), []);
  });

  test('a single matchup gives one best and one worst', () => {
    const history = matchup(1, ['p0', 'p1'], [3, 1]);
    const picks = pickHighlights(history, PLAYERS);
    assert.deepEqual(picks.map((p) => [p.type, p.authorId]), [['best', 'p0'], ['worst', 'p1']]);
    assert.equal(picks[0].votes, 3);
    assert.equal(picks[0].totalVotes, 4);
    assert.equal(picks[0].promptText, history[0].promptText);
  });

  test('a tied matchup is neither best nor worst', () => {
    assert.deepEqual(pickHighlights(matchup(1, ['p0', 'p1'], [2, 2]), PLAYERS), []);
  });

  test('Clean Sweeps lead the best list and zero-vote answers lead the worst list', () => {
    const history = [
      ...matchup(1, ['p0', 'p1'], [3, 1]),
      ...matchup(1, ['p2', 'p3'], [4, 0]),
    ];
    const picks = pickHighlights(history, PLAYERS);
    assert.equal(picks[0].type, 'best');
    assert.equal(picks[0].authorId, 'p2');
    assert.equal(picks[0].sweep, true);
    assert.equal(picks[1].type, 'worst');
    assert.equal(picks[1].authorId, 'p3');
    assert.equal(picks[1].votes, 0);
  });

  test('best and worst alternate, and no answer is picked twice', () => {
    const history = [
      ...matchup(1, ['p0', 'p1'], [3, 1]),
      ...matchup(1, ['p2', 'p3'], [4, 0]),
      ...matchup(2, ['p0', 'p2'], [1, 3]),
      ...matchup(2, ['p1', 'p3'], [2, 1]),
    ];
    const picks = pickHighlights(history, PLAYERS);
    picks.forEach((p, i) => assert.equal(p.type, i % 2 === 0 ? 'best' : 'worst'));
    const texts = picks.map((p) => p.text);
    assert.equal(new Set(texts).size, texts.length);
  });

  test('every round is represented when it has a winner and a loser', () => {
    // Round 1 has the most lopsided results, so ranking alone would skip rounds 2 and 3.
    const history = [
      ...matchup(1, ['p0', 'p1'], [4, 0]),
      ...matchup(1, ['p2', 'p3'], [4, 0]),
      ...matchup(1, ['p1', 'p2'], [4, 0]),
      ...matchup(1, ['p3', 'p0'], [4, 0]),
      ...matchup(2, ['p0', 'p1'], [3, 1]),
      entry({ round: 3, authorId: 'p2', votes: 6, totalVotes: 12, kind: 'final' }),
      entry({ round: 3, authorId: 'p1', votes: 4, totalVotes: 12, kind: 'final' }),
      entry({ round: 3, authorId: 'p0', votes: 2, totalVotes: 12, kind: 'final' }),
      entry({ round: 3, authorId: 'p3', votes: 0, totalVotes: 12, kind: 'final' }),
    ];
    const picks = pickHighlights(history, PLAYERS);
    for (const type of ['best', 'worst']) {
      const rounds = new Set(picks.filter((p) => p.type === type).map((p) => p.round));
      assert.deepEqual([...rounds].sort(), [1, 2, 3], `${type} covers all rounds`);
    }
    const finalBest = picks.find((p) => p.type === 'best' && p.round === 3);
    assert.equal(finalBest.authorId, 'p2', 'only the top final answer counts as best');
  });

  test('at most PER_TYPE of each type and PER_AUTHOR per player', () => {
    // p0 wins everything, so without the cap every best card would be theirs.
    const history = [];
    for (let i = 0; i < 6; i++) history.push(...matchup(1 + (i % 2), ['p0', PLAYERS[1 + (i % 3)]], [4, 0]));
    const picks = pickHighlights(history, PLAYERS);
    const best = picks.filter((p) => p.type === 'best');
    const worst = picks.filter((p) => p.type === 'worst');
    assert.equal(best.length, HIGHLIGHTS.PER_AUTHOR, 'only p0 won, so the cap limits the best list');
    assert.equal(worst.length, HIGHLIGHTS.PER_TYPE);
    for (const list of [best, worst]) {
      const counts = {};
      for (const p of list) counts[p.authorId] = (counts[p.authorId] ?? 0) + 1;
      assert.ok(Object.values(counts).every((c) => c <= HIGHLIGHTS.PER_AUTHOR));
    }
  });

  test('players who left are skipped', () => {
    const history = matchup(1, ['p0', 'p1'], [3, 1]);
    const picks = pickHighlights(history, ['p1', 'p2', 'p3']);
    assert.deepEqual(picks.map((p) => [p.type, p.authorId]), [['worst', 'p1']]);
  });

  test('a real game records every round, only the host gets highlights, and a new game clears them', () => {
    let state = roundOneWith(4);
    let guard = 0;
    while (state.phase !== P.GAME_OVER && guard++ < 300) {
      if (state.phase === P.ROUND1_ANSWER || state.phase === P.ROUND2_ANSWER) {
        // p3 never answers, so their matchups are forfeits.
        for (const prompt of state.round.prompts) {
          for (const playerId of prompt.playerIds.filter((id) => id !== 'p3')) {
            state = must(state, { type: 'answer', playerId, promptId: prompt.id, text: `${playerId} on ${prompt.id}` });
          }
        }
        state = advance(state);
      } else if (state.phase === P.ROUND1_VOTE || state.phase === P.ROUND2_VOTE) {
        const m = currentMatchup(state);
        if (state.round.step === 'vote') {
          for (const voter of state.players.filter((p) => !m.authorIds.includes(p.id))) {
            const r = applyAction(state, { type: 'vote', playerId: voter.id, matchupId: m.id, choice: 0 }, makeCtx());
            if (r.ok) state = r.state;
          }
        }
        if (state.phase.endsWith('_VOTE')) state = advance(state);
      } else if (state.phase === P.FINAL_ANSWER) {
        for (const p of state.players) {
          if (p.id === 'p3') continue;
          state = must(state, { type: 'answer', playerId: p.id, promptId: state.final.prompt.id, text: `final ${p.id}` });
        }
        if (state.phase === P.FINAL_ANSWER) state = advance(state);
      } else if (state.phase === P.FINAL_VOTE) {
        const target = state.final.ballot.find((b) => b.authorId === 'p0');
        const other = state.final.ballot.find((b) => b.authorId === 'p1');
        for (const p of state.players) {
          const id = p.id === 'p0' ? other.id : target.id;
          state = must(state, { type: 'finalVote', playerId: p.id, answerIds: [id, id, id] });
        }
      } else {
        state = advance(state);
      }
    }
    assert.equal(state.phase, P.GAME_OVER);

    const rounds = new Set(state.answerHistory.map((e) => e.round));
    assert.deepEqual([...rounds].sort(), [1, 2, 3]);
    assert.ok(state.answerHistory.every((e) => e.text !== null), 'missing answers are not recorded');

    const host = viewFor(state, { role: 'host' });
    const highlights = host.gameOver.highlights;
    assert.ok(highlights.length > 0);
    assert.ok(highlights.every((h) => h.authorId !== 'p3'), 'p3 never answered, so never appears');
    assert.ok(new Set(highlights.map((h) => h.round)).size > 1, 'more than one round is shown');
    assert.equal(host.gameOver.standings.length, 4, 'standings are unchanged');

    const phone = viewFor(state, { role: 'player', playerId: 'p0' });
    assert.deepEqual(phone.gameOver.highlights, []);

    assert.deepEqual(must(state, { type: 'playAgain', samePlayers: true }).answerHistory, []);
    assert.deepEqual(must(state, { type: 'playAgain', samePlayers: false }).answerHistory, []);
  });
});

// ---------------------------------------------------------------------------
// Lobby and voting rules
// ---------------------------------------------------------------------------

describe('lobby rules', () => {
  test('names are trimmed, 1-12 chars, and unique ignoring case', () => {
    let state = lobbyWith(1); // "Player0"
    mustFail(state, { type: 'join', playerId: 'x', name: '   ' });
    mustFail(state, { type: 'join', playerId: 'x', name: 'ThirteenChars' });
    mustFail(state, { type: 'join', playerId: 'x', name: ' player0 ' });
    state = must(state, { type: 'join', playerId: 'x', name: '  Zed  ' });
    assert.equal(state.players[1].name, 'Zed');
  });

  test('a 9th player is turned away', () => {
    const full = lobbyWith(LIMITS.MAX_PLAYERS);
    assert.match(mustFail(full, { type: 'join', playerId: 'x', name: 'Nine' }), /full/);
  });

  test('joining after the start says the game is in progress', () => {
    const state = roundOneWith(3);
    assert.equal(mustFail(state, { type: 'join', playerId: 'x', name: 'Late' }), 'Game already in progress.');
  });

  test('first player is VIP; only the VIP (or host) can start; needs 3 players', () => {
    let state = lobbyWith(2);
    assert.equal(state.vipId, 'p0');
    mustFail(state, { type: 'start' }); // only 2 players
    state = must(state, { type: 'join', playerId: 'p2', name: 'Third' });
    mustFail(state, { type: 'start', byPlayerId: 'p1' });
    assert.equal(must(state, { type: 'start', byPlayerId: 'p0' }).phase, P.INTRO);
    assert.equal(must(state, { type: 'start' }).phase, P.INTRO); // host
  });

  test('kicking the VIP hands VIP to the next player', () => {
    const state = must(lobbyWith(3), { type: 'kick', playerId: 'p0' });
    assert.equal(state.vipId, 'p1');
    assert.equal(state.players.length, 2);
  });
});

describe('voting rules', () => {
  function firstVote(n = 4) {
    let state = answerAll(roundOneWith(n));
    assert.equal(state.phase, P.ROUND1_VOTE, 'advanced early once everyone answered');
    assert.equal(state.round.step, 'vote');
    return state;
  }

  test('authors cannot vote, nobody can vote twice', () => {
    const state = firstVote();
    const m = currentMatchup(state);
    const voter = state.players.find((p) => !m.authorIds.includes(p.id)).id;

    mustFail(state, { type: 'vote', playerId: m.authorIds[0], matchupId: m.id, choice: 0 });
    mustFail(state, { type: 'vote', playerId: voter, matchupId: m.id, choice: 2 });
    mustFail(state, { type: 'vote', playerId: voter, matchupId: 'old', choice: 0 });
    const voted = must(state, { type: 'vote', playerId: voter, matchupId: m.id, choice: 0 });
    mustFail(voted, { type: 'vote', playerId: voter, matchupId: m.id, choice: 1 });
  });

  test('answers over 80 characters are rejected', () => {
    const state = roundOneWith(3);
    const prompt = state.round.prompts[0];
    mustFail(state, { type: 'answer', playerId: prompt.playerIds[0], promptId: prompt.id, text: 'x'.repeat(81) });
    must(state, { type: 'answer', playerId: prompt.playerIds[0], promptId: prompt.id, text: 'x'.repeat(80) });
  });

  test('disconnected players are waited for briefly, then skipped', () => {
    const start = 1_000_000;
    let state = roundOneWith(4);
    state = must(state, { type: 'setConnected', playerId: 'p3', connected: false }, makeCtx(start));
    for (const prompt of state.round.prompts) {
      for (const playerId of prompt.playerIds) {
        if (playerId === 'p3') continue;
        state = must(state, { type: 'answer', playerId, promptId: prompt.id, text: `${playerId}!` }, makeCtx(start + 1000));
      }
    }
    // A refresh takes a few seconds; the game must not skip p3's turn yet.
    assert.equal(state.phase, P.ROUND1_ANSWER);

    // Once the grace period is over, the next check moves on without them.
    const later = start + ROOM_TIMEOUTS.RECONNECT_GRACE_MS + 1;
    state = must(state, { type: 'tick' }, makeCtx(later));
    assert.equal(state.phase, P.ROUND1_VOTE);
  });

  test('a player who reconnects gets their unanswered prompts back', () => {
    let state = roundOneWith(3);
    state = must(state, { type: 'setConnected', playerId: 'p0', connected: false });
    state = must(state, { type: 'setConnected', playerId: 'p0', connected: true });
    const view = viewFor(state, { role: 'player', playerId: 'p0' });
    assert.equal(view.answer.myPrompts.length, 2);
    assert.ok(view.answer.myPrompts.every((p) => !p.answered && p.text));
  });

  test('players never see who wrote what while voting', () => {
    // Answer text must not contain player ids, or the leak check below is meaningless.
    let counter = 0;
    const state = answerAll(roundOneWith(5), () => `anonymous answer #${counter++}`);
    assert.equal(state.round.step, 'vote');
    const m = currentMatchup(state);
    for (const p of state.players) {
      const view = viewFor(state, { role: 'player', playerId: p.id });
      assert.equal(view.vote.result, undefined);
      assert.equal(view.vote.authorIds, undefined);
      assert.ok(!JSON.stringify(view.vote).includes(m.authorIds[0]));
      assert.ok(!JSON.stringify(view.vote).includes(m.authorIds[1]));
    }
  });

  test('standings share ranks on ties', () => {
    const ranks = standings([
      { id: 'a', score: 100 },
      { id: 'b', score: 300 },
      { id: 'c', score: 100 },
    ]).map((s) => s.rank);
    assert.deepEqual(ranks, [1, 2, 2]);
  });
});
