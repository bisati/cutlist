// Local web server for the learning compiler.
//
//   npm run web        real compiles, spends money on the API
//   npm run web:demo   canned plan, no index, no API calls, free
//
// Plain Node, no framework and no build step, because this is the version
// tested locally and the fastest thing to start is the right thing to start.
// The page it serves is public/index.html, the same file the deployed function
// serves, so there is one copy of the front end and not two.
//
// Compiling takes about twelve seconds, so progress is streamed over
// server-sent events. Twelve silent seconds reads as broken; twelve seconds
// with the stages named reads as work being done.
//
// Demo mode exists so the interface can be worked on, shown and screenshotted
// without touching a metered API key. It replays one real plan captured from an
// eval run, with delays roughly matching where the real time goes.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePlan, STAGES, STAGE_COUNT } from '../query/plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '../../public');
const PORT = process.env.PORT || 4321;
const DEMO = process.argv.includes('--demo') || process.env.LC_DEMO === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only reached in real mode, so demo mode needs neither the database nor the
// index nor a key.
let INDEX = [];
let realDeps = null;
if (!DEMO) {
  const [{ open }, { loadIndex }, spend] = await Promise.all([
    import('../lib/store.mjs'), import('../lib/load-index.mjs'), import('../lib/spend.mjs'),
  ]);
  realDeps = spend;
  INDEX = loadIndex(open());
  console.log(`index: ${INDEX.length} segments from ${new Set(INDEX.map((s) => s.channel)).size} channels`);
} else {
  console.log('demo mode: canned plan, no index loaded, no API calls, nothing spent');
}

const demoPlan = () => JSON.parse(fs.readFileSync(path.join(HERE, 'demo-plan.json'), 'utf8'));

// Where the real time goes, so the stage strip in demo mode moves the way it
// does in production instead of flashing through.
const DEMO_MS = { 1: 1300, 2: 140, 3: 70, 4: 90, 5: 110, 6: 2600, 7: 900 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, file, status = 200) {
  try {
    const body = fs.readFileSync(file);
    res.writeHead(status, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    return res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, path.join(PUBLIC, 'index.html'));
  }

  if (url.pathname === '/api/compile') {
    const topic = (url.searchParams.get('topic') || '').trim().slice(0, 300);
    const budgetMin = Math.min(240, Math.max(15, parseInt(url.searchParams.get('minutes') || '120', 10)));
    if (!topic) { res.writeHead(400); return res.end('topic required'); }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (DEMO) {
      const canned = demoPlan();
      for (const s of STAGES) {
        send('stage', { step: s.n, of: STAGE_COUNT, text: s.label, kind: s.kind });
        await sleep(DEMO_MS[s.n] || 200);
      }
      // Echo back what was asked for, so the budget chips and the typed topic
      // visibly drive the result even though the segments are canned.
      send('done', { ...canned, topic, budgetMin, demo: true });
      return res.end();
    }

    const { spentInr, BudgetExceeded } = realDeps;
    const t0 = Date.now();
    const before = spentInr();
    try {
      const result = await compilePlan(INDEX, topic, budgetMin,
        (step, text, kind) => send('stage', { step, of: STAGE_COUNT, text, kind }));
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
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    if (DEMO) {
      const c = demoPlan();
      return res.end(JSON.stringify({
        segments: c.stats.indexed, channels: 514, hours: 202,
        budgetLeft: null, open: true, cached: 1, demo: true,
      }));
    }
    const { spentInr, BUDGET_INR } = realDeps;
    return res.end(JSON.stringify({
      segments: INDEX.length,
      channels: new Set(INDEX.map((s) => s.channel)).size,
      hours: +(INDEX.reduce((a, s) => a + s.durationSec, 0) / 3600).toFixed(0),
      budgetLeft: +(BUDGET_INR - spentInr()).toFixed(2),
      open: spentInr() < BUDGET_INR,
      cached: 0,
    }));
  }

  // Anything else: a static file out of public/, or the 404 page. Paths are
  // resolved and checked to stay inside public/ so a crafted URL cannot walk
  // up out of it.
  const asked = path.resolve(PUBLIC, '.' + url.pathname);
  if (asked.startsWith(PUBLIC + path.sep) && fs.existsSync(asked) && fs.statSync(asked).isFile()) {
    return serveFile(res, asked);
  }
  return serveFile(res, path.join(PUBLIC, '404.html'), 404);
});

server.listen(PORT, () => {
  console.log(`\n  http://localhost:${PORT}${DEMO ? '   (demo)' : ''}\n`);
});
