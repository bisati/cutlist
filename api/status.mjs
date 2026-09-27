// What the page shows in its header and footer. Cheap, cacheable, no models.

import { loadBundle } from './lib/bundle.mjs';
import { hasKey } from '../src/lib/gemini.mjs';
import { spentTodayInr, CONFIG, cacheSize } from './lib/guard.mjs';

export default function handler(req, res) {
  const { manifest } = loadBundle();
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'public, max-age=60, s-maxage=300',
  });
  res.end(JSON.stringify({
    segments: manifest.count,
    channels: manifest.channels,
    hours: manifest.hours,
    indexedAt: manifest.builtAt,
    // Surfaced so the page can say the budget is gone before someone waits
    // twelve seconds to be told the same thing.
    budgetLeft: Math.max(0, +(CONFIG.dailyCapInr - spentTodayInr()).toFixed(2)),
    open: CONFIG.enabled && hasKey() && spentTodayInr() < CONFIG.dailyCapInr,
    // Distinguishes "no key configured" from "budget used up", so the page can
    // say which, instead of both looking like the same failure.
    reason: !hasKey() ? 'no-key' : !CONFIG.enabled ? 'disabled'
          : spentTodayInr() >= CONFIG.dailyCapInr ? 'budget' : null,
    cached: cacheSize(),
  }));
}
