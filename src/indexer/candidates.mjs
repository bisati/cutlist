// Step 1 of indexing: decide what the domain is made of, search for it, and
// write the candidate list to the store. Nothing is extracted or embedded here.
//
// Almost free: two model calls total, then YouTube search, which is keyless and
// unmetered. Run this first and look at what it found before paying to index it.

import { gen } from '../lib/gemini.mjs';
import { search } from '../lib/youtube.mjs';
import { open, upsertDomain, upsertSubtopic, addCandidate } from '../lib/store.mjs';
import { spentInr } from '../lib/spend.mjs';

const DOMAIN = 'ai';
const LABEL = 'AI and LLMs';
const N_SUBTOPICS = 30;
const QUERIES_EACH = 5;
const TAKE_PER_QUERY = 12;
const CAP_PER_SUBTOPIC = 30;   // keeps one popular area from swamping the index
const CHEAP = 'gemini-3.1-flash-lite';

const SUBTOPIC_SCHEMA = {
  type: 'object',
  properties: { subtopics: { type: 'array', items: { type: 'string' } } },
  required: ['subtopics'],
};
const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subtopic: { type: 'string' },
          queries: { type: 'array', items: { type: 'string' } },
        },
        required: ['subtopic', 'queries'],
      },
    },
  },
  required: ['groups'],
};

const db = open();
upsertDomain(db, DOMAIN, LABEL);

console.log(`planning the "${LABEL}" domain...`);

const { data: st } = await gen(CHEAP, `Someone wants to genuinely understand modern AI and large language models, from the ground up through to how they are built with and where they fail.

List the ${N_SUBTOPICS} sub-areas that between them cover this domain. Each one should be something a person would actually sit down and try to learn as a unit.

Span the whole range: the foundations underneath it, how the models work internally, how people build things on top of them, how they are evaluated, and the criticisms and failure modes. Do not list ${N_SUBTOPICS} variations on the same three ideas.

Short names, three to six words each.`, { label: 'index: plan domain subtopics', schema: SUBTOPIC_SCHEMA });

const subtopics = st.subtopics.slice(0, N_SUBTOPICS);
console.log(`${subtopics.length} subtopics:\n  ${subtopics.join('\n  ')}\n`);

const { data: qs } = await gen(CHEAP, `For each sub-area below, write ${QUERIES_EACH} YouTube search queries that between them would surface the best explanatory videos on it.

Vary the angle across the ${QUERIES_EACH}: the beginner framing, the mechanism underneath, a hands-on or coded walkthrough, the criticisms or limitations, and a comparison against the obvious alternative.

Write them the way a person types into YouTube, not as formal questions. Include the sub-area's own vocabulary so the search actually lands.

SUB-AREAS:
${subtopics.map((s, i) => `${i + 1}. ${s}`).join('\n')}`, { label: 'index: write seed queries', schema: QUERY_SCHEMA });

const groups = qs.groups.filter((g) => g.queries?.length);
console.log(`queries written for ${groups.length} subtopics. searching (free, takes a few minutes)...\n`);

let added = 0, seen = 0;
const already = new Set(db.prepare('SELECT id FROM videos').all().map((r) => r.id));

for (const g of groups) {
  upsertSubtopic(db, DOMAIN, g.subtopic, g.queries);
  const forThis = new Map();
  for (const q of g.queries.slice(0, QUERIES_EACH)) {
    try {
      for (const v of await search(q, TAKE_PER_QUERY)) {
        seen++;
        if (!forThis.has(v.id)) forThis.set(v.id, v);
      }
    } catch (e) {
      console.log(`  search failed for "${q}": ${String(e.message).slice(0, 60)}`);
    }
  }
  // Cap per subtopic, best-viewed first, so no single area dominates.
  const take = [...forThis.values()].sort((a, b) => b.views - a.views).slice(0, CAP_PER_SUBTOPIC);
  let fresh = 0;
  for (const v of take) {
    if (already.has(v.id)) continue;
    addCandidate(db, DOMAIN, v, g.subtopic);
    already.add(v.id);
    added++; fresh++;
  }
  console.log(`  ${g.subtopic.padEnd(42)} ${String(take.length).padStart(3)} kept, ${String(fresh).padStart(3)} new`);
}

const total = db.prepare(`SELECT COUNT(*) n FROM videos WHERE domain=?`).get(DOMAIN).n;
const hours = db.prepare(`SELECT COALESCE(SUM(duration_sec),0)/3600.0 h FROM videos WHERE domain=?`).get(DOMAIN).h;

console.log(`\n${seen} search results seen, ${added} new candidates added, ${total} in the store.`);
console.log(`${hours.toFixed(0)} hours of source video. Indexing all of it would cost about Rs ${(total * 0.2).toFixed(0)}.`);
console.log(`spent so far: Rs ${spentInr().toFixed(2)}`);
console.log(`\nnext: npm run index:run -- --limit 50   (check the shape before committing to the rest)`);
