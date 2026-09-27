// A/B the extraction prompt on the same videos before spending on a full index.
//
// An early pass indexed 157 videos with a prompt that turned out to be biased,
// and the bias only surfaced after the money was spent. Rs 11 here protects the
// Rs 120 index run. Same videos, same model, both prompts.

import { search, transcriptsFor } from '../lib/youtube.mjs';
import { extractSegments } from '../lib/extract.mjs';
import { spentInr, summary } from '../lib/spend.mjs';

const QUERIES = [
  'how RAG works explained',
  'transformer architecture explained',
  'fine tuning LLM tutorial',
  'ai agents tool use explained',
  'vector embeddings explained',
  'llm evaluation and benchmarks',
];
const PER_QUERY = 6;

console.log('gathering videos (free)...');
const found = new Map();
for (const q of QUERIES) {
  for (const v of await search(q, PER_QUERY)) if (!found.has(v.id)) found.set(v.id, v);
}
const vids = await transcriptsFor([...found.values()], 20);
console.log(`${vids.length} usable videos (dropped ${vids.dropped.notEnglish} non-English, ${vids.dropped.noCaptions} no captions)\n`);

const before = spentInr();

async function run(version) {
  const t0 = Date.now();
  const out = (await Promise.all(vids.map(async (v) => {
    try { return (await extractSegments(v, { version, label: `tune extraction prompt ${version}` })).map((s) => ({ ...s, video: v })); }
    catch { return []; }
  }))).flat();
  return { version, segs: out, ms: Date.now() - t0 };
}

const results = [];
for (const version of ['v1', 'v2']) {
  const r = await run(version);
  results.push(r);
  console.log(`${version}: ${r.segs.length} segments in ${(r.ms / 1000).toFixed(0)}s`);
}

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// How many segments are contiguous with a neighbour from the same video. This
// is the chopping metric: lower means the prompt kept explanations whole.
function chopped(segs) {
  const byVid = {};
  for (const s of segs) (byVid[s.videoId] ||= []).push(s);
  let n = 0;
  for (const g of Object.values(byVid)) {
    g.sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < g.length; i++) {
      const gap = g[i].startSec - g[i - 1].endSec;
      if (gap >= -1 && gap <= 30) n++;
    }
  }
  return n;
}

console.log('\n');
console.table(results.map((r) => {
  const d = r.segs.map((s) => s.durationSec);
  const mix = r.segs.reduce((a, s) => ((a[s.depth] = (a[s.depth] || 0) + 1), a), {});
  const total = r.segs.length || 1;
  const pct = (k) => `${Math.round((100 * (mix[k] || 0)) / total)}%`;
  return {
    prompt: r.version,
    segments: r.segs.length,
    'per video': +(r.segs.length / vids.length).toFixed(1),
    'median sec': med(d),
    'total min': Math.round(d.reduce((a, b) => a + b, 0) / 60),
    intro: pct('intro'),
    mechanism: pct('mechanism'),
    example: pct('example'),
    debate: pct('debate'),
    'chopped pairs': chopped(r.segs),
  };
}));

console.log(`\nspent on this comparison: Rs ${(spentInr() - before).toFixed(2)}   |   project total: Rs ${spentInr().toFixed(2)} of Rs ${summary().budget}`);

// A few v2 segments to read, since the numbers cannot tell you if the labels
// are honest or if `teaches` is any good.
console.log('\nsample of v2 output:');
for (const s of results[1].segs.slice(0, 8)) {
  console.log(`  ${String(Math.round(s.durationSec / 60)).padStart(2)}min [${s.depth.padEnd(9)}] ${s.concept}`);
  console.log(`         ${s.teaches}`);
}
