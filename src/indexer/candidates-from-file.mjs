// Step 1, file-driven: search YouTube for a hand-written list of subtopics and
// queries, and write the candidates to the store. No model calls at all, so
// this costs nothing. Use it to widen the domain without re-planning it.
//
//   node src/indexer/candidates-from-file.mjs src/indexer/expansions/2026-10-ai-wide.json
//
// Then screen the candidates, then `npm run index:run -- --limit 50`.

import fs from 'node:fs';
import { search } from '../lib/youtube.mjs';
import { open, upsertDomain, upsertSubtopic, addCandidate } from '../lib/store.mjs';

const DOMAIN = 'ai';
const LABEL = 'AI and LLMs';
const TAKE_PER_QUERY = 12;
const CAP_PER_SUBTOPIC = 30;   // same cap as the first round

const file = process.argv[2];
if (!file) {
  console.error('usage: node src/indexer/candidates-from-file.mjs <expansion.json>');
  process.exit(1);
}
const { groups } = JSON.parse(fs.readFileSync(file, 'utf8'));

const db = open();
upsertDomain(db, DOMAIN, LABEL);
const already = new Set(db.prepare('SELECT id FROM videos').all().map((r) => r.id));

console.log(`${groups.length} subtopics from ${file}. searching (free, takes a few minutes)...\n`);

let added = 0, seen = 0;
for (const g of groups) {
  upsertSubtopic(db, DOMAIN, g.subtopic, g.queries);
  const forThis = new Map();
  for (const q of g.queries) {
    try {
      for (const v of await search(q, TAKE_PER_QUERY)) {
        seen++;
        if (!forThis.has(v.id)) forThis.set(v.id, v);
      }
    } catch (e) {
      console.log(`  search failed for "${q}": ${String(e.message).slice(0, 60)}`);
    }
  }
  const take = [...forThis.values()].sort((a, b) => b.views - a.views).slice(0, CAP_PER_SUBTOPIC);
  let fresh = 0;
  for (const v of take) {
    if (already.has(v.id)) continue;
    addCandidate(db, DOMAIN, v, g.subtopic);
    already.add(v.id);
    added++; fresh++;
  }
  console.log(`  ${g.subtopic.padEnd(52)} ${String(take.length).padStart(3)} kept, ${String(fresh).padStart(3)} new`);
}

const pending = db.prepare(`SELECT COUNT(*) n FROM videos WHERE domain=? AND status='found'`).get(DOMAIN).n;
console.log(`\n${seen} search results seen, ${added} new candidates added, ${pending} pending in the store.`);
console.log(`next: screen the pending list, then npm run index:run -- --limit 50`);
