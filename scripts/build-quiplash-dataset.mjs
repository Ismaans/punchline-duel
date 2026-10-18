// Builds clean Quiplash prompt datasets from the raw files in datasets/quiplash.
//
// Sources:
//   - Quiplash 1/XL (EN): github.com/buddhsen-tripathi/bet-quipslop/blob/main/prompts.ts
//     (the official JackboxPartyPack-Localization repo's "en-us" Quiplash 1 file
//     actually contains Spanish text, kept here as QuiplashQuestion.es.jet)
//   - Quiplash 2 + extras: github.com/jackboxpt/JackboxPartyPack-Localization
//     (The Jackbox Party Pack 3, en-us)
//   - Quiplash 3: same repo (The Jackbox Party Pack 7, en-us)
//
// Usage: node scripts/build-quiplash-dataset.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../datasets/quiplash/', import.meta.url).pathname;

const SOURCE_URLS = {
  'quiplash-1':
    'https://github.com/buddhsen-tripathi/bet-quipslop/blob/main/prompts.ts',
  'quiplash-2':
    'https://github.com/jackboxpt/JackboxPartyPack-Localization/tree/main/en-us%20(default)/The%20Jackbox%20Party%20Pack%203/games/Quiplash2/content',
  'quiplash-3':
    'https://github.com/jackboxpt/JackboxPartyPack-Localization/tree/main/en-us%20(default)/The%20Jackbox%20Party%20Pack%207/games/Quiplash3/content',
};

function normalize(text) {
  return text
    .replace(/<BLANK>/g, '_____')
    .replace(/<ANY ?PLAYER>/g, '{player}')
    .replace(/<\/?i>/g, '')
    .replace(/_{2,}/g, '_____')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJet(relPath) {
  const data = JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
  return Array.isArray(data) ? data : data.content;
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const key = e.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Quiplash 1/XL: parse the English prompt list from the .ts source ──
function quiplash1() {
  const ts = readFileSync(
    join(ROOT, 'quiplash-1/english-prompts.ts'),
    'utf8',
  );
  const start = ts.indexOf('Quiplash XL / Quiplash 1');
  const end = ts.indexOf('Quiplash 2 ──');
  const section = ts.slice(start, end);
  const prompts = [];
  for (const match of section.matchAll(/^\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) {
    prompts.push(JSON.parse(`"${match[1]}"`));
  }
  return dedupe(
    prompts.map((text, i) => ({
      id: `q1-${String(i + 1).padStart(3, '0')}`,
      text: normalize(text),
      game: 'quiplash-1',
      final: false,
      adult: false,
    })),
  );
}

// ── Quiplash 2: official .jet question files ──
function quiplash2() {
  const main = readJet('quiplash-2/QuiplashQuestion.jet');
  const audience = readJet('quiplash-2/AudienceQuestion.jet');
  const toEntry = (prefix) => (e, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    sourceId: e.id,
    text: normalize(e.prompt),
    game: 'quiplash-2',
    final: false,
    adult: Boolean(e.x),
    ...(e.prompt.includes('<ANY PLAYER>') && { includesPlayerName: true }),
  });
  return {
    main: dedupe(main.map(toEntry('q2'))),
    audience: dedupe(audience.map(toEntry('q2a'))),
  };
}

// ── Quiplash 3: round 1 / round 2 / final ──
function quiplash3() {
  const files = [
    ['quiplash-3/Quiplash3Round1Question.jet', 'q3r1', 1, false],
    ['quiplash-3/Quiplash3Round2Question.jet', 'q3r2', 2, false],
    ['quiplash-3/Quiplash3FinalQuestion.jet', 'q3f', 3, true],
  ];
  const all = [];
  for (const [file, prefix, round, final] of files) {
    const entries = readJet(file).map((e, i) => ({
      id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
      sourceId: Number(e.id),
      text: normalize(e.prompt),
      game: 'quiplash-3',
      round,
      final,
      adult: Boolean(e.x),
      ...(e.us && { usCentric: true }),
      ...(e.includesPlayerName && { includesPlayerName: true }),
    }));
    all.push(...dedupe(entries));
  }
  return all;
}

// ── Extras: safety quips (fallback answers), AcroLash, WordLash ──
function extras() {
  const values = (rel) => readJet(rel).map((e) => e.value ?? e.prompt ?? e.quip);
  return {
    safetyQuips: {
      'quiplash-2': values('quiplash-2/SafetyQuips.jet'),
      'quiplash-3': values('quiplash-3/Quiplash3SafetyQuips.jet'),
    },
    acroLash: values('quiplash-2/AcroLash.jet'),
    wordLash: {
      templates: values('quiplash-2/WordLash.jet'),
      words: values('quiplash-2/WordLashWord.jet'),
    },
  };
}

const q1 = quiplash1();
const q2 = quiplash2();
const q3 = quiplash3();

const write = (rel, data) =>
  writeFileSync(join(ROOT, rel), `${JSON.stringify(data, null, 2)}\n`);

write('quiplash-1/prompts.json', q1);
write('quiplash-2/prompts.json', q2.main);
write('quiplash-2/audience-prompts.json', q2.audience);
write('quiplash-3/prompts.json', q3);
write('extras.json', extras());
write('all-prompts.json', [...q1, ...q2.main, ...q2.audience, ...q3]);
write('manifest.json', {
  generatedAt: new Date().toISOString(),
  sources: SOURCE_URLS,
  note: 'Quiplash is a trademark of Jackbox Games. Prompts are copyrighted game content extracted for personal/educational use.',
  counts: {
    'quiplash-1': q1.length,
    'quiplash-2': q2.main.length,
    'quiplash-2-audience': q2.audience.length,
    'quiplash-3': q3.length,
    total: q1.length + q2.main.length + q2.audience.length + q3.length,
  },
});

console.log('quiplash-1:', q1.length);
console.log('quiplash-2:', q2.main.length, `(+${q2.audience.length} audience)`);
console.log('quiplash-3:', q3.length);
console.log('total:', q1.length + q2.main.length + q2.audience.length + q3.length);
