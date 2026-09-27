// One compile, shared by the local server and the deployed function, so the
// thing that gets tested locally is the thing that runs in production.

import { conceptMap, retrieve, dedupe, score, pack, order, verify } from './pipeline.mjs';

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export async function compilePlan(index, topic, budgetMin, onStage = () => {}) {
  onStage(1, 'Working out what you need to understand');
  const concepts = await conceptMap(topic, budgetMin);

  onStage(2, `Searching ${index.length.toLocaleString()} indexed segments`);
  const candidates = await retrieve(index, concepts);
  score(candidates);

  onStage(3, `Removing repeats from ${candidates.length} candidates`);
  const clusters = dedupe(candidates, 0.88);

  onStage(4, `Packing ${budgetMin} minutes`);
  const packed = pack(clusters, concepts, budgetMin);
  if (!packed.chosen.length) {
    throw new Error('Nothing in the index matched that closely enough. Try a different topic, or one closer to AI and language models, which is the only area indexed so far.');
  }

  onStage(5, 'Putting it in teaching order');
  const segs = packed.chosen.map((s, i) => ({ ...s, pid: i }));
  const ordered = await order(topic, budgetMin, concepts, segs);
  const byPid = new Map(segs.map((s) => [s.pid, s]));
  const sequence = ordered.plan.map((p) => ({ ...byPid.get(p.id), why: p.why })).filter((s) => s.pid !== undefined);

  const v = await verify(sequence, budgetMin);

  return {
    topic,
    budgetMin,
    totalMin: Math.round(v.totalSec / 60),
    creators: new Set(sequence.map((s) => s.channel)).size,
    concepts: concepts.map((c) => ({ name: c.name, covered: packed.covered.includes(c.idx) })),
    missing: packed.missing.map((m) => m.name),
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
