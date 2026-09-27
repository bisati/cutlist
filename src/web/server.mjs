// Local web server for the learning compiler.
//
//   npm run web      then open http://localhost:4321
//
// Plain Node, no framework and no build step, because this is the version
// Mihir tests locally and the fastest thing to start is the right thing to
// start. The Vercel build is deploy-time work and needs the index moved to
// Postgres anyway, since a 30MB SQLite file does not belong in a serverless
// function.
//
// Compiling takes about twelve seconds, so progress is streamed over
// server-sent events. Twelve silent seconds reads as broken; twelve seconds
// with the stages named reads as work being done.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from '../lib/store.mjs';
import { conceptMap, loadIndex, retrieve, dedupe, score, pack, order, verify } from '../query/pipeline.mjs';
import { spentInr, BUDGET_INR, BudgetExceeded } from '../lib/spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;

const db = open();
let INDEX = loadIndex(db);
console.log(`index: ${INDEX.length} segments from ${new Set(INDEX.map((s) => s.channel)).size} channels`);

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

async function compile(topic, budgetMin, send) {
  send('stage', { step: 1, of: 5, text: 'Working out what you need to understand' });
  const concepts = await conceptMap(topic, budgetMin);
  send('concepts', { concepts: concepts.map((c) => ({ name: c.name, why: c.why })) });

  send('stage', { step: 2, of: 5, text: `Searching ${INDEX.length.toLocaleString()} indexed segments` });
  const candidates = await retrieve(INDEX, concepts);
  score(candidates);

  send('stage', { step: 3, of: 5, text: `Removing repeats from ${candidates.length} candidates` });
  const clusters = dedupe(candidates, 0.88);

  send('stage', { step: 4, of: 5, text: `Packing ${budgetMin} minutes` });
  const packed = pack(clusters, concepts, budgetMin);
  if (!packed.chosen.length) throw new Error('Nothing in the index matched that closely enough.');

  send('stage', { step: 5, of: 5, text: 'Putting it in teaching order' });
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (url.pathname === '/api/compile') {
    const topic = (url.searchParams.get('topic') || '').trim().slice(0, 300);
    const budgetMin = Math.min(240, Math.max(15, parseInt(url.searchParams.get('minutes') || '120', 10)));
    if (!topic) { res.writeHead(400); return res.end('topic required'); }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const t0 = Date.now();
    const before = spentInr();
    try {
      const result = await compile(topic, budgetMin, send);
      send('done', {
        ...result,
        seconds: +((Date.now() - t0) / 1000).toFixed(1),
        costInr: +(spentInr() - before).toFixed(3),
      });
    } catch (e) {
      const budgetHit = e instanceof BudgetExceeded;
      send('error', {
        message: budgetHit
          ? 'The API budget for this project is used up, so nothing further can be compiled.'
          : String(e.message).slice(0, 300),
        budget: budgetHit,
      });
    }
    return res.end();
  }

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      segments: INDEX.length,
      channels: new Set(INDEX.map((s) => s.channel)).size,
      hours: +(INDEX.reduce((a, s) => a + s.durationSec, 0) / 3600).toFixed(0),
      spentInr: +spentInr().toFixed(2),
      budgetInr: BUDGET_INR,
    }));
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  http://localhost:${PORT}\n`);
});
