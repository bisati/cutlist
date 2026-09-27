// Run the whole pipeline over the golden set and score every plan.
//
//   node eval/run.mjs                    the whole set
//   node eval/run.mjs --only rag-basics,agents
//   node eval/run.mjs --compare eval/results/2026-09-27T1400.json
//
// Everything here is deterministic. Qualitative review happens by reading
// eval/results/<run>.json afterwards, which costs nothing and means the
// expensive half of a normal eval harness does not exist. That is the point:
// this file's scores are the primary signal precisely because they do not need
// a model to produce them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../src/lib/store.mjs';
import { conceptMap, retrieve, dedupe, score, pack, order, verify, SIM_FLOOR } from '../src/query/pipeline.mjs';
import { loadIndex } from '../src/lib/load-index.mjs';
import { embed, cosine } from '../src/lib/gemini.mjs';
import { spentInr, BUDGET_INR } from '../src/lib/spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, 'results');
fs.mkdirSync(RESULTS, { recursive: true });

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const compareTo = argv.includes('--compare') ? argv[argv.indexOf('--compare') + 1] : null;

const golden = JSON.parse(fs.readFileSync(path.join(HERE, 'golden-set.json'), 'utf8'));
const topics = golden.topics.filter((t) => !only || only.includes(t.id));

// A must-cover phrase counts as met if some segment in the plan matches it.
// Deliberately a lower bar than retrieval's floor: the phrase is written the way
// a learner would say it, not the way the index labels things.
const MUSTCOVER_FLOOR = 0.74;

const db = open();
const index = loadIndex(db);
console.log(`index: ${index.length} segments | golden set: ${topics.length} topics\n`);

const runStart = Date.now();
const startSpend = spentInr();
const results = [];

for (const t of topics) {
  const t0 = Date.now();
  const before = spentInr();
  process.stdout.write(`${t.id.padEnd(18)} ${String(t.budgetMin).padStart(3)}min  `);

  try {
    const concepts = await conceptMap(t.topic, t.budgetMin);
    const candidates = await retrieve(index, concepts);
    score(candidates);
    const clusters = dedupe(candidates, 0.88);
    const packed = pack(clusters, concepts, t.budgetMin);

    if (!packed.chosen.length) throw new Error('packed nothing');

    const segs = packed.chosen.map((s, i) => ({ ...s, pid: i }));
    const ordered = await order(t.topic, t.budgetMin, concepts, segs);
    const byPid = new Map(segs.map((s) => [s.pid, s]));
    const sequence = ordered.plan.map((p) => ({ ...byPid.get(p.id), why: p.why })).filter((s) => s.pid !== undefined);
    const v = await verify(sequence, t.budgetMin);

    // ---- must-cover and avoid, by embedding the learner's own phrasing ----
    const probes = [...t.mustCover, ...(t.avoid || [])];
    const probeVecs = await embed(probes, { label: 'eval: must-cover probes' });
    const planVecs = sequence.map((s) => s.vecLabel);
    const bestFor = (k) => {
      let best = 0, at = -1;
      planVecs.forEach((pv, i) => { const c = cosine(pv, probeVecs[k]); if (c > best) { best = c; at = i; } });
      return { sim: best, at };
    };
    const mustCover = t.mustCover.map((phrase, k) => {
      const b = bestFor(k);
      return { phrase, met: b.sim >= MUSTCOVER_FLOOR, sim: +b.sim.toFixed(3), segment: b.at >= 0 ? sequence[b.at].concept : null };
    });
    const avoided = (t.avoid || []).map((phrase, j) => {
      const b = bestFor(t.mustCover.length + j);
      // Minutes spent on segments that look like the thing to avoid.
      const mins = sequence
        .filter((_, i) => cosine(planVecs[i], probeVecs[t.mustCover.length + j]) >= 0.80)
        .reduce((a, s) => a + s.durationSec, 0) / 60;
      return { phrase, closest: +b.sim.toFixed(3), minutesSpent: +mins.toFixed(1) };
    });

    // ---- redundancy: the metric that would have caught the ONDC failure ----
    let maxPair = 0, maxPairAt = null;
    for (let i = 0; i < sequence.length; i++)
      for (let j = i + 1; j < sequence.length; j++) {
        const c = cosine(sequence[i].vec, sequence[j].vec);
        if (c > maxPair) { maxPair = c; maxPairAt = [sequence[i].concept, sequence[j].concept]; }
      }

    const totalSec = sequence.reduce((a, s) => a + s.durationSec, 0);
    const r = {
      id: t.id, topic: t.topic, budgetMin: t.budgetMin, notes: t.notes || null,
      ok: true,
      segments: sequence.length,
      minutes: +(totalSec / 60).toFixed(1),
      budgetMet: packed.budgetMet,
      creators: new Set(sequence.map((s) => s.channel)).size,
      depth: packed.depthCount,
      depthShortfall: packed.depthShortfall,
      longestSegMin: +(Math.max(...sequence.map((s) => s.durationSec)) / 60).toFixed(1),
      longestShare: +packed.longestShare.toFixed(3),
      concepts: concepts.length,
      covered: packed.covered.length,
      missing: packed.missing.map((m) => m.name),
      conceptsWithNoMatch: concepts.filter((c) => !c.found).map((c) => c.name),
      mustCover,
      mustCoverMet: mustCover.filter((m) => m.met).length,
      avoid: avoided,
      maxPairwiseSim: +maxPair.toFixed(3),
      maxPairwiseAt: maxPairAt,
      integrityOk: ordered.tries.at(-1).check.ok,
      orderAttempts: ordered.tries.length,
      escalated: ordered.escalated,
      orderModel: ordered.model,
      mechanicalFailures: v.mechanicalFailures.length,
      verifyMismatches: v.mismatches.length,
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
      inr: +(spentInr() - before).toFixed(4),
      plan: sequence.map((s) => ({
        concept: s.concept, depth: s.depth, channel: s.channel,
        min: +(s.durationSec / 60).toFixed(1), why: s.why,
        url: `https://youtube.com/watch?v=${s.videoId}&t=${s.startSec}s`,
      })),
    };
    results.push(r);
    console.log(
      `${String(r.segments).padStart(2)} segs ${String(r.minutes).padStart(5)}min ` +
      `cov ${r.covered}/${r.concepts} must ${r.mustCoverMet}/${r.mustCover.length} ` +
      `dup ${r.maxPairwiseSim} ${r.escalated ? 'ESC ' : '    '}` +
      `${r.seconds}s Rs ${r.inr.toFixed(2)}`
    );
  } catch (e) {
    results.push({ id: t.id, topic: t.topic, budgetMin: t.budgetMin, ok: false, error: String(e.message).slice(0, 200) });
    console.log(`FAILED: ${String(e.message).slice(0, 80)}`);
  }
}

// ------------------------------------------------------------------ scorecard

const good = results.filter((r) => r.ok);
const sum = (f) => good.reduce((a, r) => a + f(r), 0);
const avg = (f) => (good.length ? sum(f) / good.length : 0);

const scorecard = {
  at: new Date().toISOString(),
  indexSegments: index.length,
  simFloor: SIM_FLOOR,
  topics: results.length,
  succeeded: good.length,
  budgetMetPct: Math.round((100 * good.filter((r) => r.budgetMet).length) / (good.length || 1)),
  conceptCoveragePct: Math.round((100 * sum((r) => r.covered)) / (sum((r) => r.concepts) || 1)),
  mustCoverPct: Math.round((100 * sum((r) => r.mustCoverMet)) / (sum((r) => r.mustCover.length) || 1)),
  integrityPct: Math.round((100 * good.filter((r) => r.integrityOk).length) / (good.length || 1)),
  escalatedPct: Math.round((100 * good.filter((r) => r.escalated).length) / (good.length || 1)),
  meanMaxPairwise: +avg((r) => r.maxPairwiseSim).toFixed(3),
  meanCreators: +avg((r) => r.creators).toFixed(1),
  meanLongestShare: +avg((r) => r.longestShare).toFixed(3),
  meanSeconds: +avg((r) => r.seconds).toFixed(1),
  totalInr: +(spentInr() - startSpend).toFixed(2),
  meanInr: +avg((r) => r.inr).toFixed(3),
  mechanicalFailures: sum((r) => r.mechanicalFailures),
  verifyMismatches: sum((r) => r.verifyMismatches),
  driftMinutes: +good.reduce((a, r) => a + r.avoid.reduce((b, x) => b + x.minutesSpent, 0), 0).toFixed(1),
};

const stamp = scorecard.at.replace(/[:.]/g, '').slice(0, 15);
const outPath = path.join(RESULTS, `${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify({ scorecard, results }, null, 2));

console.log(`\n${'='.repeat(62)}\nSCORECARD  (${((Date.now() - runStart) / 1000).toFixed(0)}s)\n${'='.repeat(62)}`);
for (const [k, v] of Object.entries(scorecard)) {
  if (k === 'at') continue;
  console.log(`  ${k.padEnd(22)} ${v}`);
}

if (compareTo && fs.existsSync(compareTo)) {
  const prev = JSON.parse(fs.readFileSync(compareTo, 'utf8')).scorecard;
  console.log(`\nversus ${path.basename(compareTo)}:`);
  for (const k of Object.keys(scorecard)) {
    if (k === 'at' || typeof scorecard[k] !== 'number') continue;
    const d = scorecard[k] - (prev[k] ?? 0);
    if (Math.abs(d) > 0.0001) console.log(`  ${k.padEnd(22)} ${prev[k]} -> ${scorecard[k]}  (${d > 0 ? '+' : ''}${+d.toFixed(3)})`);
  }
}

console.log(`\nwrote ${outPath}`);
console.log(`project total Rs ${spentInr().toFixed(2)} of Rs ${BUDGET_INR}`);
