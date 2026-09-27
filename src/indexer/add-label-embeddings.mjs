// Give every segment a SECOND embedding, computed from its concept and teaches
// line rather than its transcript, and show whether it retrieves better.
//
// Why two. The spec says embed the transcript, never the label, and that is
// right for DEDUPLICATION: two creators explaining the same thing have similar
// content, and labels are too short to tell duplicates apart. But RETRIEVAL is
// a different job. A four minute transcript covers a lot of ground, so its
// vector is a blurry average of everything said, and matching a sharp concept
// like "Reranking" against it barely discriminates. Measured on the 475 segment
// index: top-1 similarity was only 0.73, and rank 20 was already unrelated.
//
// So: transcript vector for dedupe, label vector for retrieval. One extra
// embedding of about 40 tokens per segment, which is a rounding error.

import { open, toBlob, fromBlob } from '../lib/store.mjs';
import { embed, cosine } from '../lib/gemini.mjs';
import { spentInr } from '../lib/spend.mjs';

const db = open();

const cols = db.prepare(`PRAGMA table_info(segments)`).all().map((c) => c.name);
if (!cols.includes('embedding_label')) {
  db.exec(`ALTER TABLE segments ADD COLUMN embedding_label BLOB`);
  console.log('added segments.embedding_label');
}

const todo = db.prepare(`SELECT id, concept, teaches FROM segments WHERE embedding_label IS NULL`).all();
console.log(`${todo.length} segments need a label embedding`);

if (todo.length) {
  const before = spentInr();
  const texts = todo.map((s) => `${s.concept}. ${s.teaches}`);
  const vecs = await embed(texts, { label: 'index: embed segment labels' });
  const stmt = db.prepare(`UPDATE segments SET embedding_label=? WHERE id=?`);
  todo.forEach((s, i) => stmt.run(toBlob(vecs[i]), s.id));
  console.log(`done, Rs ${(spentInr() - before).toFixed(3)}`);
}

// ------------------------------------------------- head to head on the same probes

const rows = db.prepare(`SELECT id, concept, embedding, embedding_label FROM segments
                         WHERE embedding IS NOT NULL AND embedding_label IS NOT NULL`).all();
const segs = rows.map((r) => ({ id: r.id, concept: r.concept, t: fromBlob(r.embedding), l: fromBlob(r.embedding_label) }));

const PROBES = ['Vector Embeddings', 'Chunking Strategies', 'Reranking', 'Retrieval Pipeline', 'Hallucination Mitigation'];
const pv = await embed(PROBES.map((c) => `${c}. A concept in retrieval augmented generation.`), { label: 'diagnostic: compare embeddings' });

console.log(`\nRetrieval quality, transcript vector vs label vector (${segs.length} segments)\n`);
for (let k = 0; k < PROBES.length; k++) {
  const byT = segs.map((s) => ({ c: s.concept, sim: cosine(s.t, pv[k]) })).sort((a, b) => b.sim - a.sim);
  const byL = segs.map((s) => ({ c: s.concept, sim: cosine(s.l, pv[k]) })).sort((a, b) => b.sim - a.sim);
  console.log(`${PROBES[k]}`);
  console.log(`  transcript  top1 ${byT[0].sim.toFixed(3)}  spread(1-20) ${(byT[0].sim - byT[19].sim).toFixed(3)}`);
  console.log(`      1. ${byT[0].c.slice(0, 52)}`);
  console.log(`      3. ${byT[2].c.slice(0, 52)}`);
  console.log(`  label       top1 ${byL[0].sim.toFixed(3)}  spread(1-20) ${(byL[0].sim - byL[19].sim).toFixed(3)}`);
  console.log(`      1. ${byL[0].c.slice(0, 52)}`);
  console.log(`      3. ${byL[2].c.slice(0, 52)}`);
  console.log();
}
