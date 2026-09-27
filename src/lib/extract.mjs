// Segment extraction: one cheap model call per video.
//
// Two prompts live here on purpose. V1 is what the first pass ran, kept so the
// improvement is demonstrable rather than asserted. V2 is what ships.
//
// What was wrong with V1, measured over 157 videos:
//   - 70% of everything it returned was labelled `mechanism`, and intros and
//     debates were scarce. The prompt's own definition of a segment used the
//     word "mechanism", which taught the model which label to reach for.
//   - 34% of segments sat within 30s of a neighbour from the same video: it
//     was cutting one continuous explanation into pieces, which shortened
//     every segment and made the finished plan jump around more than needed.

import { gen } from './gemini.mjs';
import { textInRange } from './youtube.mjs';

export const EXTRACT_MODEL = 'gemini-3.1-flash-lite';

const SEG_SCHEMA = {
  type: 'object',
  properties: {
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'integer' },
          endSec: { type: 'integer' },
          concept: { type: 'string' },
          teaches: { type: 'string' },
          depth: { type: 'string', enum: ['intro', 'mechanism', 'example', 'debate'] },
        },
        required: ['startSec', 'endSec', 'concept', 'teaches', 'depth'],
      },
    },
  },
  required: ['segments'],
};

const V1_MIN = 90, V1_MAX = 480;
export const MIN_SEG = 120, MAX_SEG = 900;

const v1Prompt = (v) => `Extract the teachable segments from this video transcript.

A segment is a stretch where the speaker actually explains a concept or a mechanism. Skip intros, sponsor reads, subscribe prompts, recaps of things already said, and tangents. If the video teaches nothing worth a learner's time, return an empty list.

Each segment must be between ${V1_MIN} and ${V1_MAX} seconds. Return at most 6. Timestamps must be where the content actually is: every line below is prefixed with its start time in seconds, so read them.

depth is one of:
  intro      orients someone who has never met the idea
  mechanism  explains how the thing actually works
  example    a worked case, demo, or walkthrough
  debate     a disagreement, limitation, or open question

VIDEO: ${v.title}
CHANNEL: ${v.channel}
LENGTH: ${v.durationSec}s

${v.blocks.map((b) => `[${b.t}s] ${b.text}`).join('\n')}`;

const v2Prompt = (v) => `You are cutting a video into the pieces worth a learner's time.

Read the transcript below. Every line is prefixed with its start time in seconds, so you can see exactly where things happen. Return the stretches that teach something, with real timestamps.

WHAT COUNTS AS A SEGMENT
A continuous stretch that stands on its own and leaves the learner understanding one thing they did not understand before. Someone should be able to start it cold and follow it.

KEEP IT WHOLE. If the speaker explains something across four minutes, that is ONE segment of four minutes, not three short ones. Only cut where the subject genuinely changes. A segment that stops mid-explanation is worse than no segment.

Length: ${MIN_SEG} to ${MAX_SEG} seconds. Prefer the longer, complete version over the tight excerpt. Return at most 6 segments, fewer if the video only has a few good stretches, and none at all if it is filler.

Skip: channel intros, sponsor reads, subscribe prompts, self-promotion, recaps of what was already said, and tangents that go nowhere.

THE FOUR KINDS, ALL OF THEM VALUABLE
A plan built only from one kind is a bad plan, so label honestly and do not default to "mechanism".

  intro      Orients someone meeting the idea for the first time. What it is,
             why it exists, what problem it solves. If this video opens with a
             genuinely good orientation, that is a real segment, not throat
             clearing, and it is often the most useful thing in the video.
  mechanism  How the thing actually works underneath. The moving parts.
  example    A worked case, a demo, a walkthrough, code being written, a
             concrete scenario traced through end to end.
  debate     A limitation, a criticism, a tradeoff, a disagreement between
             practitioners, an open question, a "this does not work when".

Pick the label that fits what the speaker is really doing in that stretch. A segment that introduces an idea before explaining it is an intro. A segment that says "here is where this breaks down" is a debate, even if it also explains a mechanism on the way.

FIELDS
  concept   Three to six words naming the specific thing taught. "How chunking
            affects retrieval quality", not "RAG".
  teaches   One sentence naming what the learner walks away with. State the
            thing itself, not the fact that they will learn it: write "Chunk
            size trades recall against precision, and why 512 tokens is the
            common default", not "You will learn about chunk size". Vary how
            you start these. If several in a row begin the same way, rewrite
            them.

VIDEO: ${v.title}
CHANNEL: ${v.channel}
LENGTH: ${v.durationSec}s

${v.blocks.map((b) => `[${b.t}s] ${b.text}`).join('\n')}`;

const PROMPTS = { v1: { build: v1Prompt, min: V1_MIN, max: V1_MAX }, v2: { build: v2Prompt, min: MIN_SEG, max: MAX_SEG } };

const MERGE_GAP = 30;    // seconds of pause or aside that still reads as one run
const MERGE_MAX = 1200;  // a genuinely continuous 20 min explanation is allowed

/**
 * Join segments the extractor cut out of one continuous explanation.
 * Even with V2 telling it to keep explanations whole, it still splits: measured
 * at 32 contiguous pairs across 78 segments on the tuning set. Cheaper to merge
 * afterwards in code than to keep arguing with the prompt.
 */
export function mergeAdjacent(segments) {
  if (segments.length < 2) return segments;
  const sorted = segments.slice().sort((a, b) => a.startSec - b.startSec);
  const out = [];
  let run = [sorted[0]];

  const flush = () => {
    if (run.length === 1) { out.push(run[0]); return; }
    const first = run[0], last = run.at(-1);
    const longest = run.slice().sort((a, b) => b.durationSec - a.durationSec)[0];
    out.push({
      ...first,
      startSec: first.startSec,
      endSec: last.endSec,
      durationSec: last.endSec - first.startSec,
      // Label from the longest constituent: it carries the dominant content.
      concept: longest.concept,
      depth: longest.depth,
      teaches: [...new Set(run.map((r) => r.teaches))].join(' ').slice(0, 400),
      transcript: run.map((r) => r.transcript).join(' '),
      mergedFrom: run.length,
    });
  };

  for (let i = 1; i < sorted.length; i++) {
    const prev = run.at(-1), cur = sorted[i];
    const gap = cur.startSec - prev.endSec;
    const wouldBe = cur.endSec - run[0].startSec;
    if (gap >= -1 && gap <= MERGE_GAP && wouldBe <= MERGE_MAX) run.push(cur);
    else { flush(); run = [cur]; }
  }
  flush();
  return out;
}

/**
 * Extract segments from one video. The transcript text for each segment is
 * taken from the real caption lines in that range, never from the model, so a
 * hallucinated timestamp produces an empty segment that gets dropped here
 * rather than a fabricated one that reaches a user.
 */
export async function extractSegments(video, { version = 'v2', label = 'index: extract segments' } = {}) {
  const p = PROMPTS[version];
  const { data } = await gen(EXTRACT_MODEL, p.build(video), { label, schema: SEG_SCHEMA });

  return (data.segments || [])
    .map((s) => ({
      ...s,
      startSec: Math.max(0, s.startSec),
      endSec: Math.min(video.durationSec, s.endSec),
    }))
    .filter((s) => {
      const d = s.endSec - s.startSec;
      return d >= p.min && d <= p.max;
    })
    .map((s) => ({
      ...s,
      videoId: video.id,
      durationSec: s.endSec - s.startSec,
      transcript: textInRange(video.lines, s.startSec, s.endSec),
    }))
    .filter((s) => s.transcript.length > 250);
}
