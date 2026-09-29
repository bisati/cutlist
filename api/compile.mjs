// POST-free streaming endpoint. Same pipeline as the local server, same page.
//
// Server-sent events because a compile takes about twelve seconds, and twelve
// silent seconds reads as broken.

import { loadBundle } from './lib/bundle.mjs';
import { compilePlan, STAGE_COUNT } from '../src/query/plan.mjs';
import { spentInr, BudgetExceeded } from '../src/lib/spend.mjs';
import { check, noteSpend, cacheKey, cacheGet, cachePut, spentTodayInr, CONFIG } from './lib/guard.mjs';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const topic = (url.searchParams.get('topic') || '').trim().slice(0, 300);
  const budgetMin = Math.min(180, Math.max(15, parseInt(url.searchParams.get('minutes') || '120', 10)));

  if (topic.length < 3) {
    res.statusCode = 400;
    return res.end('Say what you want to understand.');
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // A cached plan costs nothing and skips the limiter, so hammering one query
  // is the cheapest form of abuse rather than the most expensive.
  const key = cacheKey(topic, budgetMin);
  const cached = cacheGet(key);
  if (cached) {
    send('stage', { step: STAGE_COUNT, of: STAGE_COUNT, text: 'Found this one already compiled', kind: 'cache' });
    send('done', { ...cached, cached: true, costInr: 0 });
    return res.end();
  }

  const refused = check(req);
  if (refused) {
    send('error', { message: refused.message, limited: true });
    return res.end();
  }

  const t0 = Date.now();
  const before = spentInr();
  try {
    const { index } = loadBundle();
    const result = await compilePlan(index, topic, budgetMin,
      (step, text, kind) => send('stage', { step, of: STAGE_COUNT, text, kind }));

    const cost = +(spentInr() - before).toFixed(3);
    noteSpend(cost);
    const payload = { ...result, seconds: +((Date.now() - t0) / 1000).toFixed(1), costInr: cost };
    cachePut(key, payload);
    send('done', payload);
  } catch (e) {
    noteSpend(+(spentInr() - before).toFixed(3));
    send('error', {
      message: e instanceof BudgetExceeded
        ? 'This has hit its API budget. It is a personal project on a capped key, not a service.'
        : String(e.message).slice(0, 300),
      budget: e instanceof BudgetExceeded,
    });
  }
  res.end();
}
