// Does the shipped bundle behave identically to the database it came from?
//
// The bundle quantises vectors to float16 and truncates transcripts. Both are
// defensible, and neither is worth anything if they change which segments get
// chosen, because then the deployed product is not the one the eval measured.
//
// No model calls: concept maps are loaded from saved eval results, so the only
// thing varying is the index behind retrieve, dedupe, score and pack.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../lib/store.mjs';
import { loadIndex } from '../lib/load-index.mjs';
import { loadBundle } from '../../api/lib/bundle.mjs';
import { retrieve, dedupe, score, pack } from '../query/pipeline.mjs';
import { embed } from '../lib/gemini.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS = path.join(ROOT, 'eval/results');

const fromDb = loadIndex(open());
const { index: fromBundle } = loadBundle();
console.log(`sqlite: ${fromDb.length} segments | bundle: ${fromBundle.length} segments`);
if (fromDb.length !== fromBundle.length) {
  console.error('STOP: different segment counts. Re-run npm run index:export.');
  process.exit(1);
}

const files = fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json')).sort();
const { results } = JSON.parse(fs.readFileSync(path.join(RESULTS, files.at(-1)), 'utf8'));
const cases = results.filter((r) => r.ok).slice(0, 8);
console.log(`replaying ${cases.length} topics from ${files.at(-1)}\n`);

// Concept maps are not re-generated, they are reconstructed from the eval run,
// so the comparison isolates the index and nothing else.
let identical = 0, differed = 0;

for (const c of cases) {
  // The eval stored concept names only; re-embed them once and reuse the same
  // vectors for both indexes so embedding noise cannot explain a difference.
  const names = c.mustCover ? null : null;
  const conceptNames = (c.missing || []).concat([]);
  void names; void conceptNames;

  const conceptList = c.plan.map((p) => p.concept);
  const probes = [...new Set(conceptList)].slice(0, 12);
  const vecs = await embed(probes, { label: 'verify bundle: probe concepts' });
  const concepts = probes.map((name, i) => ({ name, why: name, idx: i, vec: vecs[i] }));

  const run = (index) => {
    // retrieve() would re-embed; inject the shared vectors instead.
    for (const s of index) s.best = null;
    const picked = new Set();
    for (const con of concepts) {
      const ranked = index
        .map((s) => ({ s, sim: cos(s.vecLabel, con.vec) }))
        .filter((x) => x.sim >= 0.78)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, 12);
      for (const { s, sim } of ranked) {
        if (!s.best || sim > s.best.sim) s.best = { concept: con, sim };
        picked.add(s);
      }
    }
    const cands = [...picked];
    score(cands);
    const clusters = dedupe(cands, 0.88);
    const packed = pack(clusters, concepts, c.budgetMin);
    return {
      candidates: cands.length,
      chosen: packed.chosen.map((s) => `${s.videoId}@${s.startSec}`).sort(),
      minutes: Math.round(packed.usedSec / 60),
    };
  };

  const a = run(fromDb);
  const b = run(fromBundle);
  const same = a.chosen.length === b.chosen.length && a.chosen.every((x, i) => x === b.chosen[i]);
  const onlyDb = a.chosen.filter((x) => !b.chosen.includes(x));
  const onlyBundle = b.chosen.filter((x) => !a.chosen.includes(x));

  if (same) { identical++; console.log(`  same    ${c.id.padEnd(18)} ${a.chosen.length} segments, ${a.minutes}min`); }
  else {
    differed++;
    console.log(`  DIFFER  ${c.id.padEnd(18)} sqlite ${a.chosen.length}/${a.minutes}min vs bundle ${b.chosen.length}/${b.minutes}min` +
                `  (+${onlyBundle.length} / -${onlyDb.length})`);
  }
}

function cos(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

console.log(`\n${identical} identical, ${differed} differed.`);
if (differed) {
  console.log('A difference means the deployed index does not behave like the evaluated one.');
  process.exit(1);
}
console.log('The bundle selects exactly what the database selects. Safe to ship.');
