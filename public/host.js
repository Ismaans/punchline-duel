/**
 * host.js — the big shared screen (laptop or TV).
 *
 * Same rendering idea as play.js: each room:state picks a screen with a key.
 * New key → build the screen (with its entrance animations); same key →
 * update() just the parts that changed.
 *
 * Animations are mostly CSS. JavaScript sets classes and a few CSS variables
 * (like --pct for a vote bar) and the stylesheet does the motion.
 */

import { EVENTS } from './shared/events.js';
import { LIMITS, NO_ANSWER_TEXT, PHASES as P } from './shared/constants.js';
import { connect, request } from './shared/connection.js';
import { avatar, fill, h, playerById, playerTag, toast } from './shared/dom.js';
import { progress, secondsLeft, syncClock } from './shared/clock.js';
import { isMuted, playMusic, setMuted, sounds, stopMusic, unlockAudio } from './shared/sound.js';
import { confetti, confettiCannons } from './shared/confetti.js';

const HOST_KEY = 'pd-host'; // { roomCode, hostToken, fast }
const QR_LIBRARY = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';
const wantFast = new URLSearchParams(location.search).get('fast') === '1';

const stageEl = document.getElementById('stage');
const rosterEl = document.getElementById('roster');
const barRoomEl = document.getElementById('bar-room');
const brandEl = document.getElementById('brand');
const timerEl = document.getElementById('timer');
const timerNumEl = document.getElementById('timer-num');
const connEl = document.getElementById('conn');
const muteBtn = document.getElementById('mute');

let state = null;
let screen = { key: null, update: null };
let pendingTimeouts = []; // cleared whenever the screen changes

// Phones can't open "localhost", so find this computer's Wi-Fi address.
const joinBasePromise = resolveJoinBase();

// Browsers only allow sound after the user interacts with the page.
document.addEventListener('pointerdown', unlockAudio);
document.addEventListener('keydown', unlockAudio);

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const socket = connect((status) => {
  connEl.hidden = status === 'connected' || !state;
});

socket.on('connect', openRoom);

socket.on(EVENTS.ROOM_STATE, (next) => {
  syncClock(next.serverNow);
  state = next;
  render();
});

socket.on(EVENTS.ERROR, ({ message, code }) => {
  if (code === 'ROOM_CLOSED') {
    localStorage.removeItem(HOST_KEY);
    toast(message);
    state = null;
    openRoom();
    return;
  }
  if (code === 'REPLACED') {
    state = null;
    musicKey = null;
    stopMusic();
    mount('replaced', replacedScreen);
    return;
  }
  toast(message, { error: true });
});

/** Rejoins our saved room after a refresh, or creates a new one. */
async function openRoom() {
  const saved = loadHostSession();
  if (saved && saved.fast === wantFast) {
    const res = await request(socket, EVENTS.HOST_REJOIN, saved);
    if (res.ok) return;
  }
  const res = await request(socket, EVENTS.HOST_CREATE, { fast: wantFast });
  if (!res.ok) {
    toast(res.error, { error: true });
    return;
  }
  localStorage.setItem(HOST_KEY, JSON.stringify({ roomCode: res.roomCode, hostToken: res.hostToken, fast: wantFast }));
}

async function send(event, payload) {
  const res = await request(socket, event, payload);
  if (!res.ok) {
    toast(res.error, { error: true });
    sounds.error();
  }
  return res;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  document.body.dataset.phase = state.phase;
  renderBar();
  renderRoster();
  renderMusic();
  const [key, build] = pickScreen(state);
  mount(key, build);
}

function mount(key, build) {
  if (screen.key === key) {
    screen.update?.(state);
    return;
  }
  pendingTimeouts.forEach(clearTimeout);
  pendingTimeouts = [];
  const built = build(state);
  screen = { key, update: built.update };
  stageEl.replaceChildren(built.el);
}

/** setTimeout that's cancelled automatically if the screen changes first. */
function later(ms, fn) {
  pendingTimeouts.push(setTimeout(fn, ms));
}

/**
 * Renders a list while REUSING one element per key (e.g. per player).
 * New elements get an "enter" class (for their entrance animation) that's
 * removed once it finishes, so re-rendering never replays it.
 *
 * @param create (item) => a new element
 * @param patch  (el, item) => update an element's contents for this item
 */
function keyedList(container, items, keyOf, create, patch) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const elements = items.map((item) => {
    const key = keyOf(item);
    let el = existing.get(key);
    if (!el) {
      el = create(item);
      el.dataset.key = key;
      el.classList.add('enter');
      // Children's animations bubble up here too; only react to our own.
      el.addEventListener('animationend', (event) => {
        if (event.target === el) el.classList.remove('enter');
      });
    }
    patch(el, item);
    return el;
  });
  container.replaceChildren(...elements);
}

function pickScreen(s) {
  const g = s.gameNumber;
  switch (s.phase) {
    case P.LOBBY:
      return [`lobby-${s.code}`, lobbyScreen];
    case P.INTRO:
      return [`intro-${g}`, introScreen];
    case P.ROUND1_ANSWER:
    case P.ROUND2_ANSWER:
      return [`answer-${s.phase}-${g}`, answeringScreen];
    case P.ROUND1_VOTE:
    case P.ROUND2_VOTE:
      return [`matchup-${s.vote.id}-${s.vote.step}`, matchupScreen];
    case P.ROUND1_SCORES:
    case P.ROUND2_SCORES:
      return [`scores-${s.phase}-${g}`, scoresScreen];
    case P.FINAL_ANSWER:
      return [`final-answer-${g}`, finalAnswerScreen];
    case P.FINAL_VOTE:
      return [`final-vote-${g}`, finalVoteScreen];
    case P.FINAL_RESULTS:
      return [`final-results-${g}`, finalResultsScreen];
    case P.GAME_OVER:
      return [`over-${g}`, gameOverScreen];
    default:
      return ['unknown', () => ({ el: h('section.center-message', {}, h('h1.giant', {}, 'One moment…')) })];
  }
}

function renderBar() {
  const inLobby = state.phase === P.LOBBY;
  // The lobby has its own giant logo. (visibility, not display, so the bar's
  // three-column layout doesn't shift.)
  brandEl.style.visibility = inLobby ? 'hidden' : 'visible';
  fill(barRoomEl,
    h(
      'span',
      {},
      inLobby ? null : h('span.bar-code', {}, h('span.bar-code-label', {}, 'Room'), state.code),
      state.fast ? h('span.fast-badge', {}, 'Fast mode') : null,
    ),
  );
}

/** The strip of players along the bottom during the game. */
function renderRoster() {
  const hide = [P.LOBBY, P.GAME_OVER, P.ROUND1_SCORES, P.ROUND2_SCORES].includes(state.phase);
  rosterEl.hidden = hide;
  if (hide) return;
  const waiting = new Set(state.answer?.waitingOn ?? state.finalAnswer?.waitingOn ?? []);
  const answering = Boolean(state.answer || state.finalAnswer);
  rosterEl.replaceChildren(
    ...state.players.map((p) =>
      h(
        'div.roster-player',
        { class: [p.connected ? '' : 'is-offline', answering && !waiting.has(p.id) ? 'is-done' : ''].join(' ') },
        avatar(p),
        h('span.roster-name', { style: { color: p.color } }, p.name),
        h('span.roster-score', {}, p.score.toLocaleString()),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Countdown timer (top right). Ticks with sounds near the end.
// ---------------------------------------------------------------------------

let lastSecond = null;
setInterval(() => {
  const show = state && state.phaseEndsAt && isWaitingStep(state);
  timerEl.hidden = !show;
  if (!show) {
    lastSecond = null;
    return;
  }
  const left = secondsLeft(state.phaseEndsAt);
  timerNumEl.textContent = left;
  timerEl.style.setProperty('--p', 1 - (progress(state.phaseStartedAt, state.phaseEndsAt) ?? 0));
  timerEl.classList.toggle('is-urgent', left <= 10);
  if (left !== lastSecond) {
    if (left === 10) sounds.warning();
    else if (left <= 5 && left > 0) sounds.tick();
  }
  lastSecond = left;
}, 200);

function isWaitingStep(s) {
  if (s.phase === P.ROUND1_VOTE || s.phase === P.ROUND2_VOTE) return s.vote.step === 'vote';
  return [P.ROUND1_ANSWER, P.ROUND2_ANSWER, P.FINAL_ANSWER, P.FINAL_VOTE].includes(s.phase);
}

// ---------------------------------------------------------------------------
// Background music: one track per phase. A round's voting track keeps playing
// across all of its matchups.
// ---------------------------------------------------------------------------

let musicKey = null;

function renderMusic() {
  const key = `${state.phase}-${state.gameNumber}`;
  if (key === musicKey) return;
  musicKey = key;
  switch (state.phase) {
    case P.LOBBY:
      return playMusic('music_lobby');
    case P.INTRO:
      return playMusic('music_intro', { loop: false });
    case P.ROUND1_ANSWER:
      return playMusic('music_write_r1');
    case P.ROUND1_VOTE:
      return playMusic('music_vote_r1');
    case P.ROUND2_ANSWER:
      return playMusic('music_write_r2');
    case P.ROUND2_VOTE:
      return playMusic('music_vote_r2');
    case P.ROUND1_SCORES:
    case P.ROUND2_SCORES:
      return playMusic('music_scores', { loop: false });
    case P.FINAL_ANSWER:
      return playMusic('music_write_final');
    case P.FINAL_VOTE:
      return playMusic('music_vote_final');
    case P.FINAL_RESULTS:
      return playMusic('music_final_reveal');
    case P.GAME_OVER:
      return playMusic('music_winner_fanfare', { loop: false, then: 'music_winner_loop' });
    default:
      return stopMusic();
  }
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function lobbyScreen(s) {
  const urlEl = h('p.join-url', {}, '…');
  const qrImg = h('img.qr', { alt: `QR code to join room ${s.code}`, width: 240, height: 240 });
  const qrWrap = h('div.qr-wrap', {}, qrImg, h('p.qr-hint', {}, 'or scan'));
  showJoinInfo(s.code, urlEl, qrImg, qrWrap);

  const slots = h('div.slots');
  const startBtn = h('button.btn.btn-red.btn-huge', { type: 'button', onclick: start }, 'Start Game');
  const startHint = h('p.start-hint');

  const promptInput = h('input.prompt-input', {
    type: 'text',
    maxLength: LIMITS.CUSTOM_PROMPT_MAX,
    placeholder: 'The worst thing to find in a lunchbox: _____',
    'aria-label': 'Custom prompt',
  });
  const promptCount = h('span.prompt-count');
  const promptList = h('ul.prompt-list');
  const promptForm = h(
    'form.prompt-form',
    { onsubmit: addPrompt },
    promptInput,
    h('button.btn.btn-blue', { type: 'submit' }, 'Add'),
  );

  const el = h(
    'section.lobby',
    {},
    h(
      'div.lobby-left',
      {},
      h(
        'h1.logo',
        {},
        h('span.logo-top', {}, 'Punchline'),
        h('span.logo-bottom', {}, 'Duel'),
      ),
      h(
        'div.join-panel',
        {},
        h('div.marquee-lights', { 'aria-hidden': 'true' }),
        h('p.join-label', {}, 'On your phone, go to'),
        urlEl,
        h('p.join-label', {}, 'and enter code'),
        h('div.code-tiles', {}, [...s.code].map((ch, i) => h('span.code-tile', { style: { '--i': i } }, ch))),
        qrWrap,
      ),
    ),
    h(
      'div.lobby-right',
      {},
      h('h2.section-title', {}, 'The Contenders'),
      slots,
      h('div.start-row', {}, startBtn, startHint),
      h(
        'details.custom-prompts',
        {},
        h('summary', {}, '✍️ Write your own prompts ', promptCount),
        h('p.hint', {}, 'Use _____ for the blank. They get mixed into this game.'),
        promptForm,
        promptList,
      ),
    ),
  );

  async function start() {
    startBtn.disabled = true;
    const res = await send(EVENTS.HOST_START);
    if (!res.ok) update(state);
  }

  async function addPrompt(event) {
    event.preventDefault();
    const text = promptInput.value.trim();
    if (!text) return;
    const res = await send(EVENTS.HOST_ADD_PROMPT, { text });
    if (res.ok) {
      promptInput.value = '';
      sounds.submit();
    }
  }

  let lastCount = s.players.length;
  function update(s) {
    if (s.players.length > lastCount) sounds.join();
    lastCount = s.players.length;

    const items = [
      ...s.players,
      ...Array.from({ length: LIMITS.MAX_PLAYERS - s.players.length }, (_, i) => ({ emptySlot: i })),
    ];
    keyedList(
      slots,
      items,
      (item) => item.id ?? `empty-${item.emptySlot}`,
      (item) => h(item.id ? 'article.slot.is-filled' : 'div.slot.is-empty'),
      (el, item) => {
        if (!item.id) {
          fill(el, h('span', {}, 'Waiting…'));
          return;
        }
        const p = item;
        el.classList.toggle('is-offline', !p.connected);
        el.style.setProperty('--player-color', p.color);
        fill(el,
          p.id === s.vipId ? h('span.vip-crown', { title: 'VIP: can start the game from their phone' }, '⭐ VIP') : null,
          avatar(p, 'avatar-lg'),
          h('span.slot-name', {}, p.name),
          p.connected ? null : h('span.slot-status', {}, 'offline'),
          h(
            'button.kick',
            {
              type: 'button',
              'aria-label': `Remove ${p.name}`,
              title: `Remove ${p.name}`,
              onclick: () => {
                if (confirm(`Remove ${p.name} from the room?`)) send(EVENTS.HOST_KICK, { playerId: p.id });
              },
            },
            '✕',
          ),
        );
      },
    );

    const need = LIMITS.MIN_PLAYERS - s.players.length;
    startBtn.disabled = need > 0;
    startHint.textContent =
      need > 0
        ? `Need ${need} more player${need === 1 ? '' : 's'} to start`
        : s.players.length === LIMITS.MAX_PLAYERS
          ? 'Full house! Ready to rumble.'
          : 'Ready when you are! (The VIP can also start from their phone.)';

    const prompts = s.lobby.customPrompts;
    promptCount.textContent = prompts.length ? `(${prompts.length})` : '';
    fill(promptList,
      ...prompts.map((p) =>
        h(
          'li',
          {},
          h('span', {}, p.text),
          h(
            'button.prompt-remove',
            { type: 'button', 'aria-label': 'Remove prompt', onclick: () => send(EVENTS.HOST_REMOVE_PROMPT, { promptId: p.id }) },
            '✕',
          ),
        ),
      ),
    );
  }

  update(s);
  return { el, update };
}

async function showJoinInfo(code, urlEl, img, wrap) {
  const base = await joinBasePromise;
  urlEl.textContent = base.replace(/^https?:\/\//, '');
  shrinkToFit(urlEl);
  try {
    const { toDataURL } = await import(QR_LIBRARY);
    img.src = await toDataURL(`${base}/?room=${code}`, {
      margin: 1,
      width: 480,
      color: { dark: '#0d0b1f', light: '#fff6e0' },
    });
  } catch {
    wrap.hidden = true; // offline / CDN blocked: the URL + code still work
  }
}

/** Shrinks an element's font until its (single-line) text fits its width. */
function shrinkToFit(el, minPx = 16) {
  el.style.fontSize = '';
  let size = parseFloat(getComputedStyle(el).fontSize);
  while (el.scrollWidth > el.clientWidth && size > minPx) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

async function resolveJoinBase() {
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  if (!local) return location.origin;
  try {
    const { urls } = await (await fetch('/api/lan')).json();
    return urls[0] ?? location.origin;
  } catch {
    return location.origin;
  }
}

// ---------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------

function introScreen() {
  sounds.whoosh();
  const steps = [
    ['✍️', 'Write', 'Fill in the blanks on your phone. Two prompts each.'],
    ['🥊', 'Duel', "Your answer goes head-to-head with someone else's."],
    ['🗳️', 'Vote', 'Everyone else picks the funnier one. Votes = points.'],
  ];
  return {
    el: h(
      'section.intro',
      {},
      h('p.round-badge', {}, "Tonight's fight card"),
      h('h1.intro-title', {}, 'How to play'),
      h(
        'div.intro-steps',
        {},
        steps.map(([emoji, title, text], i) =>
          h(
            'article.intro-step.paper',
            { style: { '--i': i } },
            h('span.intro-emoji', {}, emoji),
            h('h3', {}, `${i + 1}. ${title}`),
            h('p', {}, text),
          ),
        ),
      ),
      h('p.intro-foot', {}, 'Round 2 points are doubled. The final round decides everything.'),
    ),
  };
}

// ---------------------------------------------------------------------------
// Answering (rounds 1 and 2, and the final)
// ---------------------------------------------------------------------------

function answeringScreen(s) {
  sounds.whoosh();
  const round = s.answer.roundNumber;
  return withStatusBoard(
    s,
    h('p.round-badge', { class: round === 2 ? 'is-double' : '' }, round === 2 ? 'Round 2 · Double points!' : 'Round 1'),
    h('h1.giant', {}, 'Write your answers!'),
    h('p.lead', {}, 'Check your phone: you have two prompts. Make them funny.'),
  );
}

function finalAnswerScreen(s) {
  sounds.whoosh();
  return withStatusBoard(
    s,
    h('p.round-badge.is-final', {}, 'Final round'),
    h('div.prompt-banner.paper', {}, s.finalAnswer.prompt.text),
    h('p.lead', {}, 'Everyone answers this one! Each vote you get is worth 300 points.'),
  );
}

/** A heading plus a grid of "writing… / done!" cards that update live. */
function withStatusBoard(s, ...heading) {
  const board = h('div.status-board');
  const el = h('section.answering', {}, ...heading, board);
  let lastWaiting = null;

  function update(s) {
    const waiting = s.answer?.waitingOn ?? s.finalAnswer?.waitingOn ?? [];
    if (lastWaiting !== null && waiting.length < lastWaiting) sounds.submit();
    lastWaiting = waiting.length;
    keyedList(
      board,
      s.players,
      (p) => p.id,
      () => h('div.status-card'),
      (el, p) => {
        const done = !waiting.includes(p.id);
        el.classList.toggle('is-done', done);
        el.classList.toggle('is-offline', !p.connected);
        el.style.setProperty('--player-color', p.color);
        fill(el,
          avatar(p, 'avatar-lg'),
          h('span.status-name', {}, p.name),
          h('span.status-label', { class: done || !p.connected ? '' : 'is-writing' }, done ? 'Done!' : p.connected ? 'Writing' : 'Away'),
        );
      },
    );
  }
  update(s);
  return { el, update };
}

// ---------------------------------------------------------------------------
// Matchups (rounds 1 and 2): voting, then the reveal
// ---------------------------------------------------------------------------

function matchupScreen(s) {
  const v = s.vote;
  const isReveal = v.step === 'reveal';
  // A normal matchup already showed its cards during voting, so the reveal
  // starts right away. Mind Melds and forfeits skip voting, so their reveal
  // first plays the entrance animation, then shows the results.
  const fresh = !isReveal || v.kind !== 'normal';
  const resultDelay = isReveal ? (fresh ? 2200 : 300) : null;

  const cards = [0, 1].map((i) => answerCard(v, i));
  const status = h('p.vote-status');
  const stamp = h('div.stamp-slot');

  const el = h(
    'section.matchup',
    { class: `${fresh ? 'is-fresh' : ''} ${isReveal ? 'is-reveal' : ''}`, style: { '--result-delay': `${resultDelay ?? 0}ms` } },
    h('p.matchup-count', {}, `Round ${v.roundNumber} · Matchup ${v.index + 1} of ${v.total}`),
    h('div.prompt-banner.paper', {}, v.promptText),
    h('div.fight', {}, cards[0].el, h('div.vs', {}, 'VS'), cards[1].el),
    status,
    stamp,
  );

  if (fresh) later(500, () => sounds.whoosh());

  if (!isReveal) {
    const update = (s) => {
      const { votedCount, eligibleCount } = s.vote;
      fill(status,
        h('span', {}, 'Vote on your phones!'),
        h('span.vote-tally', {}, `${votedCount} / ${eligibleCount} voted`),
      );
    };
    update(s);
    let lastVoted = v.votedCount;
    return {
      el,
      update: (s) => {
        if (s.vote.votedCount > lastVoted) sounds.submit();
        lastVoted = s.vote.votedCount;
        update(s);
      },
    };
  }

  // ----- Reveal -----
  const r = v.result;
  later(resultDelay, () => {
    el.classList.add('show-results', `kind-${r.kind}`);
    cards.forEach((card) => card.reveal(s, r));
    if (r.kind === 'mindmeld') {
      sounds.mindmeld();
      stamp.replaceChildren(h('div.stamp.stamp-meld', {}, 'MIND MELD!'));
      status.textContent = 'Great minds think alike… so nobody scores.';
    } else if (r.kind === 'forfeit') {
      sounds.reveal();
      stamp.replaceChildren(h('div.stamp.stamp-forfeit', {}, 'Forfeit!'));
      status.textContent = 'Only one answer showed up. Free points!';
    } else if (r.kind === 'novotes') {
      sounds.reveal();
      status.textContent = 'Nobody voted?! The points are split evenly.';
    } else {
      sounds.reveal();
      const total = r.voterIds[0].length + r.voterIds[1].length;
      status.textContent = `${total} vote${total === 1 ? '' : 's'} counted`;
    }
  });

  if (r.sweep !== null) {
    later(resultDelay + 1700, () => {
      sounds.sweep();
      stamp.replaceChildren(h('div.stamp.stamp-sweep', {}, 'Clean Sweep!'));
      const side = r.sweep === 0 ? 0.25 : 0.75;
      confetti({ count: 200, x: side, y: 0.75 });
    });
  }

  return { el };
}

/** One answer card. reveal() fills in votes, voters, author, and points. */
function answerCard(v, i) {
  const text = v.answers[i];
  const resultEl = h('div.card-result');
  const el = h(
    `article.answer-card.${i === 0 ? 'corner-red' : 'corner-blue'}`,
    { class: text === null ? 'is-missing' : '', style: { '--i': i } },
    h('span.corner-label', {}, i === 0 ? 'Red corner' : 'Blue corner'),
    h('p.answer-text', {}, text ?? NO_ANSWER_TEXT),
    resultEl,
  );

  function reveal(s, r) {
    const author = playerById(s, r.authorIds[i]);
    const votes = r.voterIds[i].length;
    const total = r.voterIds[0].length + r.voterIds[1].length;
    const pct = total === 0 ? 0 : Math.round((votes / total) * 100);
    const won = r.points[i] > r.points[1 - i];
    el.classList.toggle('is-winner', won && r.kind !== 'mindmeld');
    el.classList.toggle('is-loser', !won && r.points[i] < r.points[1 - i]);

    const showVotes = r.kind === 'normal' || r.kind === 'novotes';
    fill(resultEl,
      showVotes
        ? h(
            'div.vote-meter',
            {},
            h('div.vote-fill', { style: { '--pct': `${pct}%` } }),
            h('span.vote-pct', {}, `${pct}%`),
          )
        : null,
      showVotes
        ? h(
            'div.voters',
            {},
            r.voterIds[i].map((id, k) => {
              const voter = playerById(s, id);
              return voter ? h('span.voter', { style: { '--k': k } }, avatar(voter)) : null;
            }),
          )
        : null,
      h('div.author', {}, author ? playerTag(author) : null),
      h('p.points', {}, `+${r.points[i].toLocaleString()}`),
    );
  }

  return { el, reveal };
}

// ---------------------------------------------------------------------------
// Leaderboard between rounds
// ---------------------------------------------------------------------------

function scoresScreen(s) {
  sounds.whoosh();
  const round = s.scores.roundNumber;
  const rowHeight = Math.min(84, Math.floor((window.innerHeight * 0.62) / s.players.length));
  const before = [...s.players].sort((a, b) => b.roundStartScore - a.roundStartScore);
  const after = [...s.players].sort((a, b) => b.score - a.score);
  const maxScore = Math.max(1, ...s.players.map((p) => p.score));

  const rows = new Map();
  for (const p of s.players) {
    const scoreEl = h('span.lb-score', {}, p.roundStartScore.toLocaleString());
    const rankEl = h('span.lb-rank');
    const fill = h('div.lb-fill', { style: { '--w': `${(p.roundStartScore / maxScore) * 100}%` } });
    const delta = p.score - p.roundStartScore;
    const row = h(
      'div.lb-row',
      { style: { '--player-color': p.color, '--y': '0px' } },
      rankEl,
      avatar(p),
      h('span.lb-name', {}, p.name),
      h('div.lb-bar', {}, fill),
      scoreEl,
      delta > 0 ? h('span.lb-delta', {}, `+${delta.toLocaleString()}`) : null,
    );
    rows.set(p.id, { row, scoreEl, rankEl, fill, player: p });
  }

  const place = (order) =>
    order.forEach((p, index) => {
      const r = rows.get(p.id);
      r.row.style.setProperty('--y', `${index * rowHeight}px`);
      r.rankEl.textContent = `#${index + 1}`;
    });
  place(before);

  const board = h('div.leaderboard', { style: { height: `${rowHeight * s.players.length}px`, '--row-h': `${rowHeight}px` } }, [...rows.values()].map((r) => r.row));

  later(900, () => {
    board.classList.add('is-updated');
    place(after);
    for (const r of rows.values()) {
      r.fill.style.setProperty('--w', `${(r.player.score / maxScore) * 100}%`);
      countUp(r.scoreEl, r.player.roundStartScore, r.player.score, 1400);
    }
    sounds.reveal();
  });

  return {
    el: h(
      'section.scores',
      {},
      h('p.round-badge', {}, `After round ${round}`),
      h('h1.giant', {}, 'Standings'),
      board,
      h('p.lead.scores-foot', {}, round === 1 ? 'Round 2 is next. Points double!' : 'Next up: the final round!'),
    ),
  };
}

/** Animates a number from `from` to `to` over `ms` milliseconds. */
function countUp(el, from, to, ms) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    el.textContent = Math.round(from + (to - from) * eased).toLocaleString();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Final round: voting and the one-by-one reveal
// ---------------------------------------------------------------------------

function finalVoteScreen(s) {
  sounds.whoosh();
  const fv = s.finalVote;
  const status = h('p.vote-status');
  const letters = 'ABCDEFGH';
  let lastVoted = fv.votedCount;

  const update = (s) => {
    const { votedCount, eligibleCount } = s.finalVote;
    if (votedCount > lastVoted) sounds.submit();
    lastVoted = votedCount;
    fill(status,
      h('span', {}, 'You have 3 votes. Stack them if you love one!'),
      h('span.vote-tally', {}, `${votedCount} / ${eligibleCount} voted`),
    );
  };
  update(s);

  return {
    el: h(
      'section.final-vote',
      {},
      h('p.round-badge.is-final', {}, 'Final round · Vote!'),
      h('div.prompt-banner.paper.is-compact', {}, fv.promptText),
      h(
        'div.ballot-grid',
        { dataset: { count: fv.ballot.length } },
        fv.ballot.map((b, i) =>
          h(
            'article.ballot-card.paper',
            { style: { '--i': i, '--tilt': `${(i % 2 === 0 ? -1 : 1) * (1 + (i % 3))}deg` } },
            h('span.ballot-letter', {}, letters[i]),
            h('p.ballot-text', {}, b.text),
          ),
        ),
      ),
      status,
    ),
    update,
  };
}

function finalResultsScreen(s) {
  const fr = s.finalResults;
  const spotlight = h('div.spotlight');
  const ladder = h('ol.ladder');
  const counter = h('p.matchup-count');
  let shown = 0;

  const el = h(
    'section.final-results',
    {},
    h('p.round-badge.is-final', {}, 'Final round results'),
    h('div.prompt-banner.paper.is-compact', {}, fr.promptText),
    counter,
    h('div.final-layout', {}, spotlight, ladder),
  );

  function update(s) {
    const { revealed, total } = s.finalResults;
    if (revealed.length === shown) return;
    shown = revealed.length;
    counter.textContent = `Answer ${shown} of ${total}`;

    const current = revealed[revealed.length - 1];
    const isTop = shown === total;
    const author = playerById(s, current.authorId);
    fill(spotlight,
      h(
        'article.spot-card.paper',
        { class: isTop ? 'is-top' : '' },
        isTop ? h('span.top-crown', {}, '👑 Top answer') : null,
        h('p.spot-text', {}, current.text),
        h(
          'div.spot-voters',
          {},
          current.voterIds.map((id, k) => {
            const voter = playerById(s, id);
            return voter ? h('span.voter', { style: { '--k': k } }, avatar(voter)) : null;
          }),
        ),
        h(
          'div.spot-footer',
          {},
          h('span.spot-votes', {}, `${current.votes} vote${current.votes === 1 ? '' : 's'}`),
          author ? playerTag(author, 'spot-author') : null,
          h('span.points', {}, `+${current.points.toLocaleString()}`),
        ),
      ),
    );

    // Earlier answers move to the side list (fewest votes at the top).
    fill(ladder,
      ...revealed.slice(0, -1).map((r, i, list) => {
        const p = playerById(s, r.authorId);
        return h(
          'li.ladder-row',
          { class: i === list.length - 1 ? 'is-new' : '' },
          p ? avatar(p) : null,
          h('span.ladder-text', {}, r.text),
          h('span.ladder-votes', {}, `${r.votes}★`),
        );
      }),
    );

    later(700, () => sounds.reveal());
    if (isTop) {
      later(1900, () => {
        sounds.sweep();
        confetti({ count: 220, x: 0.35, y: 0.7 });
      });
    }
  }

  update(s);
  return { el, update };
}

// ---------------------------------------------------------------------------
// Game over
// ---------------------------------------------------------------------------

function gameOverScreen(s) {
  const standings = s.gameOver.standings;
  const winners = standings.filter((st) => st.rank === 1).map((st) => playerById(s, st.id));
  const tie = winners.length > 1;

  later(300, () => {
    sounds.win();
    confettiCannons();
  });
  later(1600, () => confetti({ count: 160, x: 0.5, y: 0.6 }));
  later(3200, () => confettiCannons());

  const againBtn = h('button.btn.btn-red.btn-huge', { type: 'button', onclick: () => playAgain(true) }, 'Play Again (same players)');
  const newBtn = h('button.btn.btn-ghost.btn-wide', { type: 'button', onclick: () => playAgain(false) }, 'New Game');

  async function playAgain(samePlayers) {
    againBtn.disabled = true;
    newBtn.disabled = true;
    const res = await send(EVENTS.HOST_PLAY_AGAIN, { samePlayers });
    if (!res.ok) {
      againBtn.disabled = false;
      newBtn.disabled = false;
    }
  }

  return {
    el: h(
      'section.game-over',
      {},
      h(
        'div.champion',
        {},
        h('p.round-badge', {}, tie ? "It's a tie!" : 'And the winner is…'),
        h(
          'div.champ-row',
          {},
          winners.map((w) =>
            h(
              'div.champ',
              { style: { '--player-color': w.color } },
              h('span.champ-belt', {}, '🏆'),
              avatar(w, 'avatar-hero'),
              h('h1.champ-name', {}, w.name),
            ),
          ),
        ),
        h('p.champ-score', {}, `${standings[0].score.toLocaleString()} points`),
      ),
      h(
        'div.over-side',
        {},
        h(
          'ol.final-standings',
          {},
          standings.map((st, i) => {
            const p = playerById(s, st.id);
            return h(
              'li.standing',
              { style: { '--i': i, '--player-color': p.color } },
              h('span.standing-rank', {}, `#${st.rank}`),
              playerTag(p),
              h('span.standing-score', {}, st.score.toLocaleString()),
            );
          }),
        ),
        h('div.over-actions', {}, againBtn, newBtn, h('p.hint', {}, 'New Game goes back to the lobby so people can join or leave.')),
      ),
    ),
  };
}

// ---------------------------------------------------------------------------
// Misc screens, mute, storage
// ---------------------------------------------------------------------------

function replacedScreen() {
  return {
    el: h(
      'section.center-message',
      {},
      h('h1.giant', {}, 'This room moved to another screen'),
      h('p.lead', {}, 'It was opened in another tab or window.'),
      h('button.btn.btn-huge', { type: 'button', onclick: openRoom }, 'Show it here instead'),
    ),
  };
}

function renderMute() {
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-label', isMuted() ? 'Sound off' : 'Sound on');
}
muteBtn.addEventListener('click', () => {
  setMuted(!isMuted());
  renderMute();
  if (!isMuted()) sounds.join();
});
renderMute();

function loadHostSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_KEY));
    return saved?.roomCode && saved?.hostToken ? saved : null;
  } catch {
    return null;
  }
}
