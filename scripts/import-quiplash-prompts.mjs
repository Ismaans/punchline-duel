// Imports datasets/quiplash/all-prompts.json into server/prompts.json.
//
// Mapping (the semantic rule):
//   - dataset final-round prompts (Quiplash 3 Last Lash) → `final: true`
//     (one prompt, the whole room answers — broad, big answer space)
//   - everything else (q1, q2, q2-audience, q3 rounds 1/2) → `final: false`
//     (head-to-head prompts for rounds 1/2)
//
// Rules:
//   - Every prompt must contain the `_____` blank, matching server format.
//     Dataset prompts without one get it appended (": _____", or " _____"
//     after a question mark) — the same style as the hand-written prompts.
//   - Skips adult-flagged prompts (the shipped bank is family-safe) and
//     prompts with a {player} placeholder (the server can't render names).
//   - Skips duplicates (against existing server prompts and within the import).
//   - New ids continue each bank's series (p151+, f023+).
//   - Output order: regulars first, finals at the bottom.
//
// Usage: node scripts/import-quiplash-prompts.mjs

import { readFileSync, writeFileSync } from 'node:fs';

const DATASET = new URL('../datasets/quiplash/all-prompts.json', import.meta.url).pathname;
const SERVER_FILE = new URL('../server/prompts.json', import.meta.url).pathname;

/** Guarantees the server blank format: keep an existing _____; otherwise
 * append one in the house style. */
function toBlankFormat(text) {
  if (text.includes('_____')) return text;
  if (/[?!]$/.test(text)) return `${text} _____`;
  return `${text.replace(/[.:]\s*$/, '')}: _____`;
}

/** Aggressive key for duplicate detection (ignores blanks, case, punctuation). */
const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '');

const dataset = JSON.parse(readFileSync(DATASET, 'utf8'));
const existing = JSON.parse(readFileSync(SERVER_FILE, 'utf8'));

const seen = new Set(existing.map((p) => key(p.text)));
const lastIdNum = (prefix) =>
  existing.reduce(
    (max, p) => (new RegExp(`^${prefix}(\\d+)$`).test(p.id) ? Math.max(max, Number(p.id.slice(1))) : max),
    0,
  );
const next = { p: lastIdNum('p'), f: lastIdNum('f') };

const skipped = { adult: 0, playerName: 0, duplicate: 0, empty: 0 };
const imported = { regular: [], final: [] };

for (const p of dataset) {
  if (p.adult) { skipped.adult += 1; continue; }
  if (p.text.includes('{player}')) { skipped.playerName += 1; continue; }
  const text = toBlankFormat(p.text);
  const k = key(text);
  if (!k) { skipped.empty += 1; continue; }
  if (seen.has(k)) { skipped.duplicate += 1; continue; }
  seen.add(k);
  const final = p.final === true;
  const prefix = final ? 'f' : 'p';
  next[prefix] += 1;
  imported[final ? 'final' : 'regular'].push({
    id: `${prefix}${String(next[prefix]).padStart(3, '0')}`,
    text,
    final,
  });
}

// Regulars first, finals at the bottom.
const regulars = [...existing.filter((p) => !p.final), ...imported.regular];
const finals = [...existing.filter((p) => p.final), ...imported.final];
const line = (p) =>
  `  { "id": ${JSON.stringify(p.id)}, "text": ${JSON.stringify(p.text)}, "final": ${p.final} }`;
writeFileSync(SERVER_FILE, `[\n${[...regulars, ...finals].map(line).join(',\n')}\n]\n`);

// Sanity: re-parse and run the same validation the server does at startup.
const parsed = JSON.parse(readFileSync(SERVER_FILE, 'utf8'));
const ids = new Set();
for (const p of parsed) {
  if (typeof p.id !== 'string' || typeof p.text !== 'string' || ids.has(p.id)) {
    throw new Error(`Bad or duplicate prompt written: ${JSON.stringify(p)}`);
  }
  ids.add(p.id);
}

console.log(`imported:   ${imported.regular.length} regulars (p-series), ${imported.final.length} finals (f-series)`);
console.log(`skipped:    ${skipped.adult} adult, ${skipped.playerName} player-name, ${skipped.duplicate} duplicates, ${skipped.empty} empty`);
console.log(`totals:     ${parsed.length} prompts (${parsed.filter((p) => !p.final).length} regular, ${parsed.filter((p) => p.final).length} finals)`);
