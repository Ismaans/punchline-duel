// Aggregate metrics for server/prompts.json, plus a projection of what a
// dataset import would add under the semantic mapping (dataset final-round
// prompts → final: true; head-to-head prompts → final: false).
//
// Usage: node scripts/prompt-metrics.mjs

import { readFileSync } from 'node:fs';

const SERVER_FILE = new URL('../server/prompts.json', import.meta.url).pathname;
const DATASET = new URL('../datasets/quiplash/all-prompts.json', import.meta.url).pathname;

const prompts = JSON.parse(readFileSync(SERVER_FILE, 'utf8'));
const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));

const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;

// ── Composition ──
const regulars = prompts.filter((p) => !p.final);
const finals = prompts.filter((p) => p.final);
console.log('COMPOSITION');
console.log(`  total:    ${prompts.length}`);
console.log(`  regular:  ${regulars.length}  (rounds 1/2 bank — head-to-head)`);
console.log(`  final:    ${finals.length}  (final-round bank — everyone answers)`);

// ── Capacity: games before a room recycles prompts ──
// Rounds 1+2 each draw one prompt per player; the final draws exactly one.
console.log('\nCAPACITY (games in one room before the bank must recycle)');
for (const players of [4, 6, 8, 10]) {
  const regularGames = Math.floor(regulars.length / (2 * players));
  console.log(`  ${players} players: regulars last ~${regularGames} games, finals last ${finals.length} games`);
}

// ── Integrity ──
const ids = new Set(prompts.map((p) => p.id));
const texts = new Set(prompts.map((p) => key(p.text)));
console.log('\nINTEGRITY');
console.log(`  unique ids:        ${ids.size === prompts.length}`);
console.log(`  duplicate texts:   ${prompts.length - texts.size}`);
console.log(`  has _____ blank:   ${prompts.filter((p) => p.text.includes('_____')).length}/${prompts.length}`);

// ── Blank placement (how the punchline lands) ──
const placement = {
  'mid-sentence (_____ then more text)': prompts.filter((p) => p.text.includes('_____') && !p.text.trimEnd().endsWith('_____')).length,
  'trailing ": _____"': prompts.filter((p) => p.text.endsWith(': _____')).length,
  'trailing "? _____" / "! _____"': prompts.filter((p) => /[?!] _____$/.test(p.text)).length,
  'other trailing': prompts.filter((p) => p.text.trimEnd().endsWith('_____') && !p.text.endsWith(': _____') && !/[?!] _____$/.test(p.text)).length,
};
console.log('\nBLANK PLACEMENT');
for (const [k, v] of Object.entries(placement)) console.log(`  ${k}: ${v} (${pct(v, prompts.length)})`);

// ── Length ──
const lens = prompts.map((p) => p.text.length).sort((a, b) => a - b);
const median = lens[Math.floor(lens.length / 2)];
console.log('\nLENGTH (chars)');
console.log(`  min ${lens[0]} / median ${median} / p90 ${lens[Math.floor(lens.length * 0.9)]} / max ${lens[lens.length - 1]}`);
console.log(`  mean ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)}`);

// ── Flavor: top signature words ──
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'you', 'your', 'that', 'would', 'what', 'is', 'it', 'and', 'or', 'at', 'be', 'this', 'are', 'was', 'with', 'have', 'from', 'they', 'their', 'someone', 'something', 'one', 'out', 'about', 'when', 'if', 'do', 'does', 'did', 'ever', 'never', 'could', 'should', 'say', 'says', 'said', 'way', 'get', 'got', 'new', 'first', 'last', 'thing', 'things', 'worst', 'best', 'name']);
const freq = new Map();
for (const p of prompts) {
  for (const w of p.text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/)) {
    if (w.length > 2 && !STOP.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
}
const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('\nTOP THEMES (content words, excluding generic ones)');
console.log(`  ${top.map(([w, n]) => `${w} (${n})`).join(', ')}`);

// ── Projection: dataset import under the semantic mapping ──
// final:true  ⇐ dataset says it was a final-round prompt (Quiplash 3 finals)
// final:false ⇐ head-to-head prompts (q1, q2, q2-audience, q3 rounds 1/2)
const existing = new Set(prompts.map((p) => key(p.text)));
const seen = new Set();
const eligible = dataset.filter((p) => {
  if (p.adult || p.text.includes('{player}')) return false;
  const k = key(p.text);
  if (!k || existing.has(k) || seen.has(k)) return false;
  seen.add(k);
  return true;
});
const projFinals = eligible.filter((p) => p.final).length;
const projRegulars = eligible.length - projFinals;
console.log('\nPROJECTION — importing the dataset with the semantic mapping');
console.log(`  eligible after adult / {player} / dupe filters: ${eligible.length} of ${dataset.length}`);
console.log(`  → new regulars (head-to-head): +${projRegulars}  → regular bank: ${regulars.length + projRegulars}`);
console.log(`  → new finals (Last-Lash style): +${projFinals}  → final bank: ${finals.length + projFinals}`);
const players = 8;
console.log(`  at ${players} players: regulars would last ~${Math.floor((regulars.length + projRegulars) / (2 * players))} games (vs ~${Math.floor(regulars.length / (2 * players))} today)`);
