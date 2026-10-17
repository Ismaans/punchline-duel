/**
 * shared/dom.js — a tiny helper for building HTML elements in JavaScript.
 *
 *   h('button.big', { onclick: go, disabled: true }, 'Start')
 *
 * makes <button class="big" disabled>Start</button> with a click handler.
 *
 * SAFETY: text children always become text nodes (like textContent), never
 * HTML. So if a player names themselves "<script>…", it shows up literally
 * as those characters and can't run as code. Nothing in this project uses
 * innerHTML.
 */

/**
 * @param {string} tag      tag name plus optional classes: 'div.card.big'
 * @param {object} [props]  attributes, properties, and on* event handlers
 * @param {...any} children strings/numbers (as text), elements, arrays, or null
 */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.classList.add(...classes);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      el.classList.add(...String(value).split(/\s+/).filter(Boolean));
    } else if (key === 'style') {
      // Supports CSS variables too: { '--color': '#f00' }
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in el && !key.includes('-')) {
      el[key] = value; // DOM properties: value, disabled, maxLength, type, ...
    } else {
      el.setAttribute(key, value === true ? '' : String(value)); // aria-*, data-*, etc.
    }
  }
  append(el, children);
  return el;
}

/**
 * Replaces an element's children. Like the built-in el.replaceChildren(),
 * but skips null/false (the built-in would print the word "null").
 */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

/** A player's emoji in a colored circle. */
export function avatar(player, extraClass = '') {
  return h(
    `span.avatar${extraClass ? `.${extraClass}` : ''}`,
    { style: { '--player-color': player.color }, 'aria-hidden': 'true' },
    player.avatar,
  );
}

/** Avatar + name, in the player's color. */
export function playerTag(player, extraClass = '') {
  return h(
    `span.player-tag${extraClass ? `.${extraClass}` : ''}`,
    { style: { '--player-color': player.color } },
    avatar(player),
    h('span.player-tag-name', {}, player.name),
  );
}

/** Finds a player by id in a room:state payload. */
export function playerById(state, id) {
  return state.players.find((p) => p.id === id);
}

/** Simple toast message that fades out on its own. */
export function toast(message, { error = false } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div.toast', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle('is-error', error);
  el.classList.remove('is-visible');
  void el.offsetWidth; // restart the CSS animation
  el.classList.add('is-visible');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
