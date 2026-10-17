/**
 * play.js — the phone controller.
 *
 * How rendering works:
 *   The server sends a full `room:state` whenever anything changes. We pick
 *   a "screen" for that state and give it a KEY (like "vote-<id>-vote").
 *   - If the key is new, we build the screen from scratch.
 *   - If the key is the same, we only call its update() function.
 *   That way, typing in a text box isn't interrupted when someone ELSE
 *   submits and the waiting list changes.
 */

import { EVENTS } from './shared/events.js';
import { AVATARS, LIMITS, NO_ANSWER_TEXT, PHASES as P } from './shared/constants.js';
import { connect, request } from './shared/connection.js';
import { avatar, fill, h, playerById, playerTag, toast } from './shared/dom.js';
import { progress, secondsLeft, syncClock } from './shared/clock.js';
import { isMuted, setMuted, sounds, unlockAudio } from './shared/sound.js';
import { confetti } from './shared/confetti.js';

const SESSION_KEY = 'pd-player'; // { roomCode, playerToken } — lets us reconnect after a refresh
const NAME_KEY = 'pd-name'; // remembers your name for next time

const screenEl = document.getElementById('screen');
const topbarEl = document.getElementById('topbar');
const meEl = document.getElementById('me');
const timerEl = document.getElementById('timer');
const progressEl = document.getElementById('progress');
const connEl = document.getElementById('conn');
const muteBtn = document.getElementById('mute');

let state = null; // latest room:state from the server (null = not in a room)
let session = loadSession();
let screen = { key: null, update: null };
let joinNotice = ''; // a message to show on the join screen, e.g. after being kicked

const urlRoom = (new URLSearchParams(location.search).get('room') ?? '').toUpperCase();
// Scanned a QR code for a DIFFERENT room? Forget the old session.
if (session && urlRoom && urlRoom !== session.roomCode) {
  session = null;
  clearSession();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const socket = connect((status) => {
  connEl.hidden = status === 'connected' || (status === 'connecting' && !state);
  connEl.textContent = status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
});

socket.on('connect', () => {
  // Runs on the first connection AND after every reconnect.
  if (session) rejoin();
  else showJoin();
});

socket.on(EVENTS.ROOM_STATE, (next) => {
  syncClock(next.serverNow);
  state = next;
  render();
});

socket.on(EVENTS.ERROR, ({ message, code }) => {
  if (code === 'REMOVED' || code === 'ROOM_CLOSED') {
    leaveRoomLocally(message);
    return;
  }
  if (code === 'REPLACED') {
    state = null;
    mount('replaced', replacedScreen);
    return;
  }
  toast(message, { error: true });
});

// Phones pause pages in the background. When we come back, reconnect fast.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !socket.connected) socket.connect();
});

async function rejoin() {
  if (!state) mount(`rejoining-${session.roomCode}`, rejoiningScreen);
  const res = await request(socket, EVENTS.PLAYER_REJOIN, session);
  if (!res.ok) leaveRoomLocally('That game is over. Join a new one!');
}

function leaveRoomLocally(message) {
  clearSession();
  session = null;
  state = null;
  joinNotice = message;
  showJoin();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  renderTopbar();
  const [key, build] = pickScreen(state);
  mount(key, build);
}

/** Shows the screen for `key`, building it only if it's a different screen. */
function mount(key, build) {
  if (screen.key === key) {
    screen.update?.(state);
    return;
  }
  const built = build(state);
  screen = { key, update: built.update };
  screenEl.replaceChildren(built.el);
  window.scrollTo(0, 0);
}

function showJoin() {
  topbarEl.hidden = true;
  // A stable key: a quick reconnect while on this screen won't wipe what you typed.
  mount('join', joinScreen);
}

/** Chooses which screen to show, and its key, for a given state. */
function pickScreen(s) {
  const g = s.gameNumber;
  switch (s.phase) {
    case P.LOBBY:
      return ['lobby', lobbyScreen];
    case P.INTRO:
      return [`intro-${g}`, introScreen];
    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER: {
      const mine = s.answer.myPrompts;
      const index = mine.findIndex((p) => !p.answered);
      if (index === -1) return [`waiting-${s.phase}-${g}`, waitingScreen];
      const label = `Round ${s.answer.roundNumber} · Prompt ${index + 1} of ${mine.length}`;
      return [`answer-${g}-${mine[index].id}`, (st) => answerScreen(st, mine[index], label)];
    }
    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE: {
      const v = s.vote;
      return [`vote-${v.id}-${v.step}-${v.myVote === null ? 'open' : 'done'}`, voteScreen];
    }
    case P.ROUND1_SCORES:
    case P.ROUND2_SCORES:
      return [`scores-${s.phase}-${g}`, scoresScreen];
    case P.FINAL_ANSWER:
      if (s.finalAnswer.answered) return [`final-waiting-${g}`, waitingScreen];
      return [`final-answer-${g}`, (st) => answerScreen(st, st.finalAnswer.prompt, 'Final round · Everyone gets this one')];
    case P.FINAL_VOTE:
      return [`final-vote-${g}-${s.finalVote.myVotes ? 'done' : 'open'}`, finalVoteScreen];
    case P.FINAL_RESULTS:
      return [`final-results-${g}`, finalResultsScreen];
    case P.GAME_OVER:
      return [`over-${g}`, gameOverScreen];
    default:
      return ['unknown', () => center('🤔', 'Hmm…', 'Look at the big screen.')];
  }
}

function renderTopbar() {
  const me = playerById(state, state.me.id);
  topbarEl.hidden = !me;
  if (!me) return;
  meEl.replaceChildren(playerTag(me), h('span.me-score', {}, me.score.toLocaleString()));
}

// ---------------------------------------------------------------------------
// Timer (top bar). Redrawn 5 times a second from the server's phaseEndsAt.
// ---------------------------------------------------------------------------

let lastSecond = null;
setInterval(() => {
  const showTimer = state && state.phaseEndsAt && isWaitingStep(state);
  timerEl.hidden = !showTimer;
  if (!showTimer) {
    progressEl.style.transform = 'scaleX(0)';
    lastSecond = null;
    return;
  }
  const left = secondsLeft(state.phaseEndsAt);
  timerEl.textContent = `${left}s`;
  timerEl.classList.toggle('is-urgent', left <= 10);
  progressEl.style.transform = `scaleX(${1 - (progress(state.phaseStartedAt, state.phaseEndsAt) ?? 0)})`;

  if (left !== lastSecond && left === 10 && iStillOweSomething(state)) {
    sounds.warning();
    navigator.vibrate?.([80, 60, 80]);
  }
  lastSecond = left;
}, 200);

/** Steps where the game is waiting on players (so a countdown makes sense). */
function isWaitingStep(s) {
  switch (s.phase) {
    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER:
    case P.FINAL_ANSWER:
    case P.FINAL_VOTE:
      return true;
    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE:
      return s.vote.step === 'vote';
    default:
      return false;
  }
}

function iStillOweSomething(s) {
  switch (s.phase) {
    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER:
      return s.answer.myPrompts.some((p) => !p.answered);
    case P.FINAL_ANSWER:
      return !s.finalAnswer.answered;
    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE:
      return s.vote.step === 'vote' && !s.vote.isAuthor && s.vote.myVote === null;
    case P.FINAL_VOTE:
      return s.finalVote.canVote && !s.finalVote.myVotes;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Screens. Each returns { el, update? }.
// ---------------------------------------------------------------------------

/** A centered message screen: big emoji, title, text, and optional extras. */
function center(emoji, title, text, ...extra) {
  return {
    el: h(
      'section.screen-center',
      {},
      typeof emoji === 'string' ? h('div.big-emoji', {}, emoji) : emoji,
      h('h2.big-title', {}, title),
      text ? h('p.lead', {}, text) : null,
      ...extra,
    ),
  };
}

function rejoiningScreen() {
  return center('🔌', 'Reconnecting…', `Getting you back into room ${session?.roomCode ?? ''}.`);
}

function replacedScreen() {
  return center(
    '📱',
    'Playing somewhere else?',
    'This game was opened in another tab or on another device.',
    h('button.btn.btn-big', { type: 'button', onclick: () => session && rejoin() }, 'Play here instead'),
  );
}

function joinScreen() {
  const codeInput = h('input.field.field-code', {
    id: 'room-code',
    type: 'text',
    maxLength: LIMITS.ROOM_CODE_LENGTH,
    placeholder: 'ABCD',
    value: urlRoom,
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: false,
    enterkeyhint: 'next',
  });
  const nameInput = h('input.field', {
    id: 'player-name',
    type: 'text',
    maxLength: LIMITS.NAME_MAX,
    placeholder: 'Your name',
    value: localStorage.getItem(NAME_KEY) ?? '',
    autocomplete: 'nickname',
    enterkeyhint: 'go',
  });
  const errorEl = h('p.form-error', { role: 'alert' }, joinNotice);
  joinNotice = '';
  const button = h('button.btn.btn-big.btn-red', { type: 'submit' }, 'Join the duel');

  // Room codes are letters only; uppercase them as you type.
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  async function onSubmit(event) {
    event.preventDefault();
    unlockAudio();
    const roomCode = codeInput.value.trim();
    const name = nameInput.value.trim();
    if (roomCode.length !== LIMITS.ROOM_CODE_LENGTH) return showError('Room codes are 4 letters.');
    if (!name) return showError('Type a name first.');

    button.disabled = true;
    button.textContent = 'Joining…';
    const res = await request(socket, EVENTS.PLAYER_JOIN, { roomCode, name });
    button.disabled = false;
    button.textContent = 'Join the duel';
    if (!res.ok) return showError(res.error);

    localStorage.setItem(NAME_KEY, name);
    session = { roomCode: res.roomCode, playerToken: res.playerToken };
    saveSession(session);
    sounds.join();
    navigator.vibrate?.(30);
    render(); // in case the room state arrived before this reply
  }

  function showError(message) {
    errorEl.textContent = message;
    sounds.error();
    navigator.vibrate?.([40, 40, 40]);
  }

  const form = h(
    'form.join-form',
    { onsubmit: onSubmit, novalidate: true },
    h('label.field-label', { for: 'room-code' }, 'Room code'),
    codeInput,
    h('label.field-label', { for: 'player-name' }, 'Your name'),
    nameInput,
    errorEl,
    button,
  );

  // Pre-filled code? Jump straight to the name box.
  queueMicrotask(() => (urlRoom ? nameInput : codeInput).focus({ preventScroll: true }));

  return {
    el: h(
      'section.screen-join',
      {},
      h('h1.logo', {}, h('span.logo-top', {}, 'Punchline'), h('span.logo-bottom', {}, 'Duel')),
      h('p.tagline', {}, 'Write funny. Win votes. Take the belt.'),
      form,
    ),
  };
}

function lobbyScreen(s) {
  const avatarBtn = h('button.avatar-button', {
    type: 'button',
    'aria-label': 'Change your avatar',
    onclick: () => {
      picker.hidden = !picker.hidden;
      navigator.vibrate?.(10);
    },
  });
  const picker = h(
    'div.avatar-picker',
    { hidden: true },
    AVATARS.map((emoji) =>
      h(
        'button.avatar-choice',
        {
          type: 'button',
          'aria-label': `Pick ${emoji}`,
          onclick: async () => {
            picker.hidden = true;
            navigator.vibrate?.(15);
            const res = await request(socket, EVENTS.PLAYER_SET_AVATAR, { avatar: emoji });
            if (!res.ok) toast(res.error, { error: true });
          },
        },
        emoji,
      ),
    ),
  );
  const nameEl = h('h2.lobby-name');
  const crew = h('div.lobby-crew');
  const startArea = h('div.lobby-start');

  const el = h(
    'section.screen-lobby',
    {},
    h('p.eyebrow', {}, `Room ${s.code}`),
    avatarBtn,
    h('p.hint', {}, 'Tap your avatar to change it'),
    picker,
    nameEl,
    crew,
    startArea,
    h('button.link-button', { type: 'button', onclick: leave }, 'Leave room'),
  );

  async function start(event) {
    unlockAudio();
    event.currentTarget.disabled = true;
    const res = await request(socket, EVENTS.PLAYER_START);
    if (!res.ok) {
      toast(res.error, { error: true });
      update(state);
    }
  }

  async function leave() {
    if (!confirm('Leave this room?')) return;
    await request(socket, EVENTS.PLAYER_LEAVE);
    leaveRoomLocally('');
  }

  function update(s) {
    const me = playerById(s, s.me.id);
    if (!me) return;
    avatarBtn.replaceChildren(avatar(me, 'avatar-xl'));
    avatarBtn.style.setProperty('--player-color', me.color);
    for (const choice of picker.children) choice.classList.toggle('is-current', choice.textContent === me.avatar);
    nameEl.textContent = me.name;
    nameEl.style.color = me.color;

    fill(crew,
      h('p.crew-count', {}, `${s.players.length} / ${LIMITS.MAX_PLAYERS} players`),
      h('div.crew-row', {}, s.players.map((p) => avatar(p, p.connected ? '' : 'is-offline'))),
    );

    const need = LIMITS.MIN_PLAYERS - s.players.length;
    const vip = playerById(s, s.vipId);
    if (s.me.isVip) {
      fill(startArea,
        h('p.vip-badge', {}, "⭐ You're the VIP"),
        h('button.btn.btn-big.btn-red', { type: 'button', disabled: need > 0, onclick: start }, 'Start game'),
        h('p.hint', {}, need > 0 ? `Need ${need} more player${need === 1 ? '' : 's'} to start.` : 'Everybody in? Hit it!'),
      );
    } else {
      fill(startArea,
        h(
          'p.waiting-note',
          {},
          need > 0
            ? `Waiting for ${need} more player${need === 1 ? '' : 's'}…`
            : `Waiting for ${vip?.name ?? 'the VIP'} or the host to start…`,
        ),
      );
    }
  }

  update(s);
  return { el, update };
}

function introScreen(s) {
  const me = playerById(s, s.me.id);
  return center(
    avatar(me, 'avatar-xl bob'),
    'Get ready!',
    'Eyes on the big screen. Your prompts are coming in a few seconds.',
  );
}

/** One prompt with a text box. Used for rounds 1/2 and the final. */
function answerScreen(s, prompt, label) {
  const draftKey = `pd-draft-${s.code}-${s.gameNumber}-${prompt.id}`;
  const textarea = h('textarea.answer-input', {
    maxLength: LIMITS.ANSWER_MAX,
    rows: 3,
    placeholder: 'Type something funny…',
    value: sessionStorage.getItem(draftKey) ?? '',
    autocomplete: 'off',
    autocapitalize: 'sentences',
    enterkeyhint: 'send',
    'aria-label': 'Your answer',
  });
  const counter = h('span.counter', { 'aria-live': 'polite' });
  const button = h('button.btn.btn-big.btn-red', { type: 'submit' }, 'Submit');

  function refresh() {
    const length = textarea.value.length;
    counter.textContent = `${length} / ${LIMITS.ANSWER_MAX}`;
    counter.classList.toggle('is-near', length >= LIMITS.ANSWER_MAX - 10);
    button.disabled = textarea.value.trim().length === 0;
    sessionStorage.setItem(draftKey, textarea.value); // survives a refresh
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (button.disabled) return;
    unlockAudio();
    button.disabled = true;
    button.textContent = 'Sending…';
    const res = await request(socket, EVENTS.PLAYER_ANSWER, { promptId: prompt.id, text: textarea.value });
    if (!res.ok) {
      toast(res.error, { error: true });
      sounds.error();
      button.textContent = 'Submit';
      refresh();
      return;
    }
    sessionStorage.removeItem(draftKey);
    sounds.submit();
    navigator.vibrate?.(40);
    // The server's next room:state moves us to the next prompt / waiting screen.
  }

  textarea.addEventListener('input', refresh);
  // Enter submits (Shift+Enter is ignored since answers are one line anyway).
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  // Keep the prompt + box in view when the keyboard slides up.
  textarea.addEventListener('focus', () => {
    setTimeout(() => form.scrollIntoView({ block: 'start', behavior: 'smooth' }), 300);
  });

  const form = h(
    'form.answer-form',
    { onsubmit: onSubmit },
    h('p.eyebrow', {}, label),
    h('div.prompt-card.paper', {}, prompt.text),
    h('div.answer-box', {}, textarea, counter),
    button,
  );
  refresh();
  return { el: h('section.screen-answer', {}, form) };
}

function waitingScreen(s) {
  const list = h('div.waiting-list');
  const { el } = center('✅', 'Locked in!', 'Waiting for other players…', list);

  function update(s) {
    const ids = s.answer?.waitingOn ?? s.finalAnswer?.waitingOn ?? [];
    fill(list,
      ids.length ? h('p.hint', {}, 'Still writing:') : null,
      ...ids.map((id) => {
        const p = playerById(s, id);
        return playerTag(p, p.connected ? '' : 'is-offline');
      }),
    );
  }
  update(s);
  return { el, update };
}

function voteScreen(s) {
  const v = s.vote;
  const answerText = (i) => v.answers[i] ?? NO_ANSWER_TEXT;

  if (v.step === 'reveal') return voteRevealScreen(s);

  if (v.isAuthor) {
    return center(
      '🎤',
      'Your answer is up!',
      "You can't vote on this one. Fingers crossed!",
      h('blockquote.quote', {}, answerText(v.myAnswerIndex)),
    );
  }

  if (v.myVote !== null) {
    return center('🗳️', 'Vote locked in!', 'Watch the big screen.', h('blockquote.quote', {}, answerText(v.myVote)));
  }

  const buttons = [0, 1].map((i) =>
    h(
      `button.vote-choice.${i === 0 ? 'corner-red' : 'corner-blue'}`,
      { type: 'button', onclick: () => castVote(i) },
      h('span.vote-corner', {}, i === 0 ? 'Red corner' : 'Blue corner'),
      h('span.vote-text', {}, answerText(i)),
    ),
  );

  async function castVote(choice) {
    unlockAudio();
    buttons.forEach((b, i) => {
      b.disabled = true;
      b.classList.toggle('is-chosen', i === choice);
    });
    navigator.vibrate?.(40);
    const res = await request(socket, EVENTS.PLAYER_VOTE, { matchupId: v.id, choice });
    if (!res.ok) {
      toast(res.error, { error: true });
      buttons.forEach((b) => {
        b.disabled = false;
        b.classList.remove('is-chosen');
      });
      return;
    }
    sounds.submit();
  }

  return {
    el: h(
      'section.screen-vote',
      {},
      h('p.eyebrow', {}, `Matchup ${v.index + 1} of ${v.total}`),
      h('div.prompt-card.paper.prompt-small', {}, v.promptText),
      h('p.vote-instruction', {}, 'Tap the funnier answer'),
      buttons[0],
      h('div.vs-mini', {}, 'VS'),
      buttons[1],
    ),
  };
}

function voteRevealScreen(s) {
  const v = s.vote;
  const r = v.result;

  if (r.kind === 'mindmeld') {
    return center('🧠', 'MIND MELD!', v.isAuthor ? 'You both wrote the same thing! No points this time.' : 'They wrote the exact same thing!');
  }

  if (v.isAuthor) {
    const mine = v.myAnswerIndex;
    const points = r.points[mine];
    if (v.answers[mine] === null) return center('😴', 'No answer…', "You didn't answer this one. Next time!");
    const title = r.sweep === mine ? 'CLEAN SWEEP!' : points > r.points[1 - mine] ? 'You won it!' : points === r.points[1 - mine] ? 'Even split!' : 'Tough crowd…';
    const note = r.kind === 'forfeit' ? "Your opponent didn't answer. Free points!" : 'Watch the big screen.';
    return center(r.sweep === mine ? '🧹' : points > 0 ? '🎉' : '😅', title, note, h('p.points-big', {}, `+${points.toLocaleString()}`));
  }

  if (v.myVote !== null && r.kind === 'normal') {
    const myPickWon = r.points[v.myVote] > r.points[1 - v.myVote];
    return center(myPickWon ? '😎' : '🤷', myPickWon ? 'Your pick won!' : 'Your pick lost!', 'Watch the big screen.');
  }
  return center('👀', 'Watch the big screen!', null);
}

function scoresScreen(s) {
  const me = playerById(s, s.me.id);
  const sorted = [...s.players].sort((a, b) => b.score - a.score);
  const rank = sorted.findIndex((p) => p.score === me.score) + 1;
  const gained = me.score - me.roundStartScore;
  return center(
    rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '💪',
    `You're #${rank}`,
    `${me.score.toLocaleString()} points${gained > 0 ? ` (+${gained.toLocaleString()} this round)` : ''}`,
    h('p.hint', {}, 'Check the standings on the big screen.'),
  );
}

function finalVoteScreen(s) {
  const fv = s.finalVote;
  if (!fv.canVote) return center('🍿', 'Sit back!', "There's nothing else to vote on this time.");
  if (fv.myVotes) return center('🗳️', 'Votes locked in!', 'Watch the big screen for the big reveal.');

  const picks = []; // answer ids, one entry per vote (repeats = stacked votes)
  const remainingEl = h('p.votes-left', { 'aria-live': 'polite' });
  const submit = h('button.btn.btn-big.btn-red', { type: 'button', onclick: send }, 'Lock in votes');
  const reset = h('button.btn.btn-ghost', { type: 'button', onclick: () => { picks.length = 0; refresh(); } }, 'Start over');

  const rows = fv.ballot.map((b) => {
    const mine = b.id === fv.myAnswerId;
    const pips = h('span.pips');
    const button = h(
      'button.final-choice',
      { type: 'button', disabled: mine, onclick: () => add(b.id) },
      h('span.final-choice-text', {}, b.text),
      mine ? h('span.mine-tag', {}, 'Yours') : pips,
    );
    return { id: b.id, button, pips };
  });

  function add(id) {
    if (picks.length >= LIMITS.FINAL_VOTES) return;
    picks.push(id);
    navigator.vibrate?.(15);
    refresh();
  }

  function refresh() {
    const left = LIMITS.FINAL_VOTES - picks.length;
    remainingEl.textContent = left === 0 ? 'All votes placed!' : `${left} vote${left === 1 ? '' : 's'} left · stack them if you want`;
    for (const row of rows) {
      const count = picks.filter((id) => id === row.id).length;
      row.pips.replaceChildren(...Array.from({ length: count }, () => h('span.pip', {}, '★')));
      row.button.classList.toggle('has-votes', count > 0);
    }
    submit.disabled = left > 0;
    reset.disabled = picks.length === 0;
  }

  async function send() {
    unlockAudio();
    submit.disabled = true;
    const res = await request(socket, EVENTS.PLAYER_FINAL_VOTE, { answerIds: [...picks] });
    if (!res.ok) {
      toast(res.error, { error: true });
      refresh();
      return;
    }
    sounds.submit();
    navigator.vibrate?.(40);
  }

  refresh();
  return {
    el: h(
      'section.screen-final-vote',
      {},
      h('p.eyebrow', {}, 'Final round · You have 3 votes'),
      h('div.prompt-card.paper.prompt-small', {}, fv.promptText),
      remainingEl,
      h('div.final-choices', {}, rows.map((r) => r.button)),
      h('div.final-actions', {}, submit, reset),
    ),
  };
}

function finalResultsScreen(s) {
  const note = h('div.final-note');
  const { el } = center('👀', 'Watch the big screen!', 'The final answers are being revealed…', note);

  function update(s) {
    const mine = s.finalResults.revealed.find((r) => r.authorId === s.me.id);
    fill(note,
      mine
        ? h('p.points-big', {}, `${mine.votes} vote${mine.votes === 1 ? '' : 's'} · +${mine.points.toLocaleString()}`)
        : null,
    );
  }
  update(s);
  return { el, update };
}

function gameOverScreen(s) {
  const standing = s.gameOver.standings.find((st) => st.id === s.me.id);
  const won = standing.rank === 1;
  if (won) setTimeout(() => confetti({ count: 120 }), 400);
  return center(
    won ? '🏆' : standing.rank <= 3 ? ['🥇', '🥈', '🥉'][standing.rank - 1] : '🎭',
    won ? 'You won!' : `You finished #${standing.rank}`,
    `${standing.score.toLocaleString()} points`,
    h('p.hint', {}, 'Waiting for the host to start another game…'),
  );
}

// ---------------------------------------------------------------------------
// Mute button + storage helpers
// ---------------------------------------------------------------------------

function renderMute() {
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-label', isMuted() ? 'Sound off' : 'Sound on');
}
muteBtn.addEventListener('click', () => {
  unlockAudio();
  setMuted(!isMuted());
  renderMute();
});
renderMute();

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
    return saved?.roomCode && saved?.playerToken ? saved : null;
  } catch {
    return null;
  }
}

function saveSession(value) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}
