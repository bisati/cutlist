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
import { compilePlan } from '../query/plan.mjs';
import { loadIndex } from '../lib/load-index.mjs';
import { spentInr, BUDGET_INR, BudgetExceeded } from '../lib/spend.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4321;

const db = open();
let INDEX = loadIndex(db);
console.log(`index: ${INDEX.length} segments from ${new Set(INDEX.map((s) => s.channel)).size} channels`);

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
      const result = await compilePlan(INDEX, topic, budgetMin, (step, text) => send('stage', { step, of: 5, text }));
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
    // Same shape the deployed function returns, so one page serves both.
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      segments: INDEX.length,
      channels: new Set(INDEX.map((s) => s.channel)).size,
      hours: +(INDEX.reduce((a, s) => a + s.durationSec, 0) / 3600).toFixed(0),
      budgetLeft: +(BUDGET_INR - spentInr()).toFixed(2),
      open: spentInr() < BUDGET_INR,
      cached: 0,
    }));
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  http://localhost:${PORT}\n`);
});
