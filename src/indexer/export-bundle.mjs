// Export the index as a static bundle the deployed app can ship with.
//
// The index does not need a database. It is written once by an offline job and
// only ever read after that, which makes it a file. Shipping it inside the
// deployment removes Supabase, removes credentials, removes a network hop from
// every query, and removes a monthly bill.
//
// Two decisions keep it small:
//
//   float16 vectors. Halves 11.2MB to 5.6MB. The error is checked below rather
//   than assumed, because the retrieval floor (0.78) and the dedupe threshold
//   (0.88) were tuned on float32 and a shifted similarity would mean the
//   deployed product behaves differently from the one that was evaluated.
//
//   Truncated transcripts. The only query-time reader of transcript text is the
//   verification step, which slices the first 1200 characters. Shipping 1300 is
//   lossless for that purpose and drops 10.3MB to 2.4MB. The true length is
//   stored separately so the "is there really content here" check stays honest.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { open, allSegments } from '../lib/store.mjs';
import { cosine } from '../lib/gemini.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'data/index-bundle');
fs.mkdirSync(OUT, { recursive: true });

const DIMS = 768;
const KEEP_TEXT = 1300;

const segs = allSegments(open()).filter((s) => s.vec?.length === DIMS && s.vecLabel?.length === DIMS);
console.log(`${segs.length} segments`);

// ---- vectors, float16, two contiguous blocks --------------------------------

const label = new Float16Array(segs.length * DIMS);
const trans = new Float16Array(segs.length * DIMS);
segs.forEach((s, i) => {
  label.set(s.vecLabel, i * DIMS);
  trans.set(s.vec, i * DIMS);
});

// ---- does float16 move the numbers the thresholds depend on? ----------------

let worst = 0, sum = 0, pairs = 0;
const sample = segs.slice(0, 220);
for (let i = 0; i < sample.length; i++) {
  for (let j = i + 1; j < sample.length; j += 7) {
    const exact = cosine(sample[i].vecLabel, sample[j].vecLabel);
    const quant = cosine(
      Array.from(label.subarray(i * DIMS, (i + 1) * DIMS)),
      Array.from(label.subarray(j * DIMS, (j + 1) * DIMS)),
    );
    const d = Math.abs(exact - quant);
    if (d > worst) worst = d;
    sum += d; pairs++;
  }
}
console.log(`float16 cosine error over ${pairs} pairs: mean ${(sum / pairs).toExponential(2)}, worst ${worst.toExponential(2)}`);
if (worst > 0.002) {
  console.error(`\nSTOP: worst-case error ${worst.toFixed(5)} is large enough to move a segment across the 0.78 retrieval floor.`);
  console.error(`Ship float32 instead, or re-tune the thresholds against the quantised vectors.`);
  process.exit(1);
}

// ---- metadata ---------------------------------------------------------------

const meta = segs.map((s) => ({
  v: s.videoId,
  t: s.title,
  ch: s.channel,
  c: s.concept,
  te: s.teaches,
  d: s.depth,
  s: s.startSec,
  e: s.endSec,
  w: s.views,
  p: s.published,
  wpm: s.wordsPerMin,
  vd: s.duration_sec,
  // Truncated for the verifier; `tl` keeps the true length so the emptiness
  // check does not start failing on segments that were fine.
  x: (s.transcript || '').slice(0, KEEP_TEXT),
  tl: (s.transcript || '').length,
}));

const metaBuf = zlib.gzipSync(Buffer.from(JSON.stringify({ dims: DIMS, count: segs.length, segments: meta }), 'utf8'), { level: 9 });

fs.writeFileSync(path.join(OUT, 'meta.json.gz'), metaBuf);
fs.writeFileSync(path.join(OUT, 'label.f16'), Buffer.from(label.buffer));
fs.writeFileSync(path.join(OUT, 'transcript.f16'), Buffer.from(trans.buffer));

const size = (f) => fs.statSync(path.join(OUT, f)).size;
const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
const total = size('meta.json.gz') + size('label.f16') + size('transcript.f16');

console.log(`\nwrote data/index-bundle/`);
console.log(`  meta.json.gz     ${mb(size('meta.json.gz'))}`);
console.log(`  label.f16        ${mb(size('label.f16'))}`);
console.log(`  transcript.f16   ${mb(size('transcript.f16'))}`);
console.log(`  total            ${mb(total)}`);

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  builtAt: new Date().toISOString(),
  count: segs.length,
  dims: DIMS,
  channels: new Set(segs.map((s) => s.channel)).size,
  hours: +(segs.reduce((a, s) => a + (s.endSec - s.startSec), 0) / 3600).toFixed(0),
  precision: 'float16',
  transcriptChars: KEEP_TEXT,
  quantisationWorstCosineError: +worst.toFixed(6),
}, null, 2));
