// Persistent spend ledger with a hard cap.
//
// An early build overran its cost estimate by five times, and the reason it was
// not caught in flight is that nothing kept a running total across runs. Every
// process started its count at zero. This file fixes that: the ledger is on
// disk, append-only, and survives everything.
//
// Set your own ceiling with LC_BUDGET_INR. The cap is enforced, not advisory:
// it throws rather than warns, because a limit you can ignore is not a limit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEDGER = path.join(ROOT, 'data/spend.jsonl');

export const BUDGET_INR = Number(process.env.LC_BUDGET_INR) || 800;
export const USD_INR = 90;
const WARN_AT = 0.75;

// USD per 1M tokens, paid tier, read off ai.google.dev/gemini-api/docs/pricing
// on 2026-09-26. Hand-transcribed, so this is the one number here that is not
// measured. `npm run spend` recomputes every total if these change.
export const RATES = {
  'gemini-3.1-flash-lite':  { in: 0.25, out: 1.50 },
  'gemini-3.5-flash-lite':  { in: 0.30, out: 2.50 },
  'gemini-3.5-flash':       { in: 1.50, out: 9.00 },
  // Promotional. Doubles to 1.50 / 7.50 on 2027-01-01.
  'gemini-3.8-flash':       { in: 0.75, out: 3.75 },
  'gemini-3.1-pro-preview': { in: 2.00, out: 12.00 },
  'gemini-embedding-2':     { in: 0.20, out: 0 },
  'gemini-embedding-001':   { in: 0.15, out: 0 },
};

/**
 * Cost of one call in USD.
 * Thinking tokens bill at the OUTPUT rate and Gemini reports them outside
 * candidatesTokenCount. Forgetting to add them understates a reasoning model by
 * roughly seven times, which is exactly what happened on an early run.
 */
export function usdFor(model, { promptTokenCount = 0, candidatesTokenCount = 0, thoughtsTokenCount = 0 } = {}) {
  const r = RATES[model];
  if (!r) throw new Error(`no rate on file for ${model}. Add it to RATES before calling it.`);
  return (promptTokenCount / 1e6) * r.in + ((candidatesTokenCount + thoughtsTokenCount) / 1e6) * r.out;
}

// Serverless has no writable disk and no shared state between instances, so the
// ledger degrades to memory there. That is weaker on purpose and honestly so:
// a per-instance counter is not a global cap. The real ceiling for the deployed
// app is a budget cap set on the Google Cloud project itself, plus the per-IP
// limiter and the plan cache in api/lib/guard.mjs.
export const EPHEMERAL = !!process.env.VERCEL || process.env.LC_EPHEMERAL_LEDGER === '1';

let cached = null;

function readAll() {
  if (cached) return cached;
  if (EPHEMERAL || !fs.existsSync(LEDGER)) return (cached = []);
  cached = fs.readFileSync(LEDGER, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  return cached;
}

export function spentUsd() {
  return readAll().reduce((a, e) => a + (e.usd || 0), 0);
}
export const spentInr = () => spentUsd() * USD_INR;
export const remainingInr = () => BUDGET_INR - spentInr();

/** Record one call. `label` is what the money was for, in plain words. */
export function record({ model, label, usage, ms = 0, note = '' }) {
  const usd = usdFor(model, usage);
  const entry = {
    at: new Date().toISOString(),
    model,
    label,
    in: usage?.promptTokenCount || 0,
    out: usage?.candidatesTokenCount || 0,
    thought: usage?.thoughtsTokenCount || 0,
    ms,
    usd: +usd.toFixed(6),
    inr: +(usd * USD_INR).toFixed(4),
    ...(note ? { note } : {}),
  };
  if (!EPHEMERAL) {
    try {
      fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
      fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n');
    } catch { /* read-only filesystem: the in-memory total below still holds */ }
  }
  readAll().push(entry);
  return entry;
}

export class BudgetExceeded extends Error {}

/**
 * Called before every API call. Throws rather than warns: a soft limit is not a
 * limit. `estimateInr` lets a caller about to start a big batch check up front
 * instead of discovering the wall halfway through.
 */
export function assertBudget(label = '', estimateInr = 0) {
  const spent = spentInr();
  if (spent + estimateInr > BUDGET_INR) {
    throw new BudgetExceeded(
      `Budget stop. Rs ${spent.toFixed(2)} of Rs ${BUDGET_INR} already spent` +
      (estimateInr ? `, and "${label}" is estimated at Rs ${estimateInr.toFixed(2)} more.` : ` (blocked: ${label}).`) +
      ` Raise it with LC_BUDGET_INR if that is a deliberate decision.`
    );
  }
  return spent;
}

let warned = false;
export function warnIfClose() {
  if (warned) return;
  const frac = spentInr() / BUDGET_INR;
  if (frac >= WARN_AT) {
    warned = true;
    console.warn(`\n  !! Rs ${spentInr().toFixed(2)} of Rs ${BUDGET_INR} spent (${Math.round(frac * 100)}%). Rs ${remainingInr().toFixed(2)} left.\n`);
  }
}

/** Grouped summary for the CLI and for end-of-run reporting. */
export function summary() {
  const all = readAll();
  const by = (key) => {
    const m = new Map();
    for (const e of all) {
      const k = e[key] || '(unlabelled)';
      const v = m.get(k) || { calls: 0, in: 0, out: 0, thought: 0, usd: 0 };
      v.calls++; v.in += e.in; v.out += e.out; v.thought += e.thought; v.usd += e.usd;
      m.set(k, v);
    }
    return [...m.entries()]
      .map(([k, v]) => ({ [key]: k, ...v, inr: +(v.usd * USD_INR).toFixed(2) }))
      .sort((a, b) => b.usd - a.usd);
  };
  return {
    calls: all.length,
    usd: spentUsd(),
    inr: spentInr(),
    remaining: remainingInr(),
    budget: BUDGET_INR,
    byModel: by('model'),
    byLabel: by('label'),
    first: all[0]?.at ?? null,
    last: all.at(-1)?.at ?? null,
  };
}
