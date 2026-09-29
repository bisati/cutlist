// One compile, shared by the local server and the deployed function, so the
// thing that gets tested locally is the thing that runs in production.

import { conceptMap, retrieve, dedupe, score, pack, order, verify } from './pipeline.mjs';

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

// The seven stages that run on the server, in the order they actually execute.
// Stage 8, rendering, happens in the browser and so is not reported here.
//
// `kind` says who does the work, and the page shows it: the claim that only
// three of eight stages call a model is checkable against this list rather
// than taken on trust. The page keeps its own copy of the labels for the idle
// state, because there is no build step to share a constant across both.
export const STAGES = [
  { n: 1, kind: 'model', label: 'Understand the request' },
  { n: 2, kind: 'code', label: 'Retrieve candidates' },
  { n: 3, kind: 'code', label: 'Score' },
  { n: 4, kind: 'code', label: 'Remove duplicates' },
  { n: 5, kind: 'code', label: 'Pack the time budget' },
  { n: 6, kind: 'model', label: 'Order pedagogically' },
  { n: 7, kind: 'both', label: 'Verify' },
];
export const STAGE_COUNT = STAGES.length;

const kindOf = (n) => STAGES[n - 1].kind;

export async function compilePlan(index, topic, budgetMin, onStage = () => {}) {
  const at = (n, text) => onStage(n, text, kindOf(n));

  at(1, 'Working out what you need to understand');
  const concepts = await conceptMap(topic, budgetMin);

  at(2, `Searching ${index.length.toLocaleString()} indexed segments`);
  const candidates = await retrieve(index, concepts);

  at(3, `Scoring ${candidates.length} candidates`);
  score(candidates);

  at(4, 'Removing segments that teach the same thing');
  const clusters = dedupe(candidates, 0.88);

  at(5, `Packing ${budgetMin} minutes from ${clusters.length} distinct segments`);
  const packed = pack(clusters, concepts, budgetMin);
  if (!packed.chosen.length) {
    throw new Error('Nothing in the index matched that closely enough. Try a different topic, or one closer to AI and language models, which is the only area indexed so far.');
  }

  at(6, 'Putting it in teaching order');
  const segs = packed.chosen.map((s, i) => ({ ...s, pid: i }));
  const ordered = await order(topic, budgetMin, concepts, segs);
  const byPid = new Map(segs.map((s) => [s.pid, s]));
  const sequence = ordered.plan.map((p) => ({ ...byPid.get(p.id), why: p.why })).filter((s) => s.pid !== undefined);

  at(7, 'Checking each segment delivers what it claims');
  const v = await verify(sequence, budgetMin);

  return {
    topic,
    budgetMin,
    totalMin: Math.round(v.totalSec / 60),
    creators: new Set(sequence.map((s) => s.channel)).size,
    concepts: concepts.map((c) => ({ name: c.name, covered: packed.covered.includes(c.idx) })),
    missing: packed.missing.map((m) => m.name),

    // What the pipeline narrowed down, and what the verifier found. The page
    // shows these because a plan that cannot say where it came from is a plan
    // you have to take on faith.
    stats: {
      indexed: index.length,
      candidates: candidates.length,
      distinct: clusters.length,
      model: ordered.model,
      escalated: ordered.escalated,
      attempts: ordered.tries.length,
      flagged: v.mismatches.length,
      mechanical: v.mechanicalFailures.length,
    },

    plan: sequence.map((s, i) => {
      const sem = v.semantic.get(i);
      return {
        concept: s.concept,
        teaches: s.teaches,
        why: s.why,
        depth: s.depth,
        channel: s.channel,
        title: s.title,
        minutes: Math.max(1, Math.round(s.durationSec / 60)),
        seconds: s.durationSec,
        from: mmss(s.startSec),
        to: mmss(s.endSec),
        url: `https://youtube.com/watch?v=${s.videoId}&t=${s.startSec}s`,
        flagged: sem ? !sem.delivers : false,
        flagNote: sem && !sem.delivers ? sem.note : null,
      };
    }),
  };
}
