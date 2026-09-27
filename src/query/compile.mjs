// Compile one learning plan from the terminal.
//
//   node src/query/compile.mjs "how RAG works" 120
//   node src/query/compile.mjs "how transformers work" 90 --json out.json
//
// Iterating on plan quality happens here, not in a browser, because the loop is
// seconds long and the output is inspectable.

import fs from 'node:fs';
import { open } from '../lib/store.mjs';
import { conceptMap, loadIndex, retrieve, dedupe, score, pack, order, verify } from './pipeline.mjs';
import { spentInr, BUDGET_INR } from '../lib/spend.mjs';

const argv = process.argv.slice(2);
const topic = argv[0];
const budgetMin = parseInt(argv[1] || '120', 10);
const jsonAt = argv.indexOf('--json');
const quiet = argv.includes('--quiet');

if (!topic) {
  console.error('usage: node src/query/compile.mjs "<topic>" [minutes] [--json path] [--quiet]');
  process.exit(1);
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const link = (s) => `https://youtube.com/watch?v=${s.videoId}&t=${s.startSec}s`;
const say = (...a) => { if (!quiet) console.log(...a); };

const startSpend = spentInr();
const t0 = Date.now();

const db = open();
const index = loadIndex(db);
if (!index.length) {
  console.error('the index is empty. run `npm run index:candidates` then `npm run index:run`.');
  process.exit(1);
}
say(`index: ${index.length} segments\n`);

// 1
const concepts = await conceptMap(topic);
say(`concepts (${concepts.length}):`);
concepts.forEach((c, i) => say(`  ${String(i + 1).padStart(2)}. ${c.name}`));

// 2 to 5
// Order matters: retrieve attaches each segment's best concept, score reads
// that similarity, and pack reads the score when choosing cluster representatives.
const candidates = await retrieve(index, concepts);
score(candidates);
const clusters = dedupe(candidates, 0.88);
const packed = pack(clusters, concepts, budgetMin);

say(`\nretrieved ${candidates.length} -> ${clusters.length} distinct -> packed ${packed.chosen.length}`);
say(`${Math.round(packed.usedSec / 60)} of ${budgetMin} min${packed.budgetMet ? '' : '  [UNDER BUDGET]'}` +
    ` | ${new Set(packed.chosen.map((s) => s.channel)).size} creators` +
    ` | depth ${Object.entries(packed.depthCount).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (Object.keys(packed.depthShortfall).length)
  say(`depth shortfall: ${JSON.stringify(packed.depthShortfall)} (index is thin on these)`);

// 6
const segs = packed.chosen.map((s, i) => ({ ...s, pid: i }));
const ordered = await order(topic, budgetMin, concepts, segs);
const byPid = new Map(segs.map((s) => [s.pid, s]));
const sequence = ordered.plan.map((p) => ({ ...byPid.get(p.id), why: p.why })).filter((s) => s.pid !== undefined);

say(`\nordered by ${ordered.model}${ordered.escalated ? ' (escalated after retries failed)' : ''}` +
    ` in ${ordered.tries.reduce((a, t) => a + t.ms, 0)}ms over ${ordered.tries.length} call(s)`);
for (const t of ordered.tries) if (!t.check.ok)
  say(`  attempt on ${t.model}: dropped ${t.check.dropped.length}, duplicated ${t.check.duplicated.length}, invented ${t.check.invented.length}`);

// 7
const v = await verify(sequence, budgetMin);

// 8
console.log(`\n${'='.repeat(78)}`);
console.log(`${topic}  |  ${Math.round(v.totalSec / 60)} minutes  |  ${sequence.length} segments`);
console.log('='.repeat(78));

sequence.forEach((s, i) => {
  const sem = v.semantic.get(i);
  const flag = sem && !sem.delivers ? '  [does not deliver its concept]' : '';
  console.log(`\n${String(i + 1).padStart(2)}. ${s.concept}${flag}`);
  console.log(`    ${Math.round(s.durationSec / 60)} min  ${mmss(s.startSec)}-${mmss(s.endSec)}  ${s.depth}  ${s.channel}`);
  console.log(`    ${s.why}`);
  console.log(`    ${link(s)}`);
});

console.log(`\n${'-'.repeat(78)}`);
if (packed.missing.length) {
  console.log(`Not covered, because nothing good enough is indexed:`);
  for (const m of packed.missing) console.log(`  - ${m.name}`);
} else {
  console.log('Every concept in the map is covered.');
}
if (v.mechanicalFailures.length) {
  console.log(`\nMechanical problems:`);
  for (const f of v.mechanicalFailures) console.log(`  segment ${f.i + 1}: ${f.issues.join('; ')}`);
}
if (v.mismatches.length) {
  console.log(`\n${v.mismatches.length} segment(s) may not deliver what they claim:`);
  for (const m of v.mismatches) console.log(`  segment ${m.i + 1}: ${m.note}`);
}

console.log(`\ncompiled in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
            ` | this query cost Rs ${(spentInr() - startSpend).toFixed(3)}` +
            ` | project total Rs ${spentInr().toFixed(2)} of Rs ${BUDGET_INR}`);

if (jsonAt >= 0 && argv[jsonAt + 1]) {
  fs.writeFileSync(argv[jsonAt + 1], JSON.stringify({
    topic, budgetMin, concepts,
    stats: { index: index.length, candidates: candidates.length, clusters: clusters.length, ...packed, chosen: undefined },
    ordering: { model: ordered.model, escalated: ordered.escalated, tries: ordered.tries },
    plan: sequence.map((s) => ({
      videoId: s.videoId, title: s.title, channel: s.channel, concept: s.concept, teaches: s.teaches,
      depth: s.depth, startSec: s.startSec, endSec: s.endSec, durationSec: s.durationSec,
      why: s.why, url: link(s),
    })),
    verify: { ...v, semantic: [...v.semantic.values()] },
    costInr: +(spentInr() - startSpend).toFixed(4),
  }, null, 2));
  console.log(`wrote ${argv[jsonAt + 1]}`);
}
