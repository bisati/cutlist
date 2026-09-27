// Targeted top-up: let the eval tell the indexer what is missing.
//
// The first index was built by guessing at a domain and searching broadly. The
// eval then measured exactly which concepts came back uncovered, which is a far
// better shopping list than another round of guessing. This reads the latest
// eval results, collects every gap, writes searches aimed at those specific
// things, and adds what it finds as candidates.
//
//   node src/indexer/topup.mjs            use the newest eval result
//   node src/indexer/topup.mjs --dry      show the queries, search nothing
//
// Then `npm run index:run` pays to index them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gen } from '../lib/gemini.mjs';
import { search } from '../lib/youtube.mjs';
import { open, addCandidate, upsertSubtopic } from '../lib/store.mjs';
import { spentInr } from '../lib/spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RESULTS = path.join(ROOT, 'eval/results');
const DOMAIN = 'ai';
const CHEAP = 'gemini-3.1-flash-lite';
const QUERIES_PER_GAP = 4;
const TAKE_PER_QUERY = 10;
const dry = process.argv.includes('--dry');

const files = fs.readdirSync(RESULTS).filter((f) => f.endsWith('.json')).sort();
if (!files.length) { console.error('no eval results. run `node eval/run.mjs` first.'); process.exit(1); }
const latest = path.join(RESULTS, files.at(-1));
const { results } = JSON.parse(fs.readFileSync(latest, 'utf8'));
console.log(`reading ${path.basename(latest)}\n`);

// ---- collect the gaps -------------------------------------------------------

const gaps = new Map();   // gap text -> what it belongs to
const note = (text, topic, kind) => {
  if (!text) return;
  const k = text.trim();
  if (!gaps.has(k)) gaps.set(k, { text: k, topics: new Set(), kinds: new Set() });
  gaps.get(k).topics.add(topic);
  gaps.get(k).kinds.add(kind);
};

for (const r of results) {
  if (!r.ok) continue;
  for (const m of r.missing || []) note(m, r.topic, 'concept uncovered');
  for (const c of r.conceptsWithNoMatch || []) note(c, r.topic, 'nothing above the floor');
  for (const m of r.mustCover || []) if (!m.met) note(m.phrase, r.topic, 'must-cover unmet');
}

const list = [...gaps.values()].sort((a, b) => b.topics.size - a.topics.size);
console.log(`${list.length} distinct gaps across ${new Set(results.map((r) => r.topic)).size} topics:\n`);
for (const g of list) {
  console.log(`  ${g.text}`);
  console.log(`      ${[...g.kinds].join(', ')}  |  wanted by: ${[...g.topics].join('; ').slice(0, 90)}`);
}

if (!list.length) { console.log('\nnothing missing. index is covering the golden set.'); process.exit(0); }

// ---- write searches aimed at exactly those gaps -----------------------------

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          gap: { type: 'string' },
          queries: { type: 'array', items: { type: 'string' } },
        },
        required: ['gap', 'queries'],
      },
    },
  },
  required: ['groups'],
};

const { data } = await gen(CHEAP, `Each line below is something a learning index is MISSING. For each, write ${QUERIES_PER_GAP} YouTube searches likely to surface a video that explains that specific thing well.

These gaps were found by measurement, so the obvious searches have already been tried and did not surface it. Go narrower and more specific than you otherwise would:

- use the exact technical vocabulary practitioners use for it
- prefer searches that would surface a hands-on walkthrough or a demo, because the index is thinnest on those
- one of the four should be phrased as the question a confused person types
- do not write generic searches about the wider subject. "AI agents explained" is what already failed

MISSING:
${list.map((g, i) => `${i + 1}. ${g.text}`).join('\n')}`, { label: 'topup: write targeted queries', schema: QUERY_SCHEMA });

const groups = data.groups.filter((g) => g.queries?.length);
console.log(`\nwrote ${groups.reduce((a, g) => a + g.queries.length, 0)} searches for ${groups.length} gaps`);

if (dry) {
  for (const g of groups) console.log(`\n${g.gap}\n  ${g.queries.join('\n  ')}`);
  process.exit(0);
}

// ---- search and add ---------------------------------------------------------

const db = open();
const already = new Set(db.prepare('SELECT id FROM videos').all().map((r) => r.id));
console.log(`\nsearching (free)...\n`);

let added = 0;
for (const g of groups) {
  const subtopic = `gap: ${g.gap}`.slice(0, 90);
  upsertSubtopic(db, DOMAIN, subtopic, g.queries);
  const found = new Map();
  for (const q of g.queries.slice(0, QUERIES_PER_GAP)) {
    try { for (const v of await search(q, TAKE_PER_QUERY)) if (!found.has(v.id)) found.set(v.id, v); }
    catch (e) { console.log(`  search failed: ${String(e.message).slice(0, 50)}`); }
  }
  let fresh = 0;
  for (const v of [...found.values()].sort((a, b) => b.views - a.views)) {
    if (already.has(v.id)) continue;
    addCandidate(db, DOMAIN, v, subtopic);
    already.add(v.id);
    added++; fresh++;
  }
  console.log(`  ${String(fresh).padStart(3)} new  ${g.gap.slice(0, 64)}`);
}

const pending = db.prepare(`SELECT COUNT(*) n FROM videos WHERE domain=? AND status='found'`).get(DOMAIN).n;
console.log(`\n${added} new candidates, ${pending} pending in total.`);
console.log(`estimated Rs ${(pending * 0.21).toFixed(0)} to index them.`);
console.log(`spent so far: Rs ${spentInr().toFixed(2)}`);
console.log(`\nnext: npm run index:run`);
