// What stands between a public endpoint and a drained API budget.
//
// Be clear about what this does and does not do. Serverless instances do not
// share memory, so every limit here is per instance, not global. That makes
// this a speed bump against casual abuse, not a guarantee.
//
// The guarantee has to come from outside the app: a hard budget cap on the
// Google Cloud project that owns the API key. That is the only control that
// cannot be routed around by hitting a different instance. See DEPLOY.md.
//
// In rough order of how much each actually helps:
//
//   1. The plan cache. Identical requests are free after the first, and a loop
//      on one query is the cheapest kind of abuse to absorb.
//   2. The kill switch. One env var turns the endpoint off without a redeploy.
//   3. The daily ceiling. Per instance, so leaky, but it bounds one instance.
//   4. The per-IP limiter. Stops a naive script from one address.

const DAY_MS = 86400000;

export const CONFIG = {
  enabled: process.env.LC_DISABLED !== '1',
  dailyCapInr: Number(process.env.LC_DAILY_CAP_INR || 60),
  perIpPerHour: Number(process.env.LC_PER_IP_HOUR || 8),
  perIpPerDay: Number(process.env.LC_PER_IP_DAY || 25),
  cacheMax: 400,
};

const spentToday = { day: Math.floor(Date.now() / DAY_MS), inr: 0 };
const hits = new Map();       // ip -> timestamps
const cache = new Map();      // key -> { at, result }

function rollDay() {
  const d = Math.floor(Date.now() / DAY_MS);
  if (d !== spentToday.day) { spentToday.day = d; spentToday.inr = 0; hits.clear(); }
}

export function noteSpend(inr) { rollDay(); spentToday.inr += inr; }
export function spentTodayInr() { rollDay(); return spentToday.inr; }

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : (fwd || '')).split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
}

/** Returns null when allowed, or a reason to refuse. */
export function check(req) {
  rollDay();

  if (!CONFIG.enabled) {
    return { status: 503, message: 'This is switched off right now. Try again later.' };
  }
  if (spentToday.inr >= CONFIG.dailyCapInr) {
    return {
      status: 429,
      message: 'This has hit its daily API budget. It resets at midnight UTC. ' +
               'It is a personal project on a capped key, not a service.',
    };
  }

  const ip = clientIp(req);
  const now = Date.now();
  const seen = (hits.get(ip) || []).filter((t) => now - t < DAY_MS);
  const lastHour = seen.filter((t) => now - t < 3600000).length;

  if (seen.length >= CONFIG.perIpPerDay) {
    return { status: 429, message: `That is ${CONFIG.perIpPerDay} plans today, which is the limit from one address. Try tomorrow.` };
  }
  if (lastHour >= CONFIG.perIpPerHour) {
    return { status: 429, message: `That is ${CONFIG.perIpPerHour} plans this hour, which is the limit. Try again shortly.` };
  }

  seen.push(now);
  hits.set(ip, seen);
  return null;
}

// ------------------------------------------------------------------- caching

export const cacheKey = (topic, minutes) =>
  `${minutes}|${topic.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim()}`;

export function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // Refresh position so the map stays roughly least-recently-used.
  cache.delete(key); cache.set(key, hit);
  return hit.result;
}

export function cachePut(key, result) {
  cache.set(key, { at: Date.now(), result });
  while (cache.size > CONFIG.cacheMax) cache.delete(cache.keys().next().value);
}

export const cacheSize = () => cache.size;
