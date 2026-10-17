/**
 * shared/confetti.js — a small canvas confetti effect (no library).
 *
 * Each piece of confetti is an object with a position, velocity, spin, and
 * color. Every animation frame we move them a little, apply "gravity" and
 * "air resistance", and redraw. When all pieces fall off-screen, we stop.
 */

import { prefersReducedMotion } from './dom.js';

const COLORS = ['#ff4f6d', '#2ec4f1', '#ffe14d', '#3ddc97', '#ff9f1c', '#ff7ad9', '#ffffff'];
let canvas = null;
let pieces = [];
let running = false;

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '50' });
  document.body.appendChild(canvas);
  const resize = () => {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
  };
  resize();
  window.addEventListener('resize', resize);
  return canvas;
}

/**
 * Fires a burst of confetti.
 * @param {{ count?: number, x?: number, y?: number, spread?: number }} options
 *        x/y are 0–1 fractions of the screen (default: bottom center, shooting up)
 */
export function confetti({ count = 160, x = 0.5, y = 0.9, spread = 1 } = {}) {
  const c = ensureCanvas();
  const n = prefersReducedMotion() ? Math.round(count / 4) : count;
  const scale = devicePixelRatio;
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9 * spread;
    const speed = (12 + Math.random() * 14) * scale;
    pieces.push({
      x: x * c.width,
      y: y * c.height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: (6 + Math.random() * 8) * scale,
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      wobble: Math.random() * 10,
    });
  }
  if (!running) {
    running = true;
    requestAnimationFrame(frame);
  }
}

/** Two cannons from the bottom corners. */
export function confettiCannons() {
  confetti({ count: 120, x: 0.05, y: 1, spread: 0.6 });
  confetti({ count: 120, x: 0.95, y: 1, spread: 0.6 });
}

function frame() {
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  const gravity = 0.45 * devicePixelRatio;

  for (const p of pieces) {
    p.vx *= 0.985; // air resistance
    p.vy = p.vy * 0.985 + gravity;
    p.x += p.vx + Math.sin((p.wobble += 0.1)) * devicePixelRatio;
    p.y += p.vy;
    p.rotation += p.spin;

    g.save();
    g.translate(p.x, p.y);
    g.rotate(p.rotation);
    g.fillStyle = p.color;
    // Squash the width with cos() so pieces look like they're flipping.
    g.fillRect(-p.size / 2, -p.size / 4, p.size * Math.abs(Math.cos(p.rotation * 2)), p.size / 2);
    g.restore();
  }

  pieces = pieces.filter((p) => p.y < canvas.height + 50);
  if (pieces.length > 0) requestAnimationFrame(frame);
  else {
    running = false;
    g.clearRect(0, 0, canvas.width, canvas.height);
  }
}
