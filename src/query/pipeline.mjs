// The online pipeline: topic plus time budget in, ordered plan out.
//
// Eight stages, of which three call a model. The other five are code, and that
// split is the architecture rather than an optimisation: deduplication is a
// similarity problem and packing is a constraint problem, and neither of them
// gets better by being handed to a model.
//
//   1  understand the ask      model   -> concept map
//   2  retrieve                code    -> candidate segments
//   3  dedupe                  code    -> distinct segments
//   4  score                   code
//   5  pack to budget          code    -> the chosen set
//   6  order pedagogically     model   -> the plan
//   7  verify                  code + model
//   8  render                  code

import { gen, embed, cosine } from '../lib/gemini.mjs';
import { allSegments } from '../lib/store.mjs';

const CHEAP = 'gemini-3.1-flash-lite';
const ORDER_MODEL = 'gemini-3.5-flash-lite';
const ORDER_FALLBACK = 'gemini-3.8-flash';

// ------------------------------------------------------ 1. understand the ask

const CONCEPT_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, why: { type: 'string' } },
        required: ['name', 'why'],
      },
    },
  },
  required: ['concepts'],
};

export async function conceptMap(topic) {
  const { data } = await gen(CHEAP, `A learner says: "${topic}".

List the 8 to 15 things someone must understand to genuinely get this, not a summary and not trivia. Order them by dependency: nothing may appear before the thing it depends on.

For each give a short name and one sentence on why it is load bearing.`,
    { label: 'query: understand the ask', schema: CONCEPT_SCHEMA });
  return data.concepts.map((c, i) => ({ ...c, idx: i }));
}

// -------------------------------------------------------------- 2. retrieve

/** Load the index once. Small enough to hold in memory and brute force. */
export function loadIndex(db) {
  return allSegments(db).filter((s) => s.vec && s.vecLabel);
}

// A match below this is not a match, it is the bottom of the barrel. Gemini
// embeddings sit on a high floor (two unrelated sentences score about 0.67), so
// this threshold is much higher than it would be for a normalised space.
// Measured against the 475 segment index: a genuinely on-topic segment scores
// 0.81 to 0.87 on the label vector, and by rank 20 the matches are unrelated.
export const SIM_FLOOR = 0.78;

/**
 * Top matches per concept, on the LABEL vector, above the floor.
 *
 * The floor is the important part. Without it, a thin index silently fills a
 * RAG plan with reinforcement learning because that was the 38th best match for
 * "Reranking" and nothing better existed. With it, the concept simply comes
 * back uncovered and the coverage panel says so, which is the honest answer.
 */
export async function retrieve(segments, concepts, { perConcept = 12, floor = SIM_FLOOR } = {}) {
  const vecs = await embed(concepts.map((c) => `${c.name}. ${c.why}`), { label: 'query: embed concepts' });
  concepts.forEach((c, i) => { c.vec = vecs[i]; });

  const picked = new Set();
  for (const c of concepts) {
    const ranked = segments
      .map((s) => ({ s, sim: cosine(s.vecLabel, c.vec) }))
      .filter((x) => x.sim >= floor)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, perConcept);
    c.found = ranked.length;
    for (const { s, sim } of ranked) {
      if (!s.best || sim > s.best.sim) s.best = { concept: c, sim };
      picked.add(s);
    }
  }
  return [...picked];
}

// ---------------------------------------------------------------- 3. dedupe

/**
 * Complete-linkage agglomerative clustering.
 * Complete rather than single linkage on purpose: single linkage chains, so one
 * borderline pair can merge two genuinely different explanations and silently
 * delete one of them.
 */
export function dedupe(segments, threshold = 0.88) {
  segments.forEach((s, i) => { s._i = i; });
  let clusters = segments.map((s) => [s]);
  const cache = new Map();
  const pairSim = (a, b) => {
    const k = a._i < b._i ? `${a._i}|${b._i}` : `${b._i}|${a._i}`;
    if (!cache.has(k)) cache.set(k, cosine(a.vec, b.vec));
    return cache.get(k);
  };
  const overlapsInVideo = (a, b) =>
    a.videoId === b.videoId && a.startSec < b.endSec && b.startSec < a.endSec;

  const linkage = (A, B) => {
    let worst = 1;
    for (const a of A) for (const b of B) {
      if (overlapsInVideo(a, b)) return 1;
      const s = pairSim(a, b);
      if (s < worst) worst = s;
      if (worst < threshold) return worst;
    }
    return worst;
  };

  for (;;) {
    let bi = -1, bj = -1, best = threshold;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const l = linkage(clusters[i], clusters[j]);
        if (l >= best) { best = l; bi = i; bj = j; }
      }
    }
    if (bi < 0) break;
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    clusters.splice(bj, 1);
  }
  return clusters;
}

// ----------------------------------------------------------------- 4. score

function ageYears(published) {
  const m = String(published || '').match(/(\d+)\s*(year|month|week|day|hour)/i);
  if (!m) return 2;
  const n = +m[1];
  return { year: n, month: n / 12, week: n / 52, day: n / 365, hour: 0 }[m[2].toLowerCase()] ?? 2;
}

/**
 * No depth term, deliberately. Depth belongs to the plan's composition, not to
 * a segment's worth, and putting it here is what stripped every intro and
 * example out of the first packed plan.
 */
export function score(segments) {
  const maxViews = Math.max(...segments.map((s) => s.views || 0), 1);
  for (const s of segments) {
    const conceptSim = s.best?.sim ?? 0;
    const channel = Math.log10(1 + (s.views || 0)) / Math.log10(1 + maxViews);
    const density = Math.min(1, (s.wordsPerMin || 0) / 150);
    const recency = Math.exp(-ageYears(s.published) / 3);
    s.quality = 0.45 * conceptSim + 0.20 * channel + 0.15 * density + 0.20 * recency;
    s.signals = { conceptSim, channel, density, recency };
  }
  return segments;
}

// ------------------------------------------------------------------ 5. pack

const SHAPE = {
  intro:     { min: 1, maxFrac: 0.15 },
  mechanism: { min: 0, maxFrac: 0.60 },
  example:   { min: 3, maxFrac: 0.30 },
  debate:    { min: 2, maxFrac: 0.20 },
};

export function pack(clusters, concepts, budgetMin, { maxSegments = 28, slackMin = 12, shape = SHAPE } = {}) {
  const reps = clusters.map((c) => c.slice().sort((a, b) => b.quality - a.quality)[0]);
  const budget = budgetMin * 60;
  const floor = (budgetMin - slackMin) * 60;
  const cap = Object.fromEntries(
    Object.entries(shape).map(([d, v]) => [d, Math.max(v.min, Math.round(v.maxFrac * maxSegments))])
  );

  const chosen = new Set();
  const covered = new Set();
  const creators = new Map();
  const depthCount = { intro: 0, mechanism: 0, example: 0, debate: 0 };
  let used = 0;

  const admissible = (s) =>
    !chosen.has(s) && used + s.durationSec <= budget &&
    chosen.size < maxSegments && depthCount[s.depth] < (cap[s.depth] ?? maxSegments);
  const diversity = (s) => 1 / (1 + (creators.get(s.channel) || 0));
  const take = (s) => {
    chosen.add(s);
    if (s.best?.concept) covered.add(s.best.concept.idx);
    creators.set(s.channel, (creators.get(s.channel) || 0) + 1);
    depthCount[s.depth] = (depthCount[s.depth] || 0) + 1;
    used += s.durationSec;
  };
  const bestOf = (pool, bonus = () => 0) =>
    pool.filter(admissible).sort((a, b) =>
      (b.quality * diversity(b) + bonus(b)) - (a.quality * diversity(a) + bonus(a)))[0];

  // A: reserve the depth minimums, preferring ones that also cover a new concept
  const shortfall = {};
  for (const [depth, { min }] of Object.entries(shape)) {
    let got = 0;
    for (let i = depthCount[depth]; i < min; i++) {
      const pick = bestOf(reps.filter((s) => s.depth === depth),
        (s) => (s.best?.concept && !covered.has(s.best.concept.idx) ? 0.15 : 0));
      if (!pick) break;
      take(pick); got++;
    }
    if (got < min) shortfall[depth] = min - got;
  }

  // B: greedy set-cover over concepts still uncovered
  for (;;) {
    const pick = bestOf(reps.filter((s) => s.best?.concept && !covered.has(s.best.concept.idx)));
    if (!pick) break;
    take(pick);
  }

  // C: spend the rest of the budget on the best that still fits
  for (;;) {
    const pick = bestOf(reps);
    if (!pick) break;
    if (used >= floor && pick.quality < 0.45) break;
    take(pick);
  }

  return {
    chosen: [...chosen],
    usedSec: used,
    covered: [...covered],
    missing: concepts.filter((c) => !covered.has(c.idx)),
    depthCount,
    depthShortfall: shortfall,
    budgetMet: used >= floor && used <= budget,
  };
}

// ------------------------------------------------------------------ 6. order

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    plan: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, why: { type: 'string' } },
        required: ['id', 'why'],
      },
    },
  },
  required: ['plan'],
};

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function orderPrompt(topic, budgetMin, concepts, segments) {
  return `Sequence a learning plan.

A learner said: "${topic}". They have ${budgetMin} minutes. The segments below have already been selected and time-checked. Your only job is to put them in the order someone should watch them, and to say why each one earns its place.

These are the things they need to understand, in dependency order:
${concepts.map((c, i) => `${i + 1}. ${c.name}: ${c.why}`).join('\n')}

Order the plan so that:
- nothing depends on something that has not been explained yet
- it moves from orientation, to how the thing actually works, to worked cases, to the live disagreements, and ends somewhere that ties it together
- consecutive segments from the same creator are avoided unless the content genuinely runs on
- the arc reads as one lesson rather than a playlist

Return every segment exactly once. Do not add, drop, merge or re-time anything: the selection is settled and the total already fits the budget.

"why" is one sentence, written to the learner, saying what this segment gives them at this point in the plan. Do not restate the title. Do not use the same sentence shape every time.

SEGMENTS:
${segments.map((s) => `id ${s.pid} | ${Math.round(s.durationSec / 60)}min | ${s.depth} | ${s.channel} | ${mmss(s.startSec)}-${mmss(s.endSec)}
   ${s.concept}: ${s.teaches}`).join('\n')}`;
}

/** Did the model return exactly the set it was given? Code, not a model. */
export function integrity(plan, segments) {
  const valid = new Set(segments.map((s) => s.pid));
  const seen = new Set();
  const invented = [], duplicated = [];
  for (const p of plan) {
    if (!valid.has(p.id)) invented.push(p.id);
    else if (seen.has(p.id)) duplicated.push(p.id);
    else seen.add(p.id);
  }
  const dropped = [...valid].filter((i) => !seen.has(i));
  return { ok: !invented.length && !duplicated.length && !dropped.length, invented, duplicated, dropped };
}

/**
 * Order the plan, with the reliability coming from the code check rather than
 * from paying for a bigger model. Measured head to head: 3.5-flash-lite
 * returns the full set about 3 times in 4, and 3.1-flash-lite silently dropped
 * 16 of 26 segments once, which is why it is not in the ladder.
 */
export async function order(topic, budgetMin, concepts, segments, { attempts = 2 } = {}) {
  const prompt = orderPrompt(topic, budgetMin, concepts, segments);
  const tries = [];
  for (let i = 0; i < attempts; i++) {
    const model = ORDER_MODEL;
    const { data, ms } = await gen(model, prompt, { label: 'query: order the plan', schema: PLAN_SCHEMA });
    const check = integrity(data.plan, segments);
    tries.push({ model, ms, check });
    if (check.ok) return { plan: data.plan, model, ms, tries, escalated: false };
  }
  const { data, ms } = await gen(ORDER_FALLBACK, prompt, { label: 'query: order the plan (escalated)', schema: PLAN_SCHEMA });
  const check = integrity(data.plan, segments);
  tries.push({ model: ORDER_FALLBACK, ms, check });
  return { plan: data.plan, model: ORDER_FALLBACK, ms, tries, escalated: true, integrity: check };
}

// ----------------------------------------------------------------- 7. verify

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          delivers: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['i', 'delivers', 'note'],
      },
    },
  },
  required: ['results'],
};

/** Recomputed from the finished plan, never trusting the stage that made it. */
export async function verify(sequence, budgetMin) {
  const mechanical = sequence.map((s, i) => {
    const issues = [];
    if (s.endSec > s.duration_sec) issues.push(`ends past the video (${s.endSec}s of ${s.duration_sec}s)`);
    if (s.startSec >= s.endSec) issues.push('start is not before end');
    if ((s.transcript || '').length < 250) issues.push('almost no transcript in range');
    return { i, issues };
  });

  const total = sequence.reduce((a, s) => a + s.durationSec, 0);
  const { data } = await gen(CHEAP, `For each item, does the TRANSCRIPT actually deliver the CLAIMED CONCEPT?

Be strict. If the transcript is about something else, or is an advert, an intro to the channel, or filler, then it does not deliver.

Return one result per item.

${sequence.map((s, i) => `## ${i}\nCLAIMED: ${s.concept}\nTRANSCRIPT: ${(s.transcript || '').slice(0, 1200)}`).join('\n\n')}`,
    { label: 'query: verify segments', schema: VERIFY_SCHEMA });

  const semantic = new Map(data.results.map((r) => [r.i, r]));
  return {
    totalSec: total,
    withinBudget: total <= budgetMin * 60,
    mechanicalFailures: mechanical.filter((m) => m.issues.length),
    mismatches: [...semantic.values()].filter((r) => !r.delivers),
    semantic,
  };
}
