// Step 2 of indexing: turn candidate videos into embedded segments.
//
// This is where the money goes, so it is resumable and incremental. Every video
// is committed as it finishes, and a video already marked `extracted` is never
// paid for twice. Run it with --limit to index a batch, look at the shape, then
// run it again for more.
//
//   node src/indexer/run.mjs --limit 50
//   node src/indexer/run.mjs --limit 550
//   node src/indexer/run.mjs            (everything still pending)

import { transcript, latinRatio } from '../lib/youtube.mjs';
import { extractSegments, mergeAdjacent } from '../lib/extract.mjs';
import { embed } from '../lib/gemini.mjs';
import { open, pendingVideos, addCandidate, setVideoStatus, markExtracted, insertSegments, clearSegments, stats } from '../lib/store.mjs';
import { assertBudget, spentInr, BUDGET_INR, BudgetExceeded } from '../lib/spend.mjs';

const DOMAIN = 'ai';
const CONCURRENCY = 8;
const COST_PER_VIDEO_INR = 0.21;   // measured, slightly rounded up
const MIN_LATIN = 0.8;

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : 100000;

const db = open();
const pending = pendingVideos(db, DOMAIN, LIMIT);

if (!pending.length) {
  console.log('nothing pending. run `npm run index:candidates` first, or everything is already indexed.');
  process.exit(0);
}

const estimate = pending.length * COST_PER_VIDEO_INR;
console.log(`${pending.length} videos pending. Estimated Rs ${estimate.toFixed(2)}.`);
console.log(`Budget: Rs ${spentInr().toFixed(2)} of Rs ${BUDGET_INR} spent, Rs ${(BUDGET_INR - spentInr()).toFixed(2)} left.\n`);

try {
  assertBudget(`index ${pending.length} videos`, estimate);
} catch (e) {
  if (e instanceof BudgetExceeded) {
    const affordable = Math.floor((BUDGET_INR - spentInr()) / COST_PER_VIDEO_INR);
    console.error(e.message);
    console.error(`\nAt Rs ${COST_PER_VIDEO_INR} a video you can afford about ${affordable} more. Re-run with --limit ${Math.max(0, affordable - 10)}.`);
    process.exit(1);
  }
  throw e;
}

const started = Date.now();
const startSpend = spentInr();
let done = 0, indexed = 0, skipped = 0, failed = 0, segCount = 0, mergedCount = 0;

async function handle(v) {
  try {
    // 1. transcript, free
    let t;
    try {
      t = await transcript(v.id);
    } catch {
      setVideoStatus(db, v.id, 'rejected', 'no transcript');
      skipped++; return;
    }
    const sample = t.blocks.slice(0, 12).map((b) => b.text).join(' ');
    if (latinRatio(sample) < MIN_LATIN) {
      setVideoStatus(db, v.id, 'rejected', 'not English');
      skipped++; return;
    }

    const words = t.lines.reduce((a, l) => a + l.text.split(/\s+/).length, 0);
    const wordsPerMin = Math.round(words / (v.duration_sec / 60));
    if (wordsPerMin < 60) {
      setVideoStatus(db, v.id, 'rejected', `only ${wordsPerMin} words/min`);
      skipped++; return;
    }

    const video = {
      id: v.id, title: v.title, channel: v.channel,
      durationSec: v.duration_sec, views: v.views, published: v.published_at,
      blocks: t.blocks, lines: t.lines, wordsPerMin,
    };

    // 2. extract, paid
    const raw = await extractSegments(video);
    if (!raw.length) {
      setVideoStatus(db, v.id, 'rejected', 'no teachable segments');
      skipped++; return;
    }

    // 3. merge contiguous runs, free
    const merged = mergeAdjacent(raw);
    mergedCount += raw.length - merged.length;

    // 4. two embeddings per segment: the transcript for deduplication, the
    //    label for retrieval. See the schema comment in store.mjs for why.
    const [vecs, labelVecs] = await Promise.all([
      embed(merged.map((s) => s.transcript), { label: 'index: embed segments' }),
      embed(merged.map((s) => `${s.concept}. ${s.teaches}`), { label: 'index: embed segment labels' }),
    ]);
    merged.forEach((s, i) => { s.vec = vecs[i]; s.vecLabel = labelVecs[i]; });

    // Clear first so a re-run of a partially written video cannot duplicate.
    clearSegments(db, v.id);
    insertSegments(db, v.id, merged);
    markExtracted(db, v.id, { transcriptLines: t.lines.length, wordsPerMin });
    indexed++; segCount += merged.length;
  } catch (e) {
    if (e instanceof BudgetExceeded) throw e;
    setVideoStatus(db, v.id, 'failed', String(e.message).slice(0, 180));
    failed++;
  } finally {
    done++;
    if (done % 10 === 0 || done === pending.length) {
      const rate = (Date.now() - started) / done;
      const left = Math.round((rate * (pending.length - done)) / 1000);
      process.stdout.write(
        `\r  ${done}/${pending.length} | ${indexed} indexed, ${skipped} skipped, ${failed} failed ` +
        `| ${segCount} segments | Rs ${(spentInr() - startSpend).toFixed(2)} | ~${left}s left   `
      );
    }
  }
}

// Bounded concurrency. A budget stop aborts the whole run rather than letting
// the remaining workers keep spending.
let cursor = 0, aborted = null;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < pending.length && !aborted) {
    const v = pending[cursor++];
    try { await handle(v); }
    catch (e) { if (e instanceof BudgetExceeded) aborted = e; else throw e; }
  }
}));

console.log('\n');
if (aborted) console.log(`STOPPED ON BUDGET: ${aborted.message}\n`);

const s = stats(db);
console.log(`indexed this run: ${indexed} videos, ${segCount} segments (${mergedCount} contiguous pieces merged away)`);
console.log(`skipped: ${skipped}  failed: ${failed}`);
console.log(`\nindex now holds:`);
console.log(`  videos      ${s.videos.map((r) => `${r.n} ${r.status}`).join(', ')}`);
console.log(`  segments    ${s.segments} (${s.embedded} embedded) across ${s.channels} channels`);
console.log(`  depth mix   ${s.depth.map((d) => `${d.depth} ${Math.round((100 * d.n) / s.segments)}%`).join(', ')}`);
console.log(`  median seg  ${Math.round(s.medianSegSec)}s`);
console.log(`  total       ${s.hoursIndexed.toFixed(1)} hours of indexed content`);
console.log(`\nspent this run: Rs ${(spentInr() - startSpend).toFixed(2)}   |   project total: Rs ${spentInr().toFixed(2)} of Rs ${BUDGET_INR}`);
