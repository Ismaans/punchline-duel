/**
 * shared/sound.js — every sound effect, generated in code with the Web Audio API.
 *
 * No audio files: each sound is built from oscillators (pure tones) and
 * filtered noise, shaped with a quick volume "envelope" so it doesn't click.
 *
 * Browsers block audio until the user taps or clicks something, so pages
 * call unlockAudio() from their first interaction.
 */

const MUTE_KEY = 'pd-muted';
let ctx = null;
let master = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';

function audio() {
  if (!ctx) {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    ctx = new AudioCtor();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Call from a click/tap handler so later sounds are allowed to play. */
export function unlockAudio() {
  audio();
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  localStorage.setItem(MUTE_KEY, value ? '1' : '0');
}

/**
 * One note.
 * @param freq       starting pitch in Hz
 * @param at         seconds from now
 * @param duration   seconds
 * @param slideTo    optional pitch to glide to
 */
function tone({ freq, at = 0, duration = 0.15, type = 'sine', volume = 0.3, slideTo }) {
  const a = audio();
  if (!a || muted) return;
  const start = a.currentTime + at;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  // Envelope: fade in very fast, then fade out, so there's no "click".
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(master);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** A burst of filtered static, for whooshes and crowd-ish swells. */
function noise({ at = 0, duration = 0.4, volume = 0.2, from = 400, to = 4000 }) {
  const a = audio();
  if (!a || muted) return;
  const start = a.currentTime + at;
  const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * duration), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = a.createBufferSource();
  src.buffer = buffer;
  const filter = a.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.2;
  filter.frequency.setValueAtTime(from, start);
  filter.frequency.exponentialRampToValueAtTime(to, start + duration);
  const gain = a.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + duration * 0.3);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  src.connect(filter).connect(gain).connect(master);
  src.start(start);
}

/** Note names → Hz, so melodies below are readable. */
const N = { C4: 261.6, E4: 329.6, G4: 392, A4: 440, C5: 523.3, D5: 587.3, E5: 659.3, G5: 784, A5: 880, C6: 1046.5 };

export const sounds = {
  /** Someone joined the lobby: two bright rising blips. */
  join() {
    tone({ freq: N.G4, duration: 0.09, type: 'square', volume: 0.12 });
    tone({ freq: N.C5, at: 0.08, duration: 0.14, type: 'square', volume: 0.12 });
  },

  /** An answer or vote was submitted: a soft "pop". */
  submit() {
    tone({ freq: 380, slideTo: 900, duration: 0.09, type: 'triangle', volume: 0.3 });
  },

  /** Last-seconds countdown tick. */
  tick() {
    tone({ freq: 1400, duration: 0.04, type: 'square', volume: 0.08 });
  },

  /** 10 seconds left: two urgent beeps. */
  warning() {
    tone({ freq: N.A5, duration: 0.12, type: 'sawtooth', volume: 0.12 });
    tone({ freq: N.A5, at: 0.18, duration: 0.12, type: 'sawtooth', volume: 0.12 });
  },

  /** Cards sliding in. */
  whoosh() {
    noise({ duration: 0.45, volume: 0.18, from: 300, to: 5000 });
  },

  /** Vote counts / authors revealed: a quick upward arpeggio. */
  reveal() {
    [N.C5, N.E5, N.G5].forEach((freq, i) => tone({ freq, at: i * 0.07, duration: 0.18, type: 'triangle', volume: 0.22 }));
  },

  /** Clean Sweep! A brassy fanfare plus a crowd-like swell. */
  sweep() {
    const notes = [N.C5, N.E5, N.G5, N.C6];
    notes.forEach((freq, i) => tone({ freq, at: i * 0.11, duration: 0.25, type: 'sawtooth', volume: 0.12 }));
    tone({ freq: N.C6, at: 0.45, duration: 0.7, type: 'square', volume: 0.1 });
    tone({ freq: N.G5, at: 0.45, duration: 0.7, type: 'square', volume: 0.08 });
    noise({ at: 0.3, duration: 1.2, volume: 0.12, from: 800, to: 2500 });
  },

  /** Mind Meld: a wobbly, spooky "wooOOoo". */
  mindmeld() {
    tone({ freq: N.E4, slideTo: N.A5, duration: 0.6, type: 'sine', volume: 0.25 });
    tone({ freq: N.E4 * 1.01, slideTo: N.A5 * 0.99, duration: 0.6, type: 'sine', volume: 0.25 });
    tone({ freq: N.A5, at: 0.6, slideTo: N.C4, duration: 0.6, type: 'sine', volume: 0.2 });
  },

  /** Winner fanfare at game over. */
  win() {
    const melody = [N.C5, N.C5, N.C5, N.E5, N.D5, N.E5, N.G5];
    const times = [0, 0.12, 0.24, 0.4, 0.62, 0.78, 0.95];
    melody.forEach((freq, i) => tone({ freq, at: times[i], duration: 0.22, type: 'square', volume: 0.12 }));
    tone({ freq: N.C6, at: 1.15, duration: 0.9, type: 'triangle', volume: 0.25 });
    noise({ at: 1.0, duration: 1.4, volume: 0.1, from: 1000, to: 3000 });
  },

  /** Something went wrong. */
  error() {
    tone({ freq: 180, slideTo: 120, duration: 0.25, type: 'square', volume: 0.12 });
  },
};
